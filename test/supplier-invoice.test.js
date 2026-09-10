import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AccountingService } from "../src/invoices.js";
import { MemoryStore, inv } from "./helpers.js";

const uid = "supplier-feature-owner";
const body = (data, expectedVersion = 0) => ({
  data,
  expectedVersion,
  mutationId: randomUUID(),
});
const invoice = (name = "מרינה", extra = {}) =>
  body({
    ...inv(),
    supplierId: "supplier-new-001",
    newSupplier: { name },
    ...extra,
  });
const setup = () => {
  const store = new MemoryStore();
  return { store, service: new AccountingService(store) };
};
const supplier = (name, active = true) => ({
  name,
  active,
  contact: "",
  notes: "",
});

test("reviewed scan atomically creates supplier and invoice with audit metadata and sync changes", async () => {
  const { store, service } = setup();
  await store.transaction(async (tx) =>
    tx.set("scanJobs/scan-job-001", {
      status: "completed",
      purpose: "invoice",
    }),
  );
  const input = invoice("מרינה", { source: "ai", scanJobId: "scan-job-001" });
  const result = await service.saveInvoice("invoice-new-001", input, uid);
  const created = await store.get("suppliers/supplier-new-001");
  assert.equal(created.name, "מרינה");
  assert.equal(created.active, true);
  assert.equal(created.createdFrom, "scan");
  assert.equal(created.version, 1);
  assert.equal(created.createdBy, uid);
  assert.ok(created.createdAt);
  assert.equal(result.record.createdBy, uid);
  assert.equal(result.record.supplierId, created.id);
  assert.equal(result.record.newSupplier, undefined);
  assert.equal(result.supplierAction, "created");
  assert.deepEqual(result.relatedRecords, [
    { path: "suppliers/" + created.id, record: created },
  ]);
  assert.deepEqual((await service.all("changes")).map((c) => c.entity).sort(), [
    "invoices/invoice-new-001",
    "suppliers/supplier-new-001",
  ]);
  assert.equal((await store.get("system/dataVersion")).version, 2);
});

