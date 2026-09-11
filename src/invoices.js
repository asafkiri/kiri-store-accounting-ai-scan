import { createHash } from "node:crypto";
import { fail } from "./errors.js";
import * as v from "./validation.js";
import { checkSupplierName, prepareInvoiceSupplier } from "./suppliers.js";
export const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
const claimKey = (i) =>
  "invoiceKeys/" +
  hash([
    i.supplierId,
    i.documentType,
    i.documentNumber.normalize("NFKC").replace(/\s/g, "").toLowerCase(),
  ]);
export class AccountingService {
  constructor(store, now = () => Date.now()) {
    this.store = store;
    this.now = now;
  }
  async all(collection) {
    const out = [];
    let after = "";
    for (;;) {
      const page = await this.store.list(collection, after, 250);
      out.push(...page);
      if (page.length < 250) break;
      after = page.at(-1).id;
    }
    return out;
  }
  async mutate({
    collection,
    id,
    expectedVersion,
    mutationId,
    uid,
    data,
    action = "save",
    supplierIntent = null,
  }) {
    v.id(id);
    v.id(mutationId);
    v.version(expectedVersion);
    const key = collection + "/" + id,
      receiptKey = "mutations/" + mutationId;
    const fingerprint = hash({
      key,
      expectedVersion,
      data,
      action,
      ...(supplierIntent ? { supplierIntent } : {}),
    });
    const reply = await this.store.transaction(async (tx) => {
      const receipt = await tx.get(receiptKey);
      if (receipt) {
        if (receipt.state === "cancelled") {
          if (receipt.entity !== key)
            fail(
              409,
              "IDEMPOTENCY_CONFLICT",
              "מזהה הבקשה כבר משויך לרשומה אחרת.",
            );
          fail(
            409,
            "MUTATION_CANCELLED",
            "ניסיון השמירה הזה בוטל. אפשר לערוך ולשמור מחדש.",
          );
        }
        if (receipt.fingerprint !== fingerprint)
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "בקשת השמירה השתנתה. יש לבדוק את הנתונים ולנסות מחדש.",
          );
        return {
          replayed: true,
          id,
          relatedPaths: receipt.relatedPaths || [],
          supplierAction: receipt.supplierAction || null,
        };
      }
      const previous = await tx.get(key);
      const dataVersion = await tx.get("system/dataVersion");
      if (
        (previous?.version || 0) !== expectedVersion ||
        (previous?.deletedAt && action !== "restore")
      )
        fail(
          409,
          "VERSION_CONFLICT",
          "הרשומה עודכנה מאז. הנתונים שהזנת נשמרו בטיוטה; יש לרענן ולבדוק לפני שמירה נוספת.",
        );
      if (action !== "save" && !previous)
        fail(404, "NOT_FOUND", "הרשומה לא נמצאה.");
      let next = {
        ...previous,
        ...data,
        id,
        version: expectedVersion + 1,
        updatedAt: tx.stamp(),
        updatedBy: uid,
      };
      if (!previous)
        Object.assign(next, {
          createdAt: tx.stamp(),
          createdBy: uid,
          deletedAt: null,
        });
      if (action === "delete") next.deletedAt = tx.stamp();
      if (action === "restore") next.deletedAt = null;
      let supplierChange = null;
      if (collection === "suppliers") {
        if (action === "delete") {
          // Removing a supplier never removes invoices or their documents.
          // The tombstone keeps the historical name and the sync identity.
          next.activeBeforeDeletion = previous.active;
          next.restoreUntil = this.now() + 30 * 24 * 60 * 60 * 1000;
          next.active = false;
        }
        if (action === "restore") {
          const deletedAt = previous.deletedAt?.toMillis?.() ?? previous.deletedAt;
          if (!deletedAt) fail(409, "NOT_DELETED", "הספק כבר נמצא ברשימת הספקים.");
          const deadline = previous.restoreUntil ?? (deletedAt + 30 * 24 * 60 * 60 * 1000);
          if (this.now() >= deadline)
            fail(410, "RESTORE_EXPIRED", "חלפו 30 ימים ממחיקת הספק ולא ניתן לשחזר אותו.");
          next.active = previous.activeBeforeDeletion ?? true;
          next.restoreUntil = null;
          next.activeBeforeDeletion = null;
        }
        await checkSupplierName(tx, next, previous);
      }
      if (collection === "invoices") {
        if (action === "save") {
          if (!["invoice", "credit"].includes(next.documentType) && previous?.documentType !== next.documentType)
            fail(400, "INVOICE_TYPE_REQUIRED", "כאן שומרים חשבוניות וחשבוניות זיכוי בלבד. אין לשמור תעודת משלוח או קבלה כחשבונית.");
          // Check after the receipt so retries of previously committed data still replay.
          v.creditAmounts(next);
          supplierChange = await prepareInvoiceSupplier(
            tx,
            next,
            previous,
            supplierIntent,
            uid,
          );
          for (const aid of next.attachmentIds)
            if (!(await tx.get("documents/" + aid)))
              fail(
                400,
                "ATTACHMENT_MISSING",
                "קובץ מצורף לא נמצא. יש להעלות אותו שוב.",
              );
          if (next.source === "ai") {
            const job = await tx.get("scanJobs/" + next.scanJobId);
            if (job?.status !== "completed" || job.purpose !== "invoice")
              fail(400, "REVIEW_REQUIRED", "תוצאת הסריקה אינה זמינה לבדיקה.");
          }
        }
        const newClaim = claimKey(next),
          oldClaim = previous ? claimKey(previous) : null;
        const occupied = await tx.get(newClaim);
        if (
          action !== "delete" &&
          occupied?.invoiceId &&
          occupied.invoiceId !== id
        )
          fail(
            409,
            "DUPLICATE_INVOICE",
            "כבר קיימת חשבונית עם המספר הזה אצל הספק. אפשר למצוא אותה בחיפוש.",
            { invoiceId: occupied.invoiceId },
          );
        if (!previous) {
          next.status = "unpaid";
          next.payment = null;
        }
        if (action === "pay") {
          next.status = "paid";
          next.payment = {
            ...data.payment,
            recordedAt: tx.stamp(),
            recordedBy: uid,
          };
        }
        if (action === "unpay") {
          next.status = "unpaid";
          next.payment = null;
        }
        // All transaction reads precede writes (Firestore requirement).
        if (oldClaim && oldClaim !== newClaim)
          tx.set(oldClaim, { id: oldClaim.split("/")[1], invoiceId: null });
        tx.set(newClaim, {
          id: newClaim.split("/")[1],
          invoiceId: action === "delete" ? null : id,
        });
      }
      const relatedPaths = supplierChange
        ? ["suppliers/" + supplierChange.record.id]
        : [];
      if (supplierChange) tx.set(relatedPaths[0], supplierChange.record);
      let sequence = dataVersion?.version || 0;
      for (const entity of [...relatedPaths, key]) {
        sequence++;
        const changeId = String(sequence).padStart(16, "0");
        tx.set("changes/" + changeId, {
          id: changeId,
          version: sequence,
          entity,
        });
      }
      tx.set("system/dataVersion", { id: "dataVersion", version: sequence });
      tx.set(key, next);
      tx.set(receiptKey, {
        id: mutationId,
        fingerprint,
        entity: key,
        action,
        at: tx.stamp(),
        by: uid,
        before: previous || null,
        ...(supplierChange
          ? {
              relatedPaths,
              supplierAction: supplierChange.action,
              supplierBefore: supplierChange.before,
            }
          : {}),
      });
      return {
        replayed: false,
        id,
        relatedPaths,
        supplierAction: supplierChange?.action || null,
      };
    });
    const { relatedPaths, supplierAction, ...result } = reply;
    return {
      ...result,
      record: await this.store.get(key),
      ...(relatedPaths.length
        ? {
            supplierAction,
            relatedRecords: await Promise.all(
              relatedPaths.map(async (path) => ({
                path,
                record: await this.store.get(path),
              })),
            ),
          }
        : {}),
    };
  }
  async saveSupplier(id, body, uid) {
    v.object(body, ["expectedVersion", "mutationId", "data"]);
    return this.mutate({
      collection: "suppliers",
      id,
      expectedVersion: body.expectedVersion,
      mutationId: body.mutationId,
      uid,
      data: v.supplier(body.data),
    });
  }
  async deleteSupplier(id, body, uid) {
    v.object(body, ["expectedVersion", "mutationId"]);
    return this.mutate({ collection: "suppliers", id, expectedVersion: body.expectedVersion,
      mutationId: body.mutationId, uid, action: "delete" });
  }
  async restoreSupplier(id, body, uid) {
    v.object(body, ["expectedVersion", "mutationId"]);
    return this.mutate({ collection: "suppliers", id, expectedVersion: body.expectedVersion,
      mutationId: body.mutationId, uid, action: "restore" });
  }
  async saveSettings(body, uid) {
    v.object(body, ["expectedVersion", "mutationId", "data"]);
    v.object(body.data, ["defaultVatBasisPoints"]);
    const rate = body.data.defaultVatBasisPoints;
    if (!Number.isInteger(rate) || rate < 0 || rate > 10000)
      fail(400, "INVALID_INPUT", "יש לבחור שיעור מע״מ בין 0 ל־100 אחוזים.");
    return this.mutate({ collection: "settings", id: "accounting", expectedVersion: body.expectedVersion,
      mutationId: body.mutationId, uid, data: { defaultVatBasisPoints: rate } });
  }
  async cancelMutation(mutationId, body, uid) {
    v.id(mutationId);
    v.object(body, ["entity"]);
    const match =
      typeof body.entity === "string" &&
      body.entity.match(
        /^(suppliers|invoices|daily-cash|settings)\/([a-zA-Z0-9_-]{8,100})$/,
      );
    if (!match) fail(400, "INVALID_INPUT", "בקשת הביטול אינה תקינה.");
    const key =
      (match[1] === "daily-cash" ? "dailyCash" : match[1]) + "/" + match[2];
    const receiptKey = "mutations/" + mutationId;
    const receipt = await this.store.transaction(async (tx) => {
      const saved = await tx.get(receiptKey);
      if (saved) {
        if (saved.entity !== key)
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "מזהה הבקשה כבר משויך לרשומה אחרת.",
          );
        return saved;
      }
      const cancelled = {
        id: mutationId,
        entity: key,
        state: "cancelled",
        at: tx.stamp(),
        by: uid,
      };
      tx.set(receiptKey, cancelled);
      return cancelled;
    });
    if (receipt.state === "cancelled") return { status: "cancelled" };
    return {
      status: "committed",
      path: body.entity,
      record: await this.store.get(key),
      relatedRecords: await Promise.all(
        (receipt.relatedPaths || []).map(async (path) => ({
          path,
          record: await this.store.get(path),
        })),
      ),
    };
  }
  async saveInvoice(id, body, uid) {
    v.object(body, ["expectedVersion", "mutationId", "data"]);
    const { newSupplier, reactivateSupplier, ...data } = v.invoice(body.data);
    return this.mutate({
      collection: "invoices",
      id,
      expectedVersion: body.expectedVersion,
      mutationId: body.mutationId,
      uid,
      data,
      supplierIntent: newSupplier
        ? { newSupplier }
        : reactivateSupplier
          ? { reactivateSupplier }
          : null,
    });
  }
  async saveCash(id, body, uid) {
    v.object(body, ["expectedVersion", "mutationId", "data"]);
    const data = v.cash(body.data);
    if (data.date !== id) fail(400, "INVALID_DATE", "תאריך הרשומה אינו תואם.");
    return this.mutate({
      collection: "dailyCash",
      id,
      expectedVersion: body.expectedVersion,
      mutationId: body.mutationId,
      uid,
      data,
    });
  }
  async actInvoice(id, action, body, uid) {
    v.object(
      body,
      action === "pay"
        ? ["expectedVersion", "mutationId", "payment"]
        : ["expectedVersion", "mutationId"],
    );
    return this.mutate({
      collection: "invoices",
      id,
      action,
      uid,
      expectedVersion: body.expectedVersion,
      mutationId: body.mutationId,
      data: action === "pay" ? { payment: v.payment(body.payment) } : {},
    });
  }
  async backup() {
    const before = (await this.store.get("system/dataVersion"))?.version || 0;
    const [suppliers, invoices, dailyCash, documents] = await Promise.all(
      ["suppliers", "invoices", "dailyCash", "documents"].map((c) =>
        this.all(c),
      ),
    );
    const after = (await this.store.get("system/dataVersion"))?.version || 0;
    if (before !== after)
      fail(
        409,
        "BACKUP_CHANGED",
        "הנתונים השתנו בזמן הכנת הגיבוי. יש לנסות שוב.",
      );
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      currency: "ILS",
      moneyUnit: "agorot",
      suppliers,
      invoices,
      dailyCash,
      documents,
    };
  }
}
