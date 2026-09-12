import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { AccountingService } from "../src/invoices.js";
import { DocumentService } from "../src/files.js";
import { DocumentLifecycle, DAY, PURGE_LOCK } from "../src/document-lifecycle.js";
import { MemoryStore, MemoryStorage, inv } from "./helpers.js";

const uid = "owner-deletion-test";
const body = (data, expectedVersion = 0) => ({
  data,
  expectedVersion,
  mutationId: randomUUID(),
});
const photo = (shade) =>
  sharp({ create: { width: 12, height: 12, channels: 3, background: shade } })
    .png()
    .toBuffer();
async function file(shade, name = "invoice.png") {
  const bytes = await photo(shade);
  return { name, mime: "image/png", data: bytes.toString("base64") };
}
async function setup({ retentionDays = 365, now = () => Date.now() } = {}) {
  const store = new MemoryStore(),
    storage = new MemoryStorage();
  const accounting = new AccountingService(store);
  const documents = new DocumentService(store, storage);
  const lifecycle = new DocumentLifecycle({
    store,
    storage,
    accounting,
    retentionDays,
    now,
  });
  await accounting.saveSupplier(
    "supplier-001",
    body({ name: "ספק לבדיקה", active: true, contact: "", notes: "" }),
    uid,
  );
  return { store, storage, accounting, documents, lifecycle };
}
// Photos are typed in with the invoice, so a saved invoice is the only thing
// that can hold a file. Keeping the fixture on that path keeps the reference
// count honest.
async function saveInvoice(accounting, id, attachmentIds, extra = {}) {
  const saved = await accounting.saveInvoice(
    id,
    body({
      ...inv(),
      documentNumber: id,
      attachmentIds,
      ...extra,
    }),
    uid,
  );
  return saved.record;
}

test("deleting a photo removes the invoice link, the record and the bytes", async () => {
  const { store, storage, accounting, documents, lifecycle } = await setup();
  const [record] = await documents.upload([await file("#fff")], uid);
  assert.equal(storage.rows.size, 1);
  const invoice = await saveInvoice(accounting, "invoice-001", [record.id]);
  const result = await lifecycle.deleteInvoiceDocument(
    invoice.id,
    record.id,
    { expectedVersion: invoice.version, mutationId: randomUUID() },
    uid,
  );
  assert.equal(result.fileDeleted, true);
  assert.equal(result.stillUsedBy, null);
  assert.deepEqual(result.record.attachmentIds, []);
  assert.equal(result.record.version, invoice.version + 1);
  assert.equal(await store.get("documents/" + record.id), null);
  assert.equal(storage.rows.size, 0, "the object itself must be gone");
  await assert.rejects(documents.load([record.id]), (e) => e.code === "FILE_MISSING");
  // The app learns about it through the same change feed as every other edit.
  const version = (await store.get("system/dataVersion")).version;
  assert.equal(
    (await store.list("changes")).at(-1).entity,
    "invoices/invoice-001",
  );
  assert.equal((await store.get("invoices/invoice-001")).version, invoice.version + 1);
  assert.ok(version > 0);
});

test("bytes shared by another invoice survive until the last invoice releases them", async () => {
  const { store, storage, accounting, documents, lifecycle } = await setup();
  const page = await file("#fff");
  const [record] = await documents.upload([page], uid);
  const [again] = await documents.upload([page], uid);
  assert.equal(again.id, record.id, "identical bytes are one document");
  assert.equal(storage.rows.size, 1);
  const first = await saveInvoice(accounting, "invoice-001", [record.id]);
  const second = await saveInvoice(accounting, "invoice-002", [record.id]);
  const kept = await lifecycle.deleteInvoiceDocument(
    first.id,
    record.id,
    { expectedVersion: first.version, mutationId: randomUUID() },
    uid,
  );
  assert.equal(kept.fileDeleted, false);
  assert.equal(kept.stillUsedBy, "invoice-002");
  assert.equal(storage.rows.size, 1, "the other invoice still needs the file");
  assert.ok(await store.get("documents/" + record.id));
  assert.deepEqual(
    (await store.get("invoices/invoice-002")).attachmentIds,
    [record.id],
  );
  const last = await lifecycle.deleteInvoiceDocument(
    second.id,
    record.id,
    { expectedVersion: second.version, mutationId: randomUUID() },
    uid,
  );
  assert.equal(last.fileDeleted, true);
  assert.equal(storage.rows.size, 0);
});

