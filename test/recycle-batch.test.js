import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AccountingService } from "../src/invoices.js";
import { DocumentLifecycle } from "../src/document-lifecycle.js";
import { DAY } from "../src/recycle.js";
import { MemoryStore, MemoryStorage, inv } from "./helpers.js";
const uid = "recycle-batch-owner";
const request = version => ({ expectedVersion: version, mutationId: randomUUID() });
const payment = { method: "check", paymentDate: "2026-09-13", checkNumber: "001234", checkDueDate: "2026-10-01", notes: "תשלום משותף" };
async function fixture() {
  const store = new MemoryStore(), storage = new MemoryStorage();
  let clock = Date.now();
  const service = new AccountingService(store, () => clock);
  const lifecycle = new DocumentLifecycle({ store, storage, accounting: service, retentionDays: 0, now: () => clock });
  await service.saveSupplier("supplier-001", { ...request(0), data: { name: "ספק לבדיקה", active: true, notes: "", contact: "" } }, uid);
  const pages = ["a", "b", "c"].map(c => c.repeat(64));
  for (const id of pages) { store.rows.set("documents/" + id, { id, uploadedAt: clock, size: 10, pages: 1 }); storage.rows.set("documents/" + id, Buffer.from("photo")); }
  const add = async (n, extras = {}) => (await service.saveInvoice("invoice-" + n, {
    ...request(0), data: { ...inv(), documentNumber: "", invoiceDate: `2026-09-${String(n).padStart(2, "0")}`, ...extras },
  }, uid)).record;
  return { store, storage, service, lifecycle, pages, add, advance: days => { clock += days * DAY; } };
}
test("invoice recycle preserves paid state and ordered photos, enforces the 30-day boundary and duplicate claims", async () => {
  const f = await fixture();
  let invoice = await f.add(1, { attachmentIds: f.pages });
  invoice = (await f.service.actInvoice(invoice.id, "pay", { ...request(invoice.version), payment }, uid)).record;
  const removed = await f.service.actInvoice(invoice.id, "delete", request(invoice.version), uid);
  const restore = request(removed.record.version);
  f.advance(29);
  assert.equal((await f.lifecycle.purgeExpired()).deleted.length, 0);
  const back = await f.service.actInvoice(invoice.id, "restore", restore, uid);
  assert.equal(back.record.status, "paid"); assert.deepEqual(back.record.payment, invoice.payment);
  assert.deepEqual(back.record.attachmentIds, f.pages);
  assert.equal((await f.service.actInvoice(invoice.id, "restore", restore, uid)).replayed, true);
  const deletedAgain = await f.service.actInvoice(invoice.id, "delete", request(back.record.version), uid);
  await f.add(2, { invoiceDate: invoice.invoiceDate });
  await assert.rejects(f.service.actInvoice(invoice.id, "restore", request(deletedAgain.record.version), uid), e => e.code === "DUPLICATE_INVOICE_DETAILS");
  f.advance(30);
  await assert.rejects(f.service.actInvoice(invoice.id, "restore", request(deletedAgain.record.version), uid), e => e.code === "RESTORE_EXPIRED");
  await f.lifecycle.purgeExpired();
  assert.equal(f.storage.rows.size, 0, "expired deleted invoices release their files even when normal age retention is disabled");
  assert.equal((await f.store.get("invoices/" + invoice.id)).status, "paid");
});
test("recycled pages restore original order, remain scoped to their invoice and cannot be reattached after expiry", async () => {
  const f = await fixture(); let invoice = await f.add(1, { attachmentIds: f.pages });
  const shared = await f.add(2, { attachmentIds: [f.pages[0]] });
  const delA = request(invoice.version);
  invoice = (await f.service.recycleAttachment(invoice.id, f.pages[0], delA, uid)).record;
  invoice = (await f.service.recycleAttachment(invoice.id, f.pages[1], request(invoice.version), uid)).record;
  assert.equal((await f.service.recycleAttachment(invoice.id, f.pages[0], delA, uid)).replayed, true);
  invoice = (await f.service.recycleAttachment(invoice.id, f.pages[0], request(invoice.version), uid, "restore-attachment")).record;
  assert.deepEqual(invoice.attachmentIds, [f.pages[0], f.pages[2]]);
  invoice = (await f.service.recycleAttachment(invoice.id, f.pages[1], request(invoice.version), uid, "restore-attachment")).record;
  assert.deepEqual(invoice.attachmentIds, f.pages);
  const removal = request(invoice.version);
  invoice = (await f.service.recycleAttachment(invoice.id, f.pages[0], removal, uid)).record;
  await f.service.cancelMutation(randomUUID(), { entity: "invoices/" + invoice.id }, uid);
  f.advance(30);
  await assert.rejects(f.service.recycleAttachment(invoice.id, f.pages[0], request(invoice.version), uid, "restore-attachment"), e => e.code === "RESTORE_EXPIRED");
  await assert.rejects(f.service.saveInvoice(invoice.id, { ...request(invoice.version), data: { ...inv(), documentNumber: "", invoiceDate: invoice.invoiceDate, attachmentIds: f.pages } }, uid), e => e.code === "USE_DOCUMENT_TRASH");
  await f.lifecycle.purgeExpired();
  assert.ok(await f.store.get("documents/" + f.pages[0]), "another invoice still owns the file");
  assert.deepEqual((await f.store.get("invoices/" + shared.id)).attachmentIds, [f.pages[0]]);
  assert.deepEqual((await f.store.get("invoices/" + invoice.id)).trashedAttachmentIds, []);
});
test("batch payment commits one amount and cheque across all invoices; retry and cancellation recover every member", async () => {
  const f = await fixture(); const invoices = await Promise.all([f.add(1), f.add(2), f.add(3)]);
  const body = { ...request(1), items: invoices.map(i => ({ id: i.id, expectedVersion: i.version })), totalAgorot: 35400, payment };
  const [one, replay] = await Promise.all([f.service.payBatch(invoices[0].id, body, uid), f.service.payBatch(invoices[0].id, body, uid)]);
  assert.equal(one.replayed, false); assert.equal(replay.replayed, true); assert.equal(one.relatedRecords.length, 2);
  for (const i of invoices) {
    const saved = await f.store.get("invoices/" + i.id);
    assert.equal(saved.version, 2); assert.equal(saved.status, "paid"); assert.equal(saved.finalAgorot, 11800);
    assert.equal(saved.payment.checkNumber, "001234"); assert.equal(saved.payment.paymentDate, payment.paymentDate);
    assert.equal(saved.payment.batch.totalAgorot, 35400); assert.equal(saved.payment.batch.invoiceIds.length, 3);
  }
  const settled = await f.service.cancelMutation(body.mutationId, { entity: "invoices/" + invoices[0].id }, uid);
  assert.equal(settled.status, "committed"); assert.equal(settled.relatedRecords.length, 2);
  assert.equal((await f.service.backup()).invoices.filter(i => i.status === "paid").length, 3);
  const another = await f.add(4); const cancelledBody = { ...request(1), items: [{ id: another.id, expectedVersion: 1 }], totalAgorot: 11800, payment };
  await f.service.cancelMutation(cancelledBody.mutationId, { entity: "invoices/" + another.id }, uid);
  await assert.rejects(f.service.payBatch(another.id, cancelledBody, uid), e => e.code === "MUTATION_CANCELLED");
  assert.equal((await f.store.get("invoices/" + another.id)).status, "unpaid");
});
test("batch payment rejects mixed suppliers, duplicates, changed totals and stale members without partial writes", async () => {
  const f = await fixture(); const one = await f.add(1), two = await f.add(2);
  const body = { ...request(1), items: [one, two].map(i => ({ id: i.id, expectedVersion: 1 })), totalAgorot: 23600, payment };
  await assert.rejects(f.service.payBatch(one.id, { ...body, items: [body.items[0], body.items[0]] }, uid), e => e.code === "INVALID_BATCH");
  await assert.rejects(f.service.payBatch(one.id, { ...body, totalAgorot: 23601 }, uid), e => e.code === "BATCH_TOTAL_CHANGED");
  f.store.rows.get("invoices/" + two.id).supplierId = "supplier-other";
  await assert.rejects(f.service.payBatch(one.id, body, uid), e => e.code === "MIXED_SUPPLIERS");
  f.store.rows.get("invoices/" + two.id).supplierId = one.supplierId;
  await f.service.actInvoice(two.id, "pay", { ...request(1), payment }, uid);
  await assert.rejects(f.service.payBatch(one.id, body, uid), e => e.code === "VERSION_CONFLICT");
  assert.equal((await f.store.get("invoices/" + one.id)).status, "unpaid");
  assert.equal((await f.store.get("invoices/" + one.id)).version, 1);
  assert.equal(await f.store.get("mutations/" + body.mutationId), null);
});
test("batch payment offsets explicitly selected credit notes in the confirmed total", async () => {
  const f = await fixture(); const invoice = await f.add(1), credit = await f.add(2, { documentType: "credit", subtotalAgorot: -1000, vatAgorot: -180, totalAgorot: -1180, finalAgorot: -1180 });
  const result = await f.service.payBatch(invoice.id, { ...request(1), items: [invoice, credit].map(i => ({ id: i.id, expectedVersion: 1 })), totalAgorot: 10620, payment }, uid);
  assert.equal(result.batch.totalAgorot, 10620); assert.equal(result.relatedRecords[0].record.finalAgorot, -1180);
});

test("overlapping payments from two devices never pay only the non-overlapping remainder", async () => {
  const f = await fixture(), all = [await f.add(1), await f.add(2), await f.add(3)];
  const pay = invoices => f.service.payBatch(invoices[0].id, { ...request(1), items: invoices.map(i => ({ id: i.id, expectedVersion: 1 })), totalAgorot: 23600, payment }, uid);
  const results = await Promise.allSettled([pay(all.slice(0, 2)), pay(all.slice(1))]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "VERSION_CONFLICT");
  const records = await Promise.all(all.map(i => f.store.get("invoices/" + i.id)));
  assert.equal(records.filter(i => i.status === "paid").length, 2);
  assert.equal(records.find(i => i.status === "unpaid").version, 1);
});
