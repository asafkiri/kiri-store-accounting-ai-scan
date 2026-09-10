import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createHandler } from "../src/http.js";
import { MemoryStore, MemoryStorage, config, inv } from "./helpers.js";
async function setup(t) {
  const store = new MemoryStore(),
    logs = [];
  const server = createServer(
    createHandler({
      store,
      storage: new MemoryStorage(),
      config,
      log: (e) => logs.push(e),
      verifyToken: async (token) => {
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
        throw Error("invalid token");
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
