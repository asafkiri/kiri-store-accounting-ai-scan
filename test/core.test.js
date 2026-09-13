import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AccountingService } from "../src/invoices.js";
import * as v from "../src/validation.js";
import { MemoryStore, inv } from "./helpers.js";
const uid = "owner-unit-test";
async function fixture() {
  const store = new MemoryStore(),
    service = new AccountingService(store);
  await service.saveSupplier(
    "supplier-001",
    {
      expectedVersion: 0,
      mutationId: randomUUID(),
      data: { name: "בדיקה", notes: "", contact: "", active: true },
    },
    uid,
  );
  return { store, service };
}
const body = (data, expectedVersion = 0) => ({
  data,
  expectedVersion,
  mutationId: randomUUID(),
});
// A different invoice of the same supplier on the same day: another total, with
// the VAT that belongs to it.
const amounts = (subtotal, rate = 0.18) => ({
  subtotalAgorot: subtotal,
  vatAgorot: Math.round(subtotal * rate),
  totalAgorot: subtotal + Math.round(subtotal * rate),
  finalAgorot: subtotal + Math.round(subtotal * rate),
});
test("unused supplier deletion is versioned, replayable and visible to other devices", async () => {
  const { service, store } = await fixture();
  const request = { expectedVersion: 1, mutationId: randomUUID() };
  const deleted = await service.deleteSupplier("supplier-001", request, uid);
  assert.ok(deleted.record.deletedAt);
  assert.equal(deleted.record.active, false);
  assert.equal(deleted.record.version, 2);
  assert.equal((await service.deleteSupplier("supplier-001", request, uid)).replayed, true);
  assert.equal((await store.get("system/dataVersion")).version, 2);
  await assert.rejects(service.saveSupplier("supplier-001", body({ name: "בדיקה", active: true, notes: "", contact: "" }, 1), uid), e => e.code === "VERSION_CONFLICT");
  await service.saveSupplier("supplier-new", body({ name: "בדיקה", active: true, notes: "", contact: "" }), uid);
  assert.equal((await store.get("suppliers/supplier-new")).deletedAt, null);
});
test("supplier recycle bin preserves invoices, restores prior state and enforces the server deadline", async () => {
  const { service, store } = await fixture();
  let now = Date.now(); service.now = () => now;
  await service.saveInvoice("invoice-001", body(inv()), uid);
  const original = await store.get("invoices/invoice-001");
  const removed = await service.deleteSupplier("supplier-001", { expectedVersion: 1, mutationId: randomUUID() }, uid);
  assert.equal(removed.record.restoreUntil, now + 30 * 86400000);
  assert.deepEqual(await store.get("invoices/invoice-001"), original);
  await assert.rejects(service.saveInvoice("invoice-new", body({ ...inv(), documentNumber: "new" }), uid), e => e.code === "SUPPLIER_MISSING");
  await service.saveInvoice("invoice-001", body({ ...inv(), notes: "היסטוריה נשמרת" }, 1), uid);
  const restoreRequest = { expectedVersion: 2, mutationId: randomUUID() };
  now += 29 * 86400000;
  const restored = await service.restoreSupplier("supplier-001", restoreRequest, uid);
  assert.equal(restored.record.deletedAt, null);
  assert.equal(restored.record.active, true);
  assert.equal((await service.restoreSupplier("supplier-001", restoreRequest, uid)).replayed, true);
  await service.deleteSupplier("supplier-001", { expectedVersion: 3, mutationId: randomUUID() }, uid);
  now += 30 * 86400000;
  await assert.rejects(service.restoreSupplier("supplier-001", { expectedVersion: 4, mutationId: randomUUID() }, uid), e => e.code === "RESTORE_EXPIRED");
  assert.ok((await store.get("suppliers/supplier-001")).deletedAt);
});
test("restoring a supplier cannot create duplicate names or overwrite another device", async () => {
  const { service } = await fixture();
  await service.deleteSupplier("supplier-001", { expectedVersion: 1, mutationId: randomUUID() }, uid);
  await service.saveSupplier("supplier-new", body({ name: "בדיקה", notes: "", contact: "", active: true }), uid);
  await assert.rejects(service.restoreSupplier("supplier-001", { expectedVersion: 2, mutationId: randomUUID() }, uid), e => e.code === "SUPPLIER_EXISTS");
  await assert.rejects(service.restoreSupplier("supplier-001", { expectedVersion: 1, mutationId: randomUUID() }, uid), e => e.code === "VERSION_CONFLICT");
});
test("VAT preference is shared, versioned and retryable with input validation", async () => {
  const { service, store } = await fixture();
  const request = body({ defaultVatBasisPoints: 1750 });
  const saved = await service.saveSettings(request, uid);
  assert.equal(saved.record.defaultVatBasisPoints, 1750);
  assert.equal((await service.saveSettings(request, uid)).replayed, true);
  assert.equal((await store.get("system/dataVersion")).version, 2);
  for (const rate of [-1, 10001, 18.1, "18"])
    await assert.rejects(service.saveSettings(body({ defaultVatBasisPoints: rate }, 1), uid), e => e.code === "INVALID_INPUT");
});
test("new records accept invoices and credit invoices; legacy document types remain editable", async () => {
  const { service, store } = await fixture();
  for (const documentType of ["delivery", "receipt"]) {
    await assert.rejects(service.saveInvoice("invoice-" + documentType, body({ ...inv(), documentType }), uid), e => e.code === "INVOICE_TYPE_REQUIRED");
  }
  await service.saveInvoice("legacy-invoice", body(inv()), uid);
  await store.transaction(async tx => { tx.set("invoices/legacy-invoice", { ...await tx.get("invoices/legacy-invoice"), documentType: "delivery" }); });
  const edited = await service.saveInvoice("legacy-invoice", body({ ...inv(), documentType: "delivery", notes: "היסטוריה" }, 1), uid);
  assert.equal(edited.record.documentType, "delivery");
});
test("invoice lifecycle, check handover date independent from due date, audit and reload", async () => {
  const { service, store } = await fixture();
  let a = await service.saveInvoice("invoice-001", body(inv()), uid);
  assert.equal(a.record.status, "unpaid");
  assert.equal(a.record.totalAgorot, 11800);
  a = await service.saveInvoice(
    "invoice-001",
    body({ ...inv(), notes: "עדכון" }, 1),
    uid,
  );
  assert.equal(a.record.version, 2);
  assert.equal(a.record.notes, "עדכון");
  assert.equal((await store.get("invoices/invoice-001")).notes, "עדכון");
  a = await service.actInvoice(
    "invoice-001",
    "pay",
    {
      expectedVersion: 2,
      mutationId: randomUUID(),
      payment: {
        method: "check",
        paymentDate: "2026-09-10",
        checkDueDate: "2026-09-30",
        checkNumber: "17",
        notes: "",
      },
    },
    uid,
  );
  assert.equal(a.record.payment.paymentDate, "2026-09-10");
  assert.equal(a.record.payment.checkDueDate, "2026-09-30");
  assert.equal(a.record.status, "paid");
  assert.equal(
    (await new AccountingService(store).backup()).invoices[0].status,
    "paid",
  );
  assert.equal((await service.all("mutations")).length, 4);
  a = await service.actInvoice(
    "invoice-001",
    "delete",
    { expectedVersion: 3, mutationId: randomUUID() },
    uid,
  );
  assert.ok(a.record.deletedAt);
  a = await service.actInvoice(
    "invoice-001",
    "restore",
    { expectedVersion: 4, mutationId: randomUUID() },
    uid,
  );
  assert.equal(a.record.deletedAt, null);
});
test("lost response replay, concurrent duplicate write and stale-device update", async () => {
  const { service } = await fixture();
  const input = body(inv());
  const result = await Promise.all([
    service.saveInvoice("invoice-001", input, uid),
    service.saveInvoice("invoice-001", input, uid),
  ]);
  assert.equal(result.filter((r) => r.replayed).length, 1);
  assert.equal(result[1].record.version, 1);
  await assert.rejects(
    service.saveInvoice("invoice-002", body(inv()), uid),
    (e) => e.code === "DUPLICATE_INVOICE",
  );
  await assert.rejects(
    service.saveInvoice("invoice-001", body(inv(), 0), uid),
    (e) => e.code === "VERSION_CONFLICT",
  );
  await assert.rejects(
    service.saveInvoice(
      "invoice-001",
      { ...input, data: { ...inv(), notes: "שינוי" } },
      uid,
    ),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
});
test("payment can be corrected without replacing the business date", async () => {
  const { service } = await fixture();
  await service.saveInvoice("invoice-001", body(inv()), uid);
  await service.actInvoice(
    "invoice-001",
    "pay",
    {
      expectedVersion: 1,
      mutationId: randomUUID(),
      payment: {
        method: "cash",
        paymentDate: "2026-09-10",
        checkNumber: "",
        checkDueDate: null,
        notes: "",
      },
    },
    uid,
  );
  const r = await service.saveInvoice(
    "invoice-001",
    body({ ...inv(), notes: "תוקן" }, 2),
    uid,
  );
  assert.equal(r.record.payment.paymentDate, "2026-09-10");
  assert.equal(r.record.status, "paid");
});
test("daily cash and Rav-Kav stay separate; blank differs from zero; no invoices created", async () => {
  const { service } = await fixture();
  const a = await service.saveCash(
    "2026-09-10",
    body({
      date: "2026-09-10",
      cashAgorot: 100001,
      ravKavAgorot: 4567,
      notes: "",
    }),
    uid,
  );
  assert.equal(a.record.cashAgorot, 100001);
  assert.equal(a.record.ravKavAgorot, 4567);
  assert.equal((await service.all("invoices")).length, 0);
  await service.saveCash(
    "2026-09-11",
    body({ date: "2026-09-11", cashAgorot: 0, ravKavAgorot: null, notes: "" }),
    uid,
  );
  assert.equal((await service.all("dailyCash")).length, 2);
});
test("money uses integer agorot, VAT is nullable and credits remain signed", () => {
  assert.equal(v.money(12345), 12345);
  assert.throws(() => v.money(123.45));
  assert.throws(() => v.money(Number.MAX_SAFE_INTEGER + 1));
  assert.equal(v.money(null, true), null);
  assert.equal(v.money(-100), -100);
  const rows = [
    { ...inv(), status: "unpaid", vatAgorot: null },
    {
      ...inv(),
      status: "paid",
      subtotalAgorot: -10000,
      vatAgorot: -1800,
      totalAgorot: -11800,
      finalAgorot: -11800,
    },
  ];
  assert.equal(v.summarize(rows).totalAgorot, 0);
  assert.equal(v.summarize(rows).unknownVat, 1);
});
test("month, date, supplier, payment-method and notes filters", () => {
  const rows = [
    { ...inv(), status: "paid", payment: { method: "check" }, notes: "בדיקה" },
    { ...inv(), invoiceDate: "2026-08-31", status: "unpaid" },
  ];
  assert.equal(v.filterInvoices(rows, { month: "2026-09" }).length, 1);
  assert.equal(
    v.filterInvoices(rows, {
      from: "2026-09-01",
      to: "2026-09-30",
      method: "check",
      status: "paid",
      q: "בדיקה",
    }).length,
    1,
  );
  assert.equal(v.filterInvoices(rows, { supplierId: "other" }).length, 0);
  assert.throws(() => v.date("2026-02-30"));
  assert.equal(v.date("2024-02-29"), "2024-02-29");
  assert.throws(() => v.filters(new URLSearchParams("month=2026-13")));
});
test("review is required and no unverified supplier or privileged fields can enter invoices", async () => {
  const { service } = await fixture();
  await assert.rejects(
    service.saveInvoice(
      "invoice-001",
      body({ ...inv(), reviewConfirmed: false }),
      uid,
    ),
    (e) => e.code === "REVIEW_REQUIRED",
  );
  await assert.rejects(
    service.saveInvoice("invoice-001", body({ ...inv(), status: "paid" }), uid),
    (e) => e.code === "INVALID_INPUT",
  );
  await assert.rejects(
    service.saveInvoice(
      "invoice-001",
      body({ ...inv(), supplierId: "missing-001" }),
      uid,
    ),
    (e) => e.code === "SUPPLIER_MISSING",
  );
});

test("invoices typed without a number are still guarded, by their supplier, date and amounts", async () => {
  const { service, store } = await fixture();
  const blank = { ...inv(), documentNumber: "" };
  const first = await service.saveInvoice("invoice-blank-1", body(blank), uid);
  assert.equal(first.record.documentNumber, "");
  // The same supplier, date, total and VAT: the same invoice, entered twice.
  await assert.rejects(
    service.saveInvoice("invoice-blank-2", body(blank), uid),
    e => e.code === "DUPLICATE_INVOICE_DETAILS" && e.status === 409 && e.details.invoiceId === "invoice-blank-1",
  );
  // A second delivery that day, for a different amount, is a different invoice.
  const second = await service.saveInvoice(
    "invoice-blank-2",
    body({ ...blank, subtotalAgorot: 5000, vatAgorot: 900, totalAgorot: 5900, finalAgorot: 5900 }),
    uid,
  );
  assert.equal(second.record.id, "invoice-blank-2");
  // Where a number was typed, entering it twice is refused by the number, even
  // when the amounts were typed differently the second time.
  await service.saveInvoice("invoice-numbered", body({ ...inv(), ...amounts(7000), documentNumber: "A-77" }), uid);
  await assert.rejects(
    service.saveInvoice("invoice-numbered-again", body({ ...inv(), ...amounts(8000), documentNumber: "A-77" }), uid),
    e => e.code === "DUPLICATE_INVOICE",
  );
  // Adding the number later claims it; clearing it again releases the claim.
  const numbered = await service.saveInvoice("invoice-blank-1", body({ ...blank, documentNumber: "B-88" }, 1), uid);
  assert.equal(numbered.record.documentNumber, "B-88");
  await assert.rejects(
    service.saveInvoice("invoice-blank-3", body({ ...inv(), ...amounts(9000), documentNumber: "B-88" }), uid),
    e => e.code === "DUPLICATE_INVOICE",
  );
  await service.saveInvoice("invoice-blank-1", body(blank, 2), uid);
  const released = await service.saveInvoice("invoice-blank-3", body({ ...inv(), ...amounts(9000), documentNumber: "B-88" }), uid);
  assert.equal(released.record.documentNumber, "B-88");
  assert.equal((await store.get("invoices/invoice-blank-1")).duplicateAllowed, undefined);
});

test("the same supplier, date and amounts can be saved twice once the person says they are two invoices", async () => {
  const { service, store } = await fixture();
  const twin = { ...inv(), documentNumber: "" };
  await service.saveInvoice("invoice-twin-1", body(twin), uid);
  await assert.rejects(
    service.saveInvoice("invoice-twin-2", body(twin), uid),
    e => e.code === "DUPLICATE_INVOICE_DETAILS",
  );
  const allowed = await service.saveInvoice("invoice-twin-2", body({ ...twin, duplicateAllowed: true }), uid);
  assert.equal(allowed.record.duplicateAllowed, true);
  // Saying so once is enough: paying it later, or editing it, is not refused
  // for the twin it was already told apart from.
  const paid = await service.actInvoice(
    "invoice-twin-2",
    "pay",
    { expectedVersion: 1, mutationId: randomUUID(), payment: { method: "cash", paymentDate: "2026-09-11", checkNumber: "", checkDueDate: null, notes: "" } },
    uid,
  );
  assert.equal(paid.record.status, "paid");
  assert.equal((await service.saveInvoice("invoice-twin-2", body({ ...twin, notes: "העתק" }, 2), uid)).record.duplicateAllowed, true);
  // The invoice that was saved first still holds the claim, so a third entry of
  // the same details is refused like the second was.
  await assert.rejects(
    service.saveInvoice("invoice-twin-3", body(twin), uid),
    e => e.code === "DUPLICATE_INVOICE_DETAILS" && e.details.invoiceId === "invoice-twin-1",
  );
  // Correcting the first invoice's total releases the details it claimed.
  await service.saveInvoice("invoice-twin-1", body({ ...twin, ...amounts(4400) }, 1), uid);
  assert.equal((await service.saveInvoice("invoice-twin-3", body(twin), uid)).record.id, "invoice-twin-3");
  assert.equal((await store.list("invoiceKeys")).filter(k => k.invoiceId).length, 2);
});

test("an invoice saved before the guard existed is still paid, even when its details are claimed", async () => {
  const { service, store } = await fixture();
  const twin = { ...inv(), documentNumber: "" };
  await service.saveInvoice("invoice-new", body(twin), uid);
  // What the store held before this guard: an invoice with no claim of its own.
  await store.transaction(async tx => {
    tx.set("invoices/invoice-legacy", {
      ...twin, id: "invoice-legacy", version: 1, status: "unpaid", payment: null,
      createdAt: 1, updatedAt: 1, createdBy: uid, updatedBy: uid, deletedAt: null,
    });
  });
  const paid = await service.actInvoice(
    "invoice-legacy",
    "pay",
    { expectedVersion: 1, mutationId: randomUUID(), payment: { method: "cash", paymentDate: "2026-09-11", checkNumber: "", checkDueDate: null, notes: "" } },
    uid,
  );
  assert.equal(paid.record.status, "paid");
  assert.equal((await store.get("invoiceKeys/" + (await store.list("invoiceKeys"))[0].id)).invoiceId, "invoice-new",
    "paying claims nothing, so the claim stays with the invoice that made it");
});

test("deleting an invoice frees the details it claimed, and restoring it takes them back", async () => {
  const { service } = await fixture();
  const twin = { ...inv(), documentNumber: "" };
  await service.saveInvoice("invoice-gone", body(twin), uid);
  await service.actInvoice("invoice-gone", "delete", { expectedVersion: 1, mutationId: randomUUID() }, uid);
  const again = await service.saveInvoice("invoice-again", body(twin), uid);
  assert.equal(again.record.id, "invoice-again");
  // Restoring the deleted invoice would bring the same details back, so it is
  // refused while the one typed in its place holds them.
  await assert.rejects(
    service.actInvoice("invoice-gone", "restore", { expectedVersion: 2, mutationId: randomUUID() }, uid),
    e => e.code === "DUPLICATE_INVOICE_DETAILS" && e.details.invoiceId === "invoice-again",
  );
});
