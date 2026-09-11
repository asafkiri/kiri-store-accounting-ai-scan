import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createHandler } from "../src/http.js";
import { MemoryStore, MemoryStorage, config, inv } from "./helpers.js";
async function setup(t, verifyOverride) {
  const store = new MemoryStore(),
    logs = [];
  const server = createServer(
    createHandler({
      store,
      storage: new MemoryStorage(),
      config,
      log: (e) => logs.push(e),
      verifyToken: async (token) => {
        if (verifyOverride) return verifyOverride(token);
        if (token === "valid-owner-token")
          return {
            uid: "owner",
            phone_number: config.allowedPhone,
            firebase: { sign_in_provider: "phone" },
          };
        if (token === "valid-other-token")
          return {
            uid: "other",
            phone_number: "+15555550124",
            firebase: { sign_in_provider: "phone" },
          };
        throw Object.assign(Error("invalid token"), {
          code: "auth/invalid-id-token",
        });
      },
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = "http://127.0.0.1:" + server.address().port;
  return {
    store,
    logs,
    request: (path, options = {}) =>
      fetch(url + path, {
        ...options,
        headers: {
          Authorization: "Bearer valid-owner-token",
          "Content-Type": "application/json",
          ...options.headers,
        },
      }),
  };
}
test("all sensitive endpoints reject missing/invalid token and unauthorized valid user", async (t) => {
  const { request, store } = await setup(t);
  for (const path of [
    "/api/v1/me",
    "/api/v1/sync",
    "/api/v1/invoices",
    "/api/v1/backup",
    "/api/v1/documents/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ]) {
    assert.equal(
      (await request(path, { headers: { Authorization: "" } })).status,
      401,
    );
    const invalid = await request(path, {
      headers: { Authorization: "Bearer invalid-test-token" },
    });
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.json()).error.code, "INVALID_TOKEN");
    assert.equal(
      (
        await request(path, {
          headers: { Authorization: "Bearer valid-other-token" },
        })
      ).status,
      403,
    );
  }
  assert.equal(store.rows.size, 0);
  assert.equal((await request("/api/v1/me")).status, 200);
  assert.equal(
    (await request("/health", { headers: { Authorization: "" } })).status,
    200,
  );
});
test("CORS exact origin, consistent errors, no credentials in logs", async (t) => {
  const { request, logs } = await setup(t);
  assert.equal(
    (
      await request("/api/v1/me", {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const r = await request("/api/v1/me", {
    headers: { Origin: config.allowedOrigins[0] },
  });
  assert.equal(
    r.headers.get("access-control-allow-origin"),
    config.allowedOrigins[0],
  );
  assert.match(r.headers.get("cache-control"), /no-store/);
  assert.ok(r.headers.get("x-request-id"));
  assert.ok(!JSON.stringify(logs).includes("valid-owner-token"));
  assert.ok(!JSON.stringify(logs).includes(config.allowedPhone));
});

test("cancellation HTTP endpoint requires the authorized user and fences only the requested mutation", async (t) => {
  const { request, store, logs } = await setup(t);
  const mutationId = randomUUID(),
    path = "/api/v1/mutations/" + mutationId + "/cancel";
  const options = {
    method: "POST",
    body: JSON.stringify({ entity: "suppliers/supplier-cancel" }),
  };
  for (const [Authorization, status] of [
    ["", 401],
    ["Bearer invalid-test-token", 401],
    ["Bearer valid-other-token", 403],
  ]) {
    assert.equal(
      (await request(path, { ...options, headers: { Authorization } })).status,
      status,
    );
  }
  assert.equal(store.rows.size, 0);
  const cancelled = await request(path, options);
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { status: "cancelled" });
  assert.match(cancelled.headers.get("cache-control"), /no-store/);
  const save = await request("/api/v1/suppliers/supplier-cancel", {
    method: "PUT",
    body: JSON.stringify({
      expectedVersion: 0,
      mutationId,
      data: { name: "ספק בדיקה", active: true, contact: "", notes: "" },
    }),
  });
  assert.equal(save.status, 409);
  assert.equal((await save.json()).error.code, "MUTATION_CANCELLED");
  assert.equal(await store.get("suppliers/supplier-cancel"), null);
  const invalid = await request(
    "/api/v1/mutations/" + randomUUID() + "/cancel",
    { method: "POST", body: JSON.stringify({ entity: "system/dataVersion" }) },
  );
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /valid-owner-token|supplier-cancel|mutationId/,
  );
});
test("HTTP core and incremental sync; saving same request twice creates once", async (t) => {
  const { request } = await setup(t);
  const call = async (path, data) => {
    const r = await request(path, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  await call("/api/v1/suppliers/supplier-001", {
    expectedVersion: 0,
    mutationId: randomUUID(),
    data: { name: "בדיקה", notes: "", contact: "", active: true },
  });
  const before = await (await request("/api/v1/sync")).json();
  const b = { expectedVersion: 0, mutationId: randomUUID(), data: inv() };
  await call("/api/v1/invoices/invoice-001", b);
  const replay = await call("/api/v1/invoices/invoice-001", b);
  assert.equal(replay.replayed, true);
  const delta = await (
    await request("/api/v1/sync?since=" + before.version)
  ).json();
  assert.equal(delta.full, false);
  assert.equal(delta.invoices.length, 1);
  assert.equal(delta.suppliers.length, 0);
  assert.equal(
    (await (await request("/api/v1/sync?since=" + delta.version)).json())
      .unchanged,
    true,
  );
  const month = await (await request("/api/v1/invoices?month=2026-09")).json();
  assert.equal(month.items.length, 1);
});
test("bad file and malformed JSON fail before any AI invocation", async (t) => {
  const { request } = await setup(t);
  let r = await request("/api/v1/documents", {
    method: "POST",
    body: JSON.stringify({
      files: [
        {
          name: "bad.png",
          mime: "image/png",
          data: Buffer.from("not an image").toString("base64"),
        },
      ],
    }),
  });
  assert.equal(r.status, 415);
  r = await request("/api/v1/invoices/invoice-001", {
    method: "PUT",
    body: "{",
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "INVALID_JSON");
});
test("authentication infrastructure failures return 503 and a safe category instead of expired login", async (t) => {
  for (const code of [
    "auth/insufficient-permission",
    "app/network-error",
    "auth/internal-error",
    "unknown-code",
    "auth/invalid-argument",
    "auth/argument-error",
  ]) {
    const { request, logs, store } = await setup(t, async () => {
      throw Object.assign(
        Error(
          "Error fetching public keys: private-token sk-test-secret +15555550123 data:image/jpeg;base64,AAAA",
        ),
        { code },
      );
    });
    const r = await request("/api/v1/me");
    assert.equal(r.status, 503, code);
    assert.equal((await r.json()).error.code, "AUTH_UNAVAILABLE");
    assert.equal(store.rows.size, 0);
    assert.ok(logs[0].errorMessage);
    assert.doesNotMatch(
      JSON.stringify(logs),
      /private-token|sk-test-secret|15555550123|base64|valid-owner-token/,
    );
  }
});
test("expired, revoked, malformed and disabled-user tokens stay rejected as 401", async (t) => {
  for (const code of [
    "auth/id-token-expired",
    "auth/id-token-revoked",
    "auth/invalid-id-token",
    "auth/user-disabled",
    "auth/user-not-found",
    "auth/invalid-argument",
    "auth/argument-error",
  ]) {
    const { request, logs } = await setup(t, async () => {
      throw Object.assign(Error("Decoding Firebase ID token failed."), {
        code,
      });
    });
    assert.equal((await request("/api/v1/me")).status, 401, code);
    assert.equal(logs[0].errorCategory, code);
  }
});
test("internal errors carry useful safe diagnostics, never raw exception content", async (t) => {
  const { request, store, logs } = await setup(t);
  store.get = async () => {
    throw Object.assign(
      Error(
        "Permission denied for private invoice and token sk-test-secret +15555550123",
      ),
      { code: 7 },
    );
  };
  const r = await request("/api/v1/sync");
  assert.equal(r.status, 500);
  assert.equal(logs[0].errorCategory, "permission-denied");
  assert.match(logs[0].errorMessage, /permission/i);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /private invoice|sk-test-secret|15555550123/,
  );
  assert.doesNotMatch((await r.json()).error.message, /טיוטה/);
});

test("actual Admin SDK malformed-token errors are rejected as 401 without contacting Firebase", async (t) => {
  const { initializeApp, deleteApp } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const app = initializeApp(
    { projectId: "demo-kiri-accounting" },
    "invalid-token-regression",
  );
  t.after(() => deleteApp(app));
  const { request, logs } = await setup(t, (token) =>
    getAuth(app).verifyIdToken(token, true),
  );
  const jwt = [
    { alg: "RS256", typ: "JWT" },
    { aud: "demo-kiri-accounting", iss: "https://securetoken.google.com/demo-kiri-accounting", sub: "fixture" },
  ].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".signature";
  for (const token of ["invalid-test-token", jwt]) {
    const response = await request("/api/v1/me", { headers: { Authorization: "Bearer " + token } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "INVALID_TOKEN");
    assert.equal(logs.at(-1).errorCategory, "auth/argument-error");
  }
});

test("supplier DELETE requires authorization, returns its tombstone and propagates through sync", async t => {
  const { request } = await setup(t);
  const path = "/api/v1/suppliers/supplier-delete";
  await request(path, { method: "PUT", body: JSON.stringify({ expectedVersion: 0, mutationId: randomUUID(), data: { name: "ספק זמני", active: true, notes: "", contact: "" } }) });
  const options = { method: "DELETE", body: JSON.stringify({ expectedVersion: 1, mutationId: randomUUID() }) };
  assert.equal((await request(path, { ...options, headers: { Authorization: "" } })).status, 401);
  assert.equal((await request(path, { ...options, headers: { Authorization: "Bearer valid-other-token" } })).status, 403);
  const response = await request(path, options);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).record.deletedAt);
  const sync = await (await request("/api/v1/sync?since=1")).json();
  assert.equal(sync.suppliers.length, 1);
  assert.equal(sync.suppliers[0].active, false);
  assert.ok(sync.suppliers[0].deletedAt);
});

test("supplier restoration and VAT settings use authorized versioned endpoints and incremental sync", async t => {
  const { request } = await setup(t);
  const supplierPath = "/api/v1/suppliers/supplier-restore";
  await request(supplierPath, { method: "PUT", body: JSON.stringify({ expectedVersion: 0, mutationId: randomUUID(), data: { name: "ספק לשחזור", active: true, notes: "", contact: "" } }) });
  await request(supplierPath, { method: "DELETE", body: JSON.stringify({ expectedVersion: 1, mutationId: randomUUID() }) });
  const restore = { method: "POST", body: JSON.stringify({ expectedVersion: 2, mutationId: randomUUID() }) };
  assert.equal((await request(supplierPath + "/restore", { ...restore, headers: { Authorization: "" } })).status, 401);
  assert.equal((await request(supplierPath + "/restore", restore)).status, 200);
  const settings = { method: "PUT", body: JSON.stringify({ expectedVersion: 0, mutationId: randomUUID(), data: { defaultVatBasisPoints: 1700 } }) };
  assert.equal((await request("/api/v1/settings/accounting", { ...settings, headers: { Authorization: "Bearer valid-other-token" } })).status, 403);
  assert.equal((await request("/api/v1/settings/accounting", settings)).status, 200);
  const sync = await (await request("/api/v1/sync?since=2")).json();
  assert.equal(sync.suppliers[0].deletedAt, null);
  assert.equal(sync.settings[0].defaultVatBasisPoints, 1700);
  assert.equal((await (await request("/api/v1/sync")).json()).settings[0].defaultVatBasisPoints, 1700);
});
