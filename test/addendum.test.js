import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AccountingService } from "../src/invoices.js";
import { MemoryStore, inv, aiResult } from "./helpers.js";
import { summarize } from "../src/validation.js";
import { validateInvoiceExtraction } from "../src/ai-schema.js";

const uid = "addendum-owner";
const body = (data, expectedVersion = 0) => ({
  data,
  expectedVersion,
  mutationId: randomUUID(),
});
async function setup() {
  const store = new MemoryStore(),
    service = new AccountingService(store);
  await service.saveSupplier(
    "supplier-001",
    body({ name: "ספק לבדיקה", active: true, contact: "", notes: "" }),
    uid,
  );
  return { store, service };
}
const credit = (amount = -3000) => ({
  ...inv(),
  documentType: "credit",
  documentNumber: "CR-001",
  subtotalAgorot: null,
  vatAgorot: null,
  totalAgorot: amount,
  finalAgorot: amount,
});

test("a credit is negative: invoice 100 plus credit 30 leaves 70 in monthly and open totals", async () => {
  const { service } = await setup();
  await assert.rejects(
    service.saveInvoice("credit-positive", body(credit(3000)), uid),
    (e) => e.code === "INVALID_CREDIT_SIGN",
  );
  await service.saveInvoice(
    "invoice-100",
    body({
      ...inv(),
      totalAgorot: 10000,
      finalAgorot: 10000,
      subtotalAgorot: null,
      vatAgorot: null,
    }),
    uid,
  );
  await service.saveInvoice("credit-030", body(credit()), uid);
  const totals = summarize(await service.all("invoices"));
  assert.equal(totals.finalAgorot, 7000);
  assert.equal(totals.totalAgorot, 7000);
  assert.equal(totals.unpaidAgorot, 7000);
});
test("credit sign rules reject positive known VAT/subtotal and zero totals, preserving null or explicit zero VAT", async () => {
  const { service } = await setup();
  for (const values of [
    { vatAgorot: 300 },
    { subtotalAgorot: 3000 },
    { finalAgorot: 0 },
    { totalAgorot: 0 },
  ]) {
    await assert.rejects(
      service.saveInvoice(
        "credit-invalid",
        body({ ...credit(), ...values }),
        uid,
      ),
      (e) => e.code === "INVALID_CREDIT_SIGN",
    );
  }
  const saved = await service.saveInvoice(
    "credit-no-vat",
    body({ ...credit(), subtotalAgorot: -3000, vatAgorot: 0 }),
    uid,
  );
  assert.equal(saved.record.vatAgorot, 0);
});
test("AI keeps positive numbers printed on a credit and explicitly flags sign review", () => {
  const raw = { ...aiResult(), documentType: "credit" };
  const result = validateInvoiceExtraction(raw);
  assert.equal(result.totalAgorot, raw.totalAgorot);
  assert.equal(result.vatAgorot, raw.vatAgorot);
  assert.equal(result.needsReview, true);
  assert.ok(result.uncertainFields.includes("finalAgorot"));
  assert.match(result.warnings.join(" "), /זיכוי.*שלילי/);
});
test("legacy positive credits are flagged instead of reporting a misleading aggregate", () => {
  const totals = summarize([
    { ...inv(), status: "unpaid" },
    { ...credit(3000), status: "unpaid" },
  ]);
  assert.equal(totals.invalidCredits, 1);
  assert.equal(totals.finalAgorot, null);
  assert.equal(totals.unpaidAgorot, null);
});

