import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
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
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  const scan = await api(
    "scan-invoice",
    { jobId: randomUUID(), attachmentIds: [doc.id] },
    "POST",
  );
  assert.equal(scan.status, 200, await scan.clone().text());
  assert.equal((await scan.json()).result.vatAgorot, 1800);
  const snapshot = await (await api("sync")).json();
  assert.equal(snapshot.invoices.length, 1);
  assert.equal(snapshot.dailyCash[0].ravKavAgorot, 6789);
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
  assert.ok(
    [401, 403].includes(
      (
        await fetch(storageUrl, {
          headers: { Authorization: "Firebase " + token },
        })
      ).status,
    ),
  );
  assert.ok([401, 403].includes((await fetch(storageUrl)).status));
});
