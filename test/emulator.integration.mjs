import { getFirestore, Timestamp } from "firebase-admin/firestore";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { getApps, deleteApp } from "firebase-admin/app";
import sharp from "sharp";
import { firebaseServices } from "../src/firebase.js";
import { createHandler } from "../src/http.js";
import { config, inv, aiResult } from "./helpers.js";

const projectId = "demo-kiri-accounting";
if (
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIREBASE_STORAGE_EMULATOR_HOST
)
  throw Error(
    "All three Firebase emulators are required. This test must never contact production.",
  );
process.env.GOOGLE_CLOUD_PROJECT = projectId;
const authHost = "http://" + process.env.FIREBASE_AUTH_EMULATOR_HOST;
async function requestJson(url, body) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function signIn(phoneNumber) {
  const { sessionInfo } = await requestJson(
    authHost +
      "/identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=emulator-key",
    { phoneNumber },
  );
  const codes = await requestJson(
    authHost + "/emulator/v1/projects/" + projectId + "/verificationCodes",
  );
  const entry = codes.verificationCodes.find(
    (c) => c.sessionInfo === sessionInfo,
  );
  assert.ok(entry);
  return (
    await requestJson(
      authHost +
        "/identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=emulator-key",
      { sessionInfo, code: entry.code },
    )
  ).idToken;
}

