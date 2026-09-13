import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { documentPath } from "./files.js";
export const DAY = 24 * 60 * 60 * 1000;
export const PURGE_LOCK = "system/documentPurge";
// Transaction reads return native Firestore values; list/get outside one are
// already normalized to milliseconds.
const millis = (value) =>
  typeof value === "number"
    ? value
    : typeof value?.toMillis === "function"
      ? value.toMillis()
      : null;

// Deleting a photo means deleting the bytes, not hiding a row. The order is
// always: every invoice releases the file, then the record is marked, then the
// object is removed, then the record. An interrupted deletion therefore never
// leaves an invoice pointing at a file it cannot open, and whatever is left
// behind is picked up by the next sweep.
export class DocumentLifecycle {
  constructor({
    store,
    storage,
    accounting,
    retentionDays = 365,
    batch = 25,
    intervalMs = 12 * 60 * 60 * 1000,
    now = () => Date.now(),
  }) {
    Object.assign(this, {
      store,
      storage,
      accounting,
      retentionDays,
      batch,
      intervalMs,
      now,
      running: false,
      checkedAt: null,
    });
  }
  async releaseEverywhere(documentId, uid) {
    let released = 0;
    for (let round = 0; round < 5; round++) {
      const invoices = await this.store.query(
        "invoices",
        "attachmentIds",
        documentId,
        10,
      );
      if (!invoices.length) return released;
      for (const invoice of invoices) {
        await this.accounting.detachAttachment(
          invoice.id,
          documentId,
          { expectedVersion: invoice.version, mutationId: randomUUID() },
          uid,
        );
        released++;
      }
    }
    fail(
      409,
      "DOCUMENT_IN_USE",
      "הקובץ עדיין מצורף לחשבוניות. נסה שוב בעוד רגע.",
    );
  }
  // The mark is what makes the deletion safe to resume: a marked record is
  // treated as missing by load(), and an upload of the same bytes replaces it
  // with its own object instead of adopting the one being deleted.
  async removeFile(documentId, uid) {
    const marked = await this.store.transaction(async (tx) => {
      const key = "documents/" + documentId;
      const record = await tx.get(key);
      if (!record) return { gone: true };
      const used = await tx.query("invoices", "attachmentIds", documentId, 1);
      if (used.length) return { inUse: used[0].id };
      tx.set(key, { ...record, purgingAt: tx.stamp(), purgingBy: uid });
      return { path: documentPath(documentId, record) };
    });
    if (!marked.path) return marked;
    await this.storage.delete(marked.path);
    const deleted = await this.store.transaction(async (tx) => {
      const key = "documents/" + documentId;
      const record = await tx.get(key);
      // An upload during the deletion clears the mark and points the record at
      // an object of its own. That record is in use again and has to stay.
      if (!record?.purgingAt) return false;
      tx.delete(key);
      return true;
    });
    return deleted ? { deleted: true } : { replaced: true };
  }
  async deleteInvoiceDocument(invoiceId, documentId, body, uid) {
    const result = await this.accounting.detachAttachment(
      invoiceId,
      documentId,
      body,
      uid,
    );
    const file = await this.removeFile(documentId, uid);
    return {
      ...result,
      fileDeleted: Boolean(file.deleted || file.gone),
      stillUsedBy: file.inUse || null,
    };
  }
  // Age is counted from the last upload of these exact bytes, so a photo
  // attached to a second invoice is kept for a year from that day too.
  expiredAt(record) {
    return millis(record.uploadedAt) ?? millis(record.createdAt);
  }
  async expired(cutoff, limit) {
    const found = [];
    let after = "";
    for (;;) {
      const page = await this.store.list("documents", after, 250);
      for (const record of page) {
        const stamp = this.expiredAt(record);
        if (stamp !== null && stamp <= cutoff) found.push(record);
      }
      if (page.length < 250 || found.length >= limit) break;
      after = page.at(-1).id;
    }
    return found;
  }
  async purgeExpired({ uid = "document-purge", limit = this.batch } = {}) {
    if (!this.retentionDays)
      return { disabled: true, deleted: [], retained: [], released: 0 };
    const cutoff = this.now() - this.retentionDays * DAY;
    const found = await this.expired(cutoff, limit);
    const deleted = [],
      retained = [];
    let released = 0;
    for (const record of found.slice(0, limit)) {
      try {
        released += await this.releaseEverywhere(record.id, uid);
        const file = await this.removeFile(record.id, uid);
        if (file.deleted || file.gone) deleted.push(record.id);
        else retained.push({ id: record.id, reason: file.inUse ? "in-use" : "replaced" });
      } catch (error) {
        // One unreadable row must not stop the sweep. The file stays until the
        // next run, where it is still older than the retention period.
        retained.push({ id: record.id, reason: error.code || "ERROR" });
      }
    }
    return {
      cutoff,
      deleted,
      retained,
      released,
      remaining: Math.max(found.length - limit, 0),
    };
  }
  // Cloud Run has no scheduler of its own here. The sweep rides on the
  // authorized traffic the store already makes, at most once per interval
  // across every instance, and it runs after the answer was sent.
  async maybePurge() {
    if (!this.retentionDays || this.running) return null;
    // Sync runs on every screen. A throttled sweep costs this instance
    // nothing, and at most one cheap read once the instance is new.
    if (this.checkedAt !== null && this.now() - this.checkedAt < this.intervalMs)
      return null;
    this.checkedAt = this.now();
    const lock = await this.store.get(PURGE_LOCK);
    const lastStart = millis(lock?.startedAt);
    if (lastStart !== null && this.now() - lastStart < this.intervalMs) {
      this.checkedAt = lastStart;
      return null;
    }
    const claimed = await this.store.transaction(async (tx) => {
      const current = await tx.get(PURGE_LOCK);
      const startedAt = millis(current?.startedAt);
      if (startedAt !== null && this.now() - startedAt < this.intervalMs)
        return false;
      // The lock is internal bookkeeping, not a synced record: it holds the
      // same clock the interval is measured with, so the two cannot drift.
      tx.set(PURGE_LOCK, {
        ...current,
        id: "documentPurge",
        startedAt: this.now(),
      });
      return true;
    });
    if (!claimed) return null;
    this.running = true;
    try {
      const result = await this.purgeExpired();
      await this.store.transaction(async (tx) => {
        const current = await tx.get(PURGE_LOCK);
        tx.set(PURGE_LOCK, {
          ...current,
          id: "documentPurge",
          completedAt: this.now(),
          retentionDays: this.retentionDays,
          lastDeleted: result.deleted.length,
          lastRetained: result.retained.length,
          lastReleased: result.released,
          lastRemaining: result.remaining,
        });
      });
      return result;
    } finally {
      this.running = false;
    }
  }
}