test("a retried deletion replays instead of dropping a second photo", async () => {
  const { accounting, documents, lifecycle, storage } = await setup();
  const [one] = await documents.upload([await file("#fff", "a.png")], uid);
  const [two] = await documents.upload([await file("#eee", "b.png")], uid);
  const invoice = await saveInvoice(accounting, "invoice-001", [one.id, two.id]);
  const request = { expectedVersion: invoice.version, mutationId: randomUUID() };
  const first = await lifecycle.deleteInvoiceDocument(invoice.id, one.id, request, uid);
  assert.deepEqual(first.record.attachmentIds, [two.id]);
  const replay = await lifecycle.deleteInvoiceDocument(invoice.id, one.id, request, uid);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.record.attachmentIds, [two.id]);
  assert.equal(storage.rows.size, 1, "the second photo must still be there");
});

test("a stale version, an unknown link and a bad id are refused", async () => {
  const { accounting, documents, lifecycle } = await setup();
  const [record] = await documents.upload([await file("#fff")], uid);
  const [other] = await documents.upload([await file("#ccc", "other.png")], uid);
  const invoice = await saveInvoice(accounting, "invoice-001", [record.id]);
  await assert.rejects(
    lifecycle.deleteInvoiceDocument(
      invoice.id,
      record.id,
      { expectedVersion: invoice.version + 3, mutationId: randomUUID() },
      uid,
    ),
    (e) => e.code === "VERSION_CONFLICT",
  );
  await assert.rejects(
    lifecycle.deleteInvoiceDocument(
      invoice.id,
      other.id,
      { expectedVersion: invoice.version, mutationId: randomUUID() },
      uid,
    ),
    (e) => e.code === "ATTACHMENT_NOT_LINKED",
  );
  await assert.rejects(
    lifecycle.deleteInvoiceDocument(
      invoice.id,
      "not-a-hash",
      { expectedVersion: invoice.version, mutationId: randomUUID() },
      uid,
    ),
    (e) => e.code === "INVALID_FILES",
  );
  await assert.rejects(
    lifecycle.deleteInvoiceDocument(
      "invoices-that-never-existed",
      record.id,
      { expectedVersion: 0, mutationId: randomUUID() },
      uid,
    ),
    (e) => e.code === "NOT_FOUND",
  );
});

test("releasing a photo from a deleted invoice leaves its document number free", async () => {
  const { store, accounting, documents, lifecycle, storage } = await setup();
  const [record] = await documents.upload([await file("#fff")], uid);
  const invoice = await saveInvoice(accounting, "invoice-001", [record.id]);
  const removed = await accounting.actInvoice(
    invoice.id,
    "delete",
    { expectedVersion: invoice.version, mutationId: randomUUID() },
    uid,
  );
  assert.ok(removed.record.deletedAt);
  const result = await lifecycle.deleteInvoiceDocument(
    invoice.id,
    record.id,
    { expectedVersion: removed.record.version, mutationId: randomUUID() },
    uid,
  );
  assert.equal(result.fileDeleted, true);
  assert.ok((await store.get("invoices/invoice-001")).deletedAt, "the tombstone stays");
  assert.equal(storage.rows.size, 0);
  // The number the tombstone gave up must not be re-claimed by the release.
  await saveInvoice(accounting, "invoice-002", [], { documentNumber: "invoice-001" });
  assert.equal((await store.get("invoices/invoice-002")).documentNumber, "invoice-001");
});