test("cancel receipt fences late original writes and supports an explicitly edited replacement", async () => {
  const { service } = await setup();
  const original = body(inv());
  const result = await service.cancelMutation(
    original.mutationId,
    { entity: "invoices/invoice-late" },
    uid,
  );
  assert.equal(result.status, "cancelled");
  await assert.rejects(
    service.saveInvoice("invoice-late", original, uid),
    (e) => e.code === "MUTATION_CANCELLED",
  );
  await service.saveInvoice(
    "invoice-late",
    body({ ...inv(), notes: "עריכה אחרי ביטול" }),
    uid,
  );
  assert.equal((await service.all("invoices")).length, 1);
  assert.equal((await service.all("invoices"))[0].notes, "עריכה אחרי ביטול");
  assert.equal(
    (
      await service.cancelMutation(
        original.mutationId,
        { entity: "invoices/invoice-late" },
        uid,
      )
    ).status,
    "cancelled",
  );
});
test("cancelling a committed invoice reports both records and never deletes the committed supplier or invoice", async () => {
  const { service } = await setup();
  const input = body({
    ...inv(),
    supplierId: "supplier-inline",
    newSupplier: { name: "ספק שנשמר" },
  });
  const saved = await service.saveInvoice("invoice-inline", input, uid);
  const result = await service.cancelMutation(
    input.mutationId,
    { entity: "invoices/invoice-inline" },
    uid,
  );
  assert.equal(result.status, "committed");
  assert.equal(result.path, "invoices/invoice-inline");
  assert.deepEqual(result.record, saved.record);
  assert.deepEqual(result.relatedRecords, saved.relatedRecords);
  assert.equal((await service.all("invoices")).length, 1);
  assert.equal((await service.all("suppliers")).length, 2);
});
test("save and cancellation racing have one definitive outcome", async () => {
  for (const cancelFirst of [true, false]) {
    const { service } = await setup();
    const input = body(inv());
    const save = () => service.saveInvoice("invoice-race", input, uid);
    const cancel = () =>
      service.cancelMutation(
        input.mutationId,
        { entity: "invoices/invoice-race" },
        uid,
      );
    const results = await Promise.allSettled(
      (cancelFirst ? [cancel, save] : [save, cancel]).map((run) => run()),
    );
    const cancellation = results[cancelFirst ? 0 : 1];
    assert.equal(cancellation.status, "fulfilled");
    const count = (await service.all("invoices")).length;
    if (cancellation.value.status === "cancelled") {
      assert.equal(count, 0);
      assert.equal(
        results[cancelFirst ? 1 : 0].reason.code,
        "MUTATION_CANCELLED",
      );
    } else assert.equal(count, 1);
  }
});
test("cash/payment cancellation validates entity paths and cannot reuse a receipt for another record", async () => {
  const { service } = await setup();
  const input = body({
    date: "2026-09-11",
    cashAgorot: 100,
    ravKavAgorot: null,
    notes: "",
  });
  await service.cancelMutation(
    input.mutationId,
    { entity: "daily-cash/2026-09-11" },
    uid,
  );
  await assert.rejects(
    service.saveCash("2026-09-11", input, uid),
    (e) => e.code === "MUTATION_CANCELLED",
  );
  await assert.rejects(
    service.cancelMutation(
      input.mutationId,
      { entity: "invoices/something-else" },
      uid,
    ),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
  for (const entity of [
    "system/dataVersion",
    "mutations/receipt-001",
    "../anything",
    "invoices/short",
  ])
    await assert.rejects(
      service.cancelMutation(randomUUID(), { entity }, uid),
      (e) => e.status === 400,
    );
  await assert.rejects(
    service.cancelMutation(
      randomUUID(),
      { entity: "invoices/invoice-001", force: true },
      uid,
    ),
    (e) => e.status === 400,
  );
  await service.saveInvoice("invoice-payment", body(inv()), uid);
  const payment = {
    expectedVersion: 1,
    mutationId: randomUUID(),
    payment: {
      method: "cash",
      paymentDate: "2026-09-11",
      checkNumber: "",
      checkDueDate: null,
      notes: "",
    },
  };
  await service.cancelMutation(
    payment.mutationId,
    { entity: "invoices/invoice-payment" },
    uid,
  );
  await assert.rejects(
    service.actInvoice("invoice-payment", "pay", payment, uid),
    (e) => e.code === "MUTATION_CANCELLED",
  );
  assert.equal((await service.all("invoices"))[0].status, "unpaid");
});
