import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { AccountingService } from "../src/invoices.js";
import { createHandler } from "../src/http.js";
import { MemoryStore, MemoryStorage, config } from "./helpers.js";

const date = "2026-09-13", uid = "owner-cash-test";
const mutation = (expectedVersion, data) => ({ expectedVersion, mutationId: randomUUID(), ...(data ? { data } : {}) });
const amounts = (cashAgorot = 15000, ravKavAgorot = 60000) => ({ date, cashAgorot, ravKavAgorot, notes: "" });

test("cash deletion is versioned, audited, replayable and never erases another day's closing", async () => {
  const store = new MemoryStore(), service = new AccountingService(store);
  const original = (await service.saveCash(date, mutation(0, amounts()), uid)).record;
  const otherDate = "2026-09-14";
  await service.saveCash(otherDate, mutation(0, { ...amounts(20000, null), date: otherDate }), uid);
  const other = await store.get("dailyCash/" + otherDate);
  const before = (await store.get("system/dataVersion")).version;
  const request = mutation(1);
  const deleted = await service.deleteCash(date, request, uid);
  assert.ok(deleted.record.deletedAt);
  assert.equal(deleted.record.version, 2);
  assert.equal(deleted.record.cashAgorot, 15000);
  assert.equal(deleted.record.ravKavAgorot, 60000);
  assert.equal(deleted.record.updatedBy, uid);
  assert.deepEqual((await store.get("mutations/" + request.mutationId)).before, original);
  assert.equal((await store.get("system/dataVersion")).version, before + 1);
  const replay = await service.deleteCash(date, request, uid);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.record, deleted.record);
  assert.equal((await store.get("system/dataVersion")).version, before + 1);
  assert.deepEqual(await store.get("dailyCash/" + otherDate), other);
  assert.equal((await service.all("invoices")).length, 0);
  const changed = (await service.all("changes")).filter(c => c.entity === "dailyCash/" + date);
  assert.ok(changed.length >= 1);
});

test("a deleted cash date can be entered afresh only with its current tombstone version", async () => {
  const store = new MemoryStore(), service = new AccountingService(store);
  await service.saveCash(date, mutation(0, amounts()), uid);
  await assert.rejects(service.deleteCash(date, mutation(0), uid), { code: "VERSION_CONFLICT" });
  await service.deleteCash(date, mutation(1), uid);
  await assert.rejects(service.saveCash(date, mutation(1, amounts(9900, null)), uid), { code: "VERSION_CONFLICT" });
  await assert.rejects(service.saveCash(date, mutation(2, amounts(9900, null)), uid), { code: "VERSION_CONFLICT" });
  await assert.rejects(service.saveCash(date, mutation(0, amounts(9900, null)), uid, true), { code: "VERSION_CONFLICT" });
  const replace = mutation(2, amounts(0, null));
  const fresh = await service.saveCash(date, replace, uid, true);
  assert.equal(fresh.record.deletedAt, null);
  assert.equal(fresh.record.version, 3);
  assert.equal(fresh.record.cashAgorot, 0);
  assert.equal(fresh.record.ravKavAgorot, null);
  assert.equal((await service.saveCash(date, replace, uid, true)).replayed, true);
  await assert.rejects(service.saveCash(date, mutation(3, amounts()), uid, true), { code: "NOT_DELETED" });
  await assert.rejects(service.deleteCash(date, mutation(1), uid), { code: "VERSION_CONFLICT" });
  await assert.rejects(service.deleteCash("2026-02-30", mutation(0), uid), { code: "INVALID_DATE" });
  await assert.rejects(service.deleteCash("2026-09-15", mutation(0), uid), { code: "NOT_FOUND" });
});

test("cancelling a cash deletion fences late requests and reports an already committed deletion", async () => {
  const store = new MemoryStore(), service = new AccountingService(store);
  await service.saveCash(date, mutation(0, amounts()), uid);
  const request = mutation(1), entity = "daily-cash/" + date;
  assert.equal((await service.cancelMutation(request.mutationId, { entity }, uid)).status, "cancelled");
  await assert.rejects(service.deleteCash(date, request, uid), { code: "MUTATION_CANCELLED" });
  assert.equal((await store.get("dailyCash/" + date)).deletedAt, null);
  const committed = mutation(1);
  await service.deleteCash(date, committed, uid);
  const answer = await service.cancelMutation(committed.mutationId, { entity }, uid);
  assert.equal(answer.status, "committed");
  assert.ok(answer.record.deletedAt);
});

test("cash HTTP deletion/restore require owner auth and sync carries the tombstone", async t => {
  const store = new MemoryStore();
  const server = createServer(createHandler({ store, storage: new MemoryStorage(), config, log() {},
    verifyToken: async token => ({ uid, phone_number: token === "valid-owner-token" ? config.allowedPhone : "+15555550999", firebase: { sign_in_provider: "phone" } }),
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const request = (path, method = "GET", body, token = "valid-owner-token") => fetch(`http://127.0.0.1:${server.address().port}/api/v1/${path}`, {
    method, headers: { Authorization: token ? "Bearer " + token : "", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const path = "daily-cash/" + date;
  assert.equal((await request(path, "PUT", mutation(0, amounts()))).status, 200);
  for (const [method, endpoint, body] of [["DELETE", path, mutation(1)], ["POST", path + "/restore", mutation(1, amounts())]]) {
    assert.equal((await request(endpoint, method, body, "")).status, 401);
    assert.equal((await request(endpoint, method, body, "valid-other-token" )).status, 403);
  }
  assert.equal((await request(path, "DELETE", mutation(0))).status, 409);
  const deletion = mutation(1);
  assert.equal((await request(path, "DELETE", deletion)).status, 200);
  assert.equal((await (await request(path, "DELETE", deletion)).json()).replayed, true);
  const full = await (await request("sync")).json();
  assert.ok(full.dailyCash[0].deletedAt);
  const incremental = await (await request("sync?since=1")).json();
  assert.ok(incremental.dailyCash.some(r => r.id === date && r.deletedAt));
  assert.equal((await request(path + "/restore", "POST", mutation(2, amounts(20000, null)))).status, 200);
  const fresh = await (await request(path)).json();
  assert.equal(fresh.deletedAt, null);
  assert.equal(fresh.cashAgorot, 20000);
  assert.equal(fresh.ravKavAgorot, null);
});
