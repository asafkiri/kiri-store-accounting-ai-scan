import * as v from "./validation.js";
import { fail } from "./errors.js";
import { hash } from "./invoices.js";

// One receipt and one transaction cover the whole selection. The first invoice
// owns the receipt, so existing cancellation/recovery also settles every member.
export async function payBatch(service, id, body, uid) {
  v.id(id);
  v.object(body, ["expectedVersion", "mutationId", "items", "totalAgorot", "payment"]);
  v.id(body.mutationId); v.version(body.expectedVersion); v.money(body.totalAgorot);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50)
    fail(400, "INVALID_BATCH", "יש לבחור בין חשבונית אחת ל־50 חשבוניות.");
  const items = body.items.map(item => {
    v.object(item, ["id", "expectedVersion"]);
    return { id: v.id(item.id), expectedVersion: v.version(item.expectedVersion) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(items.map(i => i.id)).size !== items.length || !items.some(i => i.id === id && i.expectedVersion === body.expectedVersion))
    fail(400, "INVALID_BATCH", "בחירת החשבוניות אינה תקינה.");
  const payment = v.payment(body.payment), key = "invoices/" + id;
  const fingerprint = hash({ key, items, totalAgorot: body.totalAgorot, payment, action: "pay-batch" });
  const receiptKey = "mutations/" + body.mutationId;
  const reply = await service.store.transaction(async tx => {
    const receipt = await tx.get(receiptKey);
    if (receipt) {
      if (receipt.entity !== key || (receipt.state !== "cancelled" && receipt.fingerprint !== fingerprint))
        fail(409, "IDEMPOTENCY_CONFLICT", "בקשת התשלום השתנתה. יש לבדוק את הבחירה.");
      if (receipt.state === "cancelled") fail(409, "MUTATION_CANCELLED", "ניסיון התשלום בוטל. אפשר לבחור ולשמור מחדש.");
      return { replayed: true, relatedPaths: receipt.relatedPaths, batch: receipt.batch };
    }
    const current = await Promise.all(items.map(item => tx.get("invoices/" + item.id)));
    const dataVersion = await tx.get("system/dataVersion");
    let supplierId = null, total = 0;
    for (let index = 0; index < items.length; index++) {
      const record = current[index];
      if (!record || record.deletedAt || record.version !== items[index].expectedVersion || record.status !== "unpaid")
        fail(409, "VERSION_CONFLICT", "אחת החשבוניות השתנתה או כבר שולמה. התשלום לא נרשם לאף חשבונית; יש לרענן ולבדוק את הבחירה.");
      supplierId ||= record.supplierId;
      if (record.supplierId !== supplierId) fail(400, "MIXED_SUPPLIERS", "אפשר לרשום תשלום משותף רק לחשבוניות של אותו ספק.");
      v.creditAmounts(record);
      total += v.money(record.finalAgorot);
    }
    if (!Number.isSafeInteger(total) || total < 0 || total !== body.totalAgorot)
      fail(409, "BATCH_TOTAL_CHANGED", "סכום החשבוניות אינו תואם לסכום שאושר, או שסך הזיכויים גבוה מהתשלום. יש לבדוק את הבחירה.");
    v.money(total);
    const batch = { id: body.mutationId, invoiceIds: items.map(i => i.id), totalAgorot: total, supplierId };
    const relatedPaths = items.filter(i => i.id !== id).map(i => "invoices/" + i.id);
    let sequence = dataVersion?.version || 0;
    for (const record of current) {
      const path = "invoices/" + record.id;
      tx.set(path, { ...record, version: record.version + 1, status: "paid", updatedAt: tx.stamp(), updatedBy: uid,
        payment: { ...payment, recordedAt: tx.stamp(), recordedBy: uid, batch } });
      sequence++;
      const changeId = String(sequence).padStart(16, "0");
      tx.set("changes/" + changeId, { id: changeId, version: sequence, entity: path });
    }
    tx.set("system/dataVersion", { id: "dataVersion", version: sequence });
    tx.set(receiptKey, { id: body.mutationId, entity: key, fingerprint, action: "pay-batch", at: tx.stamp(), by: uid,
      before: current.find(i => i.id === id), relatedPaths, batch,
      // Only the fields changed by this operation are needed for its audit.
      paymentBefore: current.map(i => ({ id: i.id, version: i.version, status: i.status, payment: i.payment || null })) });
    return { replayed: false, relatedPaths, batch };
  });
  return { id, replayed: reply.replayed, batch: reply.batch, record: await service.store.get(key),
    relatedRecords: await Promise.all(reply.relatedPaths.map(async path => ({ path, record: await service.store.get(path) }))) };
}