test("lost response and simultaneous retry keep one supplier, invoice and mutation receipt", async () => {
  const { service } = setup();
  const input = invoice();
  const replies = await Promise.all([
    service.saveInvoice("invoice-new-001", input, uid),
    service.saveInvoice("invoice-new-001", input, uid),
  ]);
  assert.equal(replies.filter((r) => r.replayed).length, 1);
  for (const collection of ["suppliers", "invoices", "mutations"])
    assert.equal((await service.all(collection)).length, 1);
  assert.deepEqual(replies[0].relatedRecords, replies[1].relatedRecords);
  assert.equal(replies[1].supplierAction, "created");
  await assert.rejects(
    service.saveInvoice(
      "invoice-new-001",
      { ...input, data: { ...input.data, newSupplier: { name: "שם אחר" } } },
      uid,
    ),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("failed review or missing attachment leaves neither supplier nor invoice", async () => {
  const { service } = setup();
  for (const extra of [
    { reviewConfirmed: false },
    { source: "ai", scanJobId: "missing-scan" },
    { attachmentIds: ["missing-document"] },
  ]) {
    await assert.rejects(
      service.saveInvoice("invoice-new-001", invoice("מרינה", extra), uid),
    );
    assert.equal((await service.all("suppliers")).length, 0);
    assert.equal((await service.all("invoices")).length, 0);
    assert.equal((await service.all("mutations")).length, 0);
  }
});

test("new supplier input is strictly validated and cannot set privileged supplier fields", async () => {
  const { service } = setup();
  for (const newSupplier of [
    { name: "" },
    { name: "a".repeat(161) },
    { name: "מרינה", active: false },
    { name: "מרינה", createdBy: "other" },
    null,
  ]) {
    await assert.rejects(
      service.saveInvoice(
        "invoice-new-001",
        invoice("unused", { newSupplier }),
        uid,
      ),
      (e) => e.status === 400,
    );
  }
  await assert.rejects(
    service.saveInvoice(
      "invoice-new-001",
      invoice("מרינה", { reactivateSupplier: { expectedVersion: 1 } }),
      uid,
    ),
    (e) => e.status === 400,
  );
});

test("two devices using normalized variants: one commits, the other can explicitly link the existing supplier", async () => {
  const { service } = setup();
  const inputs = [
    invoice("מרינה בע״מ"),
    invoice(" מרינה ", {
      supplierId: "supplier-new-002",
      documentNumber: "1002",
    }),
  ];
  const ids = ["invoice-new-001", "invoice-new-002"];
  const results = await Promise.allSettled(
    inputs.map((input, i) => service.saveInvoice(ids[i], input, uid)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const lost = results.findIndex((r) => r.status === "rejected");
  const error = results[lost].reason;
  assert.equal(error.status, 409);
  assert.equal(error.code, "SUPPLIER_EXISTS");
  assert.match(error.message, /כבר קיים ספק/);
  const data = { ...inputs[lost].data, supplierId: error.details.supplierId };
  delete data.newSupplier;
  await service.saveInvoice(ids[lost], body(data), uid);
  assert.equal((await service.all("suppliers")).length, 1);
  assert.equal((await service.all("invoices")).length, 2);
});

test("inactive match requires explicit reactivation, applied with invoice in one transaction", async () => {
  const { service, store } = setup();
  await service.saveSupplier(
    "supplier-inactive",
    body(supplier("מרינה בע״מ", false)),
    uid,
  );
  await assert.rejects(
    service.saveInvoice("invoice-new-001", invoice("מרינה"), uid),
    (e) =>
      e.code === "SUPPLIER_EXISTS" &&
      e.details.supplierId === "supplier-inactive",
  );
  const data = {
    ...inv(),
    supplierId: "supplier-inactive",
    reactivateSupplier: { expectedVersion: 1 },
  };
  await assert.rejects(
    service.saveInvoice(
      "invoice-new-001",
      body({ ...data, attachmentIds: ["missing-document"] }),
      uid,
    ),
  );
  assert.equal((await store.get("suppliers/supplier-inactive")).active, false);
  const response = await service.saveInvoice(
    "invoice-new-001",
    body(data),
    uid,
  );
  assert.equal(response.supplierAction, "reactivated");
  assert.equal(response.relatedRecords[0].record.active, true);
  assert.equal(response.relatedRecords[0].record.version, 2);
  assert.equal(response.relatedRecords[0].record.createdBy, uid);
  assert.equal(response.record.supplierId, "supplier-inactive");
});

test("existing ID or changed inactive supplier returns a conflict without overwriting supplier", async () => {
  const { service, store } = setup();
  await service.saveSupplier(
    "supplier-new-001",
    body(supplier("קיים", false)),
    uid,
  );
  await assert.rejects(
    service.saveInvoice("invoice-new-001", invoice("שם אחר"), uid),
    (e) => e.code === "SUPPLIER_EXISTS",
  );
  await assert.rejects(
    service.saveInvoice(
      "invoice-new-001",
      body({
        ...inv(),
        supplierId: "supplier-new-001",
        reactivateSupplier: { expectedVersion: 2 },
      }),
      uid,
    ),
    (e) => e.code === "SUPPLIER_CHANGED",
  );
  assert.equal((await store.get("suppliers/supplier-new-001")).name, "קיים");
  assert.equal((await store.get("suppliers/supplier-new-001")).active, false);
});

test("standalone supplier creation, rename and reactivation also enforce normalized uniqueness against legacy records", async () => {
  const { service, store } = setup();
  // Simulate a record saved before this feature; no migration or extra supplier field is needed.
  await store.transaction(async (tx) =>
    tx.set("suppliers/legacy-supplier", {
      ...supplier("ACME בע״מ"),
      id: "legacy-supplier",
      version: 1,
    }),
  );
  await assert.rejects(
    service.saveSupplier("supplier-new-001", body(supplier(" acme ")), uid),
    (e) => e.code === "SUPPLIER_EXISTS",
  );
  await service.saveSupplier("supplier-new-002", body(supplier("אחר")), uid);
  await assert.rejects(
    service.saveSupplier(
      "supplier-new-002",
      body(supplier("acme ח.פ."), 1),
      uid,
    ),
    (e) => e.code === "SUPPLIER_EXISTS",
  );
  await store.transaction(async (tx) =>
    tx.set("suppliers/legacy-inactive", {
      ...supplier("acme", false),
      id: "legacy-inactive",
      version: 1,
    }),
  );
  await assert.rejects(
    service.saveSupplier("legacy-inactive", body(supplier("acme"), 1), uid),
    (e) => e.code === "SUPPLIER_EXISTS",
  );
});
