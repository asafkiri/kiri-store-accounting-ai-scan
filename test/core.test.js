import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AccountingService } from "../src/invoices.js";
import * as v from "../src/validation.js";
import { MemoryStore, inv } from "./helpers.js";
import { reconcile } from "../src/reconciliation.js";
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
test("accountant comparison is one-to-one, cautious and does not mutate inputs", () => {
  const rows = [
    {
      supplierName: "בדיקה",
      documentNumber: "1001",
      invoiceDate: "2026-09-10",
      totalAgorot: 11800,
      vatAgorot: 1800,
      needsReview: false,
    },
  ];
  const invoices = [{ ...inv(), id: "invoice-001", status: "unpaid" }],
    before = structuredClone(invoices);
  const r = reconcile([...rows, ...rows], invoices, [
    { id: "supplier-001", name: "בדיקה" },
  ]);
  assert.equal(r.matchedCount, 1);
  assert.equal(r.results[1].status, "needsReview");
  assert.deepEqual(invoices, before);
  assert.equal(
    reconcile([{ ...rows[0], vatAgorot: null }], invoices, [
      { id: "supplier-001", name: "בדיקה" },
    ]).matchedCount,
    0,
  );
});