test("every photo is deleted once it is older than the retention period", async () => {
  let clock = Date.UTC(2027, 0, 10);
  const { store, storage, accounting, documents, lifecycle } = await setup({
    now: () => clock,
  });
  const [old] = await documents.upload([await file("#fff", "old.png")], uid);
  const [fresh] = await documents.upload([await file("#eee", "fresh.png")], uid);
  const keeper = await saveInvoice(accounting, "invoice-001", [old.id, fresh.id]);
  const closed = await saveInvoice(accounting, "invoice-002", [old.id]);
  await accounting.actInvoice(
    closed.id,
    "delete",
    { expectedVersion: closed.version, mutationId: randomUUID() },
    uid,
  );
  // Only the first photo is a year old; both invoices point at it.
  await store.transaction(async (tx) => {
    const record = await tx.get("documents/" + old.id);
    tx.set("documents/" + old.id, {
      ...record,
      createdAt: clock - 400 * DAY,
      uploadedAt: clock - 400 * DAY,
    });
  });
  const before = (await store.get("system/dataVersion")).version;
  const result = await lifecycle.purgeExpired();
  assert.deepEqual(result.deleted, [old.id]);
  assert.deepEqual(result.retained, []);
  assert.equal(result.released, 2, "both invoices had to release it first");
  assert.equal(await store.get("documents/" + old.id), null);
  assert.equal(storage.rows.size, 1, "only the expired object is deleted");
  assert.deepEqual(
    (await store.get("invoices/invoice-001")).attachmentIds,
    [fresh.id],
  );
  assert.deepEqual((await store.get("invoices/invoice-002")).attachmentIds, []);
  assert.ok((await store.get("invoices/invoice-002")).deletedAt, "a tombstone stays deleted");
  assert.ok(
    (await store.get("system/dataVersion")).version > before,
    "the app has to see the invoices change",
  );
  assert.ok(await store.get("documents/" + fresh.id));
  assert.equal(
    (await store.get("invoices/invoice-001")).version,
    keeper.version + 1,
  );
  // A second sweep on the same data finds nothing left to do.
  assert.deepEqual((await lifecycle.purgeExpired()).deleted, []);
});

test("the retention period is configurable and zero keeps every photo", async () => {
  let clock = Date.UTC(2027, 0, 10);
  const short = await setup({ retentionDays: 30, now: () => clock });
  const [record] = await short.documents.upload([await file("#fff")], uid);
  await saveInvoice(short.accounting, "invoice-001", [record.id]);
  await short.store.transaction(async (tx) => {
    const old = await tx.get("documents/" + record.id);
    tx.set("documents/" + record.id, {
      ...old,
      createdAt: clock - 40 * DAY,
      uploadedAt: clock - 40 * DAY,
    });
  });
  assert.deepEqual((await short.lifecycle.purgeExpired()).deleted, [record.id]);
  const off = await setup({ retentionDays: 0, now: () => clock });
  const [kept] = await off.documents.upload([await file("#fff")], uid);
  await off.store.transaction(async (tx) => {
    const old = await tx.get("documents/" + kept.id);
    tx.set("documents/" + kept.id, { ...old, uploadedAt: clock - 4000 * DAY });
  });
  const result = await off.lifecycle.purgeExpired();
  assert.equal(result.disabled, true);
  assert.ok(await off.store.get("documents/" + kept.id));
  assert.equal(await off.lifecycle.maybePurge(), null);
});

test("attaching the same photo to a new invoice restarts its year", async () => {
  let clock = Date.UTC(2027, 0, 10);
  const { store, accounting, documents, lifecycle } = await setup({ now: () => clock });
  const page = await file("#fff");
  const [record] = await documents.upload([page], uid);
  await store.transaction(async (tx) => {
    const old = await tx.get("documents/" + record.id);
    tx.set("documents/" + record.id, {
      ...old,
      createdAt: clock - 400 * DAY,
      uploadedAt: clock - 400 * DAY,
    });
  });
  const [reused] = await documents.upload([page], uid);
  assert.equal(reused.id, record.id);
  await saveInvoice(accounting, "invoice-001", [record.id]);
  assert.deepEqual((await lifecycle.purgeExpired()).deleted, []);
  assert.ok(await store.get("documents/" + record.id));
});