test("Firebase emulators: actual Admin auth, Firestore transactions, persistence, Storage and locked client rules", async (t) => {
  const localConfig = {
    ...config,
    projectId,
    bucket: projectId + ".appspot.com",
  };
  const services = firebaseServices(localConfig);
  t.after(() => Promise.all(getApps().map(deleteApp)));
  const server = createServer(
    createHandler({
      ...services,
      config: localConfig,
      invokeAI: async () => aiResult(),
      log: () => {},
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = "http://127.0.0.1:" + server.address().port;
  const token = await signIn(config.allowedPhone),
    other = await signIn("+15555550124");
  const api = async (
    path,
    body,
    method = body ? "PUT" : "GET",
    credential = token,
  ) => {
    const r = await fetch(origin + "/api/v1/" + path, {
      method,
      headers: {
        Authorization: "Bearer " + credential,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r;
  };
  assert.equal((await api("me", null, "GET", other)).status, 403);
  assert.equal((await api("me", null, "GET", "")).status, 401);
  assert.equal((await api("me")).status, 200);
  const supplierResponse = await api("suppliers/supplier-001", {
    expectedVersion: 0,
    mutationId: randomUUID(),
    data: { name: "ספק אמולטור", contact: "", notes: "", active: true },
  });
  assert.equal(
    supplierResponse.status,
    200,
    await supplierResponse.clone().text(),
  );
  const rawRoot = getFirestore().collection("stores").doc("family");
  const raw = async key => (await rawRoot.collection(key.split("/")[0]).doc(key.split("/")[1]).get()).data();
  const supplier = (await supplierResponse.json()).record;
  assert.equal(typeof supplier.createdAt, "number");
  const body = { expectedVersion: 0, mutationId: randomUUID(), data: inv() };
  const response = await api("invoices/invoice-001", body);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(
    (await (await api("invoices/invoice-001", body)).json()).replayed,
    true,
  );
  assert.equal(
    (await api("invoices/invoice-001", { ...body, mutationId: randomUUID() }))
      .status,
    409,
  );
  const paid = await api(
    "invoices/invoice-001/pay",
    {
      expectedVersion: 1,
      mutationId: randomUUID(),
      payment: {
        method: "check",
        paymentDate: "2026-09-10",
        checkNumber: "unit",
        checkDueDate: "2026-09-30",
        notes: "",
      },
    },
    "POST",
  );
  assert.equal(paid.status, 200, await paid.clone().text());
  assert.equal((await paid.json()).record.payment.paymentDate, "2026-09-10");
  assert.equal(
    (await (await api("invoices/invoice-001")).json()).payment.checkDueDate,
    "2026-09-30",
  );
  assert.equal(
    (
      await api("daily-cash/2026-09-10", {
        expectedVersion: 0,
        mutationId: randomUUID(),
        data: {
          date: "2026-09-10",
          cashAgorot: 12345,
          ravKavAgorot: 6789,
          notes: "",
        },
      })
    ).status,
    200,
  );
  const png = await sharp({
    create: { width: 24, height: 24, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  const uploaded = await api(
    "documents",
    {
      files: [
        { name: "test.png", mime: "image/png", data: png.toString("base64") },
      ],
    },
    "POST",
  );
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const doc = (await uploaded.json()).documents[0];
  const downloaded = await api("documents/" + doc.id);
  assert.equal(downloaded.status, 200);
  const storedBytes = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(createHash("sha256").update(storedBytes).digest("hex"), doc.id);
  assert.equal(doc.mime, "image/jpeg");
  const metadata = await sharp(storedBytes).metadata();
  assert.equal(metadata.width, 24);
  assert.equal(metadata.height, 24);
  const scan = await api(
    "scan-invoice",
    { jobId: randomUUID(), attachmentIds: [doc.id] },
    "POST",
  );
  assert.equal(scan.status, 200, await scan.clone().text());
  const scanResult = await scan.json();
  assert.equal(scanResult.result.vatAgorot, 1800);
  // Native Firestore types must survive update spreads, audit snapshots and scan replay.
  const paidRaw = await raw("invoices/invoice-001");
  assert.ok(paidRaw.createdAt instanceof Timestamp);
  assert.ok(paidRaw.payment.recordedAt instanceof Timestamp);
  const updateId = randomUUID();
  const updated = await api("invoices/invoice-001", { expectedVersion: 2, mutationId: updateId, data: { ...inv(), notes: "updated" } });
  assert.equal(updated.status, 200, await updated.clone().text());
  const updatedRaw = await raw("invoices/invoice-001");
  assert.ok(updatedRaw.createdAt.isEqual(paidRaw.createdAt));
  assert.ok(updatedRaw.payment.recordedAt.isEqual(paidRaw.payment.recordedAt));
  const audit = await raw("mutations/" + updateId);
  assert.ok(audit.before.createdAt instanceof Timestamp);
  assert.ok(audit.before.payment.recordedAt instanceof Timestamp);
  const deleted = await api("invoices/invoice-001", { expectedVersion: 3, mutationId: randomUUID() }, "DELETE");
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const deletedRaw = await raw("invoices/invoice-001");
  assert.ok(deletedRaw.deletedAt instanceof Timestamp);
  const restoreId = randomUUID();
  const restored = await api("invoices/invoice-001/restore", { expectedVersion: 4, mutationId: restoreId }, "POST");
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.ok((await raw("mutations/" + restoreId)).before.deletedAt instanceof Timestamp);
  const scanRaw = await raw("scanJobs/" + scanResult.id);
  assert.ok(scanRaw.createdAt instanceof Timestamp);
  assert.ok(scanRaw.completedAt instanceof Timestamp);
  const replay = await api("scan-invoice", { jobId: scanResult.id, attachmentIds: [doc.id] }, "POST");
  assert.equal(replay.status, 200);
  const replayed = await replay.json();
  assert.equal(typeof replayed.createdAt, "number");
  assert.equal(replayed.createdAt, scanResult.createdAt);
  const snapshot = await (await api("sync")).json();
  assert.equal(snapshot.invoices.length, 1);
  assert.equal(snapshot.dailyCash[0].ravKavAgorot, 6789);
  const inlineBody = {
    expectedVersion: 0,
    mutationId: randomUUID(),
    data: {
      ...inv(),
      supplierId: "supplier-inline-001",
      source: "ai",
      scanJobId: scanResult.id,
      newSupplier: { name: "ספק מסריקה אמולטור" },
    },
  };
  const inlineResponse = await api("invoices/invoice-inline-001", inlineBody);
  assert.equal(inlineResponse.status, 200, await inlineResponse.clone().text());
  const inline = await inlineResponse.json();
  assert.equal(inline.record.createdBy, supplier.createdBy);
  assert.equal(inline.relatedRecords[0].record.createdBy, supplier.createdBy);
  assert.equal(inline.relatedRecords[0].record.createdFrom, "scan");
  assert.equal(
    (await (await api("invoices/invoice-inline-001", inlineBody)).json())
      .replayed,
    true,
  );
  const delta = await (await api("sync?since=" + snapshot.version)).json();
  assert.equal(delta.invoices.length, 1);
  assert.equal(delta.suppliers.length, 1);
  assert.equal(delta.suppliers[0].id, inline.record.supplierId);
  const racing = await Promise.all(
    [1, 2].map((n) =>
      api("invoices/invoice-race-00" + n, {
        expectedVersion: 0,
        mutationId: randomUUID(),
        data: {
          ...inv(),
          supplierId: "supplier-race-00" + n,
          newSupplier: { name: n === 1 ? "שם מקביל בע״מ" : "שם מקביל" },
        },
      }),
    ),
  );
  assert.deepEqual(racing.map((r) => r.status).sort(), [200, 409]);
  const conflict = await racing.find((r) => r.status === 409).json();
  assert.equal(conflict.error.code, "SUPPLIER_EXISTS");
  assert.match(conflict.error.details.supplierId, /^supplier-race-00[12]$/);
  const afterRace = await (await api("sync")).json();
  assert.equal(
    afterRace.suppliers.filter((s) => s.id.startsWith("supplier-race-")).length,
    1,
  );
  assert.equal(
    afterRace.invoices.filter((s) => s.id.startsWith("invoice-race-")).length,
    1,
  );
  // Both requests read/write the same Firestore receipt. Exactly one may win.
  // Exercise the real transaction retries, not only the in-memory unit store.
  for (const n of [1, 2]) {
    const entity = "invoices/invoice-cancel-race-00" + n;
    const attempt = {
      expectedVersion: 0,
      mutationId: randomUUID(),
      data: { ...inv(), documentNumber: "CANCEL-RACE-" + n },
    };
    const cancelPath = "mutations/" + attempt.mutationId + "/cancel";
    const cancelRequest = () => api(cancelPath, { entity }, "POST");
    const saveRequest = () => api(entity, attempt);
    const results = await Promise.all(
      n === 1
        ? [cancelRequest(), saveRequest()]
        : [saveRequest(), cancelRequest()],
    );
    const [cancelled, saved] = n === 1 ? results : results.reverse();
    assert.equal(cancelled.status, 200, await cancelled.clone().text());
    const outcome = await cancelled.json();
    const persisted = await api(entity);
    if (outcome.status === "cancelled") {
      assert.equal(saved.status, 409, await saved.clone().text());
      assert.equal((await saved.json()).error.code, "MUTATION_CANCELLED");
      assert.equal(persisted.status, 404);
    } else {
      assert.equal(outcome.status, "committed");
      assert.equal(saved.status, 200, await saved.clone().text());
      assert.equal(persisted.status, 200);
      assert.equal(outcome.record.id, entity.split("/")[1]);
      assert.equal((await (await api(entity, attempt)).json()).replayed, true);
    }
    assert.equal((await (await cancelRequest()).json()).status, outcome.status);
  }
  const firestoreUrl =
    "http://" +
    process.env.FIRESTORE_EMULATOR_HOST +
    "/v1/projects/" +
    projectId +
    "/databases/(default)/documents/stores/family/invoices/invoice-001";
  assert.equal(
    (
      await fetch(firestoreUrl, {
        headers: { Authorization: "Bearer " + token },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(firestoreUrl)).status, 403);
  const storageUrl =
    "http://" +
    process.env.FIREBASE_STORAGE_EMULATOR_HOST +
    "/v0/b/" +
    localConfig.bucket +
    "/o/" +
    encodeURIComponent("documents/" + doc.id) +
    "?alt=media";
  assert.equal(
    (
      await fetch(storageUrl, {
        headers: { Authorization: "Firebase " + token },
      })
    ).status,
    403,
  );
  assert.ok([401, 403].includes((await fetch(storageUrl)).status));
});
