import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { documentPath } from "./files.js";
import { restorable, restoreDeadline } from "./recycle.js";
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

// User deletion first moves a link into the 30-day recycle bin. Physical
// cleanup only runs after every active/recoverable reference has been released.
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
      const recycled = await tx.query("invoices", "trashedAttachmentIds", documentId, 1);
      if (recycled.length) return { inUse: recycled[0].id };
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
    const result = await this.accounting.recycleAttachment(
      invoiceId,
      documentId,
      body,
      uid,
    );
    return {
      ...result,
      recycled: true,
      fileDeleted: false,
      restoreUntil: result.record.attachmentTrash?.find(p => p.id === documentId)?.restoreUntil || null,
    };
  }
  async protectedByRecycle(id) {
    const [attached, recycled] = await Promise.all([
      this.store.query("invoices", "attachmentIds", id, 250),
      this.store.query("invoices", "trashedAttachmentIds", id, 250),
    ]);
    return attached.some(i => restorable(i, this.now())) || recycled.some(i =>
      i.attachmentTrash?.some(p => p.id === id && this.now() < p.restoreUntil));
  }
  async purgeRecycle(limit) {
    const deleted = [], retained = [];
    let released = 0;
    for (let invoice of await this.accounting.all("invoices")) {
      const expiredIds = invoice.deletedAt && this.now() >= restoreDeadline(invoice)
        ? [...(invoice.attachmentIds || [])] : [];
      const trashIds = (invoice.attachmentTrash || []).filter(p => this.now() >= p.restoreUntil).map(p => p.id);
      for (const id of [...new Set([...expiredIds, ...trashIds])]) {
        if (released >= limit) return { deleted, retained, released };
        try {
          const body = { expectedVersion: invoice.version, mutationId: randomUUID() };
          const result = expiredIds.includes(id)
            ? await this.accounting.detachAttachment(invoice.id, id, body, "recycle-purge")
            : await this.accounting.recycleAttachment(invoice.id, id, body, "recycle-purge", "expire-attachment");
          invoice = result.record;
          released++;
          const file = await this.removeFile(id, "recycle-purge");
          if (file.deleted || file.gone) deleted.push(id);
        } catch (error) { retained.push({ id, reason: error.code || "ERROR" }); break; }
      }
    }
    return { deleted, retained, released };
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
        if (record.purgingAt || (stamp !== null && stamp <= cutoff)) found.push(record);
      }
      if (page.length < 250 || found.length >= limit) break;
      after = page.at(-1).id;
    }
    return found;
  }
  async purgeExpired({ uid = "document-purge", limit = this.batch } = {}) {
    const recycle = await this.purgeRecycle(limit);
    const cutoff = this.retentionDays ? this.now() - this.retentionDays * DAY : -Infinity;
    const found = await this.expired(cutoff, limit);
    const deleted = recycle.deleted, retained = recycle.retained;
    let released = recycle.released;
    for (const record of found.slice(0, limit)) {
      try {
        if (await this.protectedByRecycle(record.id)) { retained.push({ id: record.id, reason: "recycle-bin" }); continue; }
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
      cutoff: Number.isFinite(cutoff) ? cutoff : null,
      disabled: !this.retentionDays,
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
    if (this.running) return null;
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