test("the sweep runs at most once per interval and records what it did", async () => {
  let clock = Date.UTC(2027, 0, 10);
  const { store, documents, lifecycle } = await setup({ now: () => clock });
  const [record] = await documents.upload([await file("#fff")], uid);
  await store.transaction(async (tx) => {
    const old = await tx.get("documents/" + record.id);
    tx.set("documents/" + record.id, { ...old, uploadedAt: clock - 400 * DAY });
  });
  const first = await lifecycle.maybePurge();
  assert.deepEqual(first.deleted, [record.id]);
  assert.equal((await store.get(PURGE_LOCK)).lastDeleted, 1);
  const [second] = await documents.upload([await file("#ddd", "second.png")], uid);
  await store.transaction(async (tx) => {
    const old = await tx.get("documents/" + second.id);
    tx.set("documents/" + second.id, { ...old, uploadedAt: clock - 400 * DAY });
  });
  assert.equal(await lifecycle.maybePurge(), null, "the interval has not passed");
  assert.ok(await store.get("documents/" + second.id));
  clock += 13 * 60 * 60 * 1000;
  assert.deepEqual((await lifecycle.maybePurge()).deleted, [second.id]);
});

test("a photo re-uploaded while its deletion runs keeps the new bytes", async () => {
  const { store, storage, documents, lifecycle } = await setup();
  const page = await file("#fff");
  const [record] = await documents.upload([page], uid);
  const original = storage.delete.bind(storage);
  let raced = null;
  // The window between marking the record and deleting the object: the same
  // photo is scanned again for another invoice at exactly that moment.
  storage.delete = async (key) => {
    storage.delete = original;
    [raced] = await documents.upload([page], uid);
    return original(key);
  };
  const result = await lifecycle.removeFile(record.id, uid);
  assert.equal(result.replaced, true, "the record that came back must stay");
  assert.equal(raced.id, record.id);
  assert.ok(await store.get("documents/" + record.id));
  const [loaded] = await documents.load([record.id]);
  assert.equal(
    createHash("sha256").update(loaded.bytes).digest("hex"),
    record.id,
    "the re-uploaded bytes must be readable, not the deleted object",
  );
  assert.equal(storage.rows.size, 1);
});

test("a purge that cannot finish leaves the invoice able to open its photo", async () => {
  let clock = Date.UTC(2027, 0, 10);
  const { store, storage, accounting, documents, lifecycle } = await setup({
    now: () => clock,
  });
  const [record] = await documents.upload([await file("#fff")], uid);
  const invoice = await saveInvoice(accounting, "invoice-001", [record.id]);
  await store.transaction(async (tx) => {
    const old = await tx.get("documents/" + record.id);
    tx.set("documents/" + record.id, { ...old, uploadedAt: clock - 400 * DAY });
  });
  storage.delete = async () => {
    throw Error("storage is unavailable");
  };
  const result = await lifecycle.purgeExpired();
  assert.deepEqual(result.deleted, []);
  assert.equal(result.retained.length, 1);
  // The link is already released, so nothing in the app points at a file that
  // cannot be opened; the record and object are cleaned up by the next sweep.
  assert.deepEqual((await store.get("invoices/invoice-001")).attachmentIds, []);
  assert.equal((await store.get("invoices/invoice-001")).version, invoice.version + 1);
  storage.delete = async (key) => {
    storage.rows.delete(key);
  };
  assert.deepEqual((await lifecycle.purgeExpired()).deleted, [record.id]);
  assert.equal(storage.rows.size, 0);
});

test("the retention setting is read from the environment and refuses nonsense", async () => {
  const { configFromEnv } = await import("../src/config.js");
  assert.equal(configFromEnv({}).documentRetentionDays, 365);
  assert.equal(configFromEnv({ DOCUMENT_RETENTION_DAYS: "" }).documentRetentionDays, 365);
  assert.equal(configFromEnv({ DOCUMENT_RETENTION_DAYS: " 2555 " }).documentRetentionDays, 2555);
  assert.equal(configFromEnv({ DOCUMENT_RETENTION_DAYS: "0" }).documentRetentionDays, 0);
  for (const value of ["-1", "365.5", "4000", "לא", "365d"])
    assert.throws(() => configFromEnv({ DOCUMENT_RETENTION_DAYS: value }), /DOCUMENT_RETENTION_DAYS/, value);
});
