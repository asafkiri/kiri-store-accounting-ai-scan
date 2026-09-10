import { createHash } from "node:crypto";
import { fail } from "./errors.js";
import * as v from "./validation.js";
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
  constructor(store) {
    this.store = store;
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
  }) {
    v.id(id);
    v.id(mutationId);
    v.version(expectedVersion);
    const key = collection + "/" + id,
      receiptKey = "mutations/" + mutationId;
    const fingerprint = hash({ key, expectedVersion, data, action });
    const reply = await this.store.transaction(async (tx) => {
      const receipt = await tx.get(receiptKey);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "בקשת השמירה השתנתה. יש לבדוק את הנתונים ולנסות מחדש.",
          );
        return { replayed: true, id };
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
      if (collection === "invoices") {
        if (action === "save") {
          const supplier = await tx.get("suppliers/" + next.supplierId);
          if (
            !supplier ||
            supplier.deletedAt ||
            (!supplier.active && previous?.supplierId !== next.supplierId)
          )
            fail(400, "SUPPLIER_MISSING", "יש לבחור ספק פעיל.");
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
      const sequence = (dataVersion?.version || 0) + 1;
      tx.set("system/dataVersion", { id: "dataVersion", version: sequence });
      tx.set("changes/" + String(sequence).padStart(16, "0"), {
        id: String(sequence).padStart(16, "0"),
        version: sequence,
        entity: key,
      });
      tx.set(key, next);
      tx.set(receiptKey, {
        id: mutationId,
        fingerprint,
        entity: key,
        action,
        at: tx.stamp(),
        by: uid,
        before: previous || null,
      });
      return { replayed: false, id };
    });
    return { ...reply, record: await this.store.get(key) };
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
  async saveInvoice(id, body, uid) {
    v.object(body, ["expectedVersion", "mutationId", "data"]);
    return this.mutate({
      collection: "invoices",
      id,
      expectedVersion: body.expectedVersion,
      mutationId: body.mutationId,
      uid,
      data: v.invoice(body.data),
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
