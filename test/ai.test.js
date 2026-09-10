import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import {
  validateInvoiceExtraction,
  validateReportExtraction,
} from "../src/ai-schema.js";
import { callLuna, ScanService } from "../src/ai.js";
import { DocumentService, validateFiles } from "../src/files.js";
import { authorize } from "../src/auth.js";
import { configFromEnv } from "../src/config.js";
import { MemoryStore, MemoryStorage, config, aiResult } from "./helpers.js";
test("valid structured JSON preserved; absent VAT remains null and needsReview", () => {
  assert.deepEqual(validateInvoiceExtraction(aiResult()), aiResult());
  let a = aiResult();
  a.vatAgorot = null;
  a.evidence.vatAgorot = null;
  const b = validateInvoiceExtraction(a);
  assert.equal(b.vatAgorot, null);
  assert.equal(b.needsReview, true);
  assert.ok(b.uncertainFields.includes("vatAgorot"));
});
test("VAT zero needs explicit evidence; arithmetic mismatch never repairs printed amounts", () => {
  let a = aiResult();
  a.vatAgorot = 0;
  a.evidence.vatAgorot = null;
  assert.equal(validateInvoiceExtraction(a).vatAgorot, null);
  a.evidence.vatAgorot = "מע״מ 0.00";
  assert.equal(validateInvoiceExtraction(a).vatAgorot, 0);
  a = aiResult();
  a.vatAgorot = 1750;
  const b = validateInvoiceExtraction(a);
  assert.equal(b.vatAgorot, 1750);
  assert.equal(b.totalAgorot, 11800);
  assert.equal(b.needsReview, true);
  assert.ok(b.warnings.length);
});
test("AI wrong types/unknown keys, invalid dates and source-less fields are rejected or flagged", () => {
  assert.throws(() =>
    validateInvoiceExtraction({ ...aiResult(), vatAgorot: "18" }),
  );
  assert.throws(() =>
    validateInvoiceExtraction({ ...aiResult(), secret: "x" }),
  );
  const a = aiResult();
  a.invoiceDate = "2026-02-30";
  a.evidence.supplierName = null;
  const b = validateInvoiceExtraction(a);
  assert.equal(b.invoiceDate, null);
  assert.equal(b.supplierName, null);
  assert.ok(b.needsReview);
});
test("OpenAI request: exact Luna only, structured schema, no storage, and zero retries", async () => {
  let calls = 0,
    body;
  const f = async (_url, options) => {
    calls++;
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        output: [
          {
            content: [
              { type: "output_text", text: JSON.stringify(aiResult()) },
            ],
          },
        ],
      }),
    };
  };
  const r = await callLuna(
    [{ mime: "application/pdf", bytes: Buffer.from("%PDF-") }],
    "invoice",
    config,
    f,
  );
  assert.equal(calls, 1);
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.match(
    body.input[0].content[0].file_data,
    /data:application\/pdf;base64/,
  );
  assert.equal(r.totalAgorot, 11800);
  calls = 0;
  await assert.rejects(
    callLuna([], "invoice", config, async () => {
      calls++;
      throw Error("offline");
    }),
    (e) => e.code === "AI_TIMEOUT",
  );
  assert.equal(calls, 1);
  const incomplete = async () => ({
    ok: true,
    json: async () => ({ status: "incomplete", output: [] }),
  });
  await assert.rejects(
    callLuna([], "invoice", config, incomplete),
    (e) => e.code === "AI_INCOMPLETE",
  );
});
test("invalid/mismatched/animated uploads and too many pages are rejected; JPEG, PNG and PDF accepted", async () => {
  const png = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  const input = {
    name: "page.png",
    mime: "image/png",
    data: png.toString("base64"),
  };
  assert.equal((await validateFiles([input]))[0].pages, 1);
  await assert.rejects(
    validateFiles([{ ...input, mime: "image/jpeg" }]),
    (e) => e.code === "INVALID_FILE",
  );
  await assert.rejects(
    validateFiles([{ ...input, mime: "image/svg+xml" }]),
    (e) => e.code === "INVALID_FILE",
  );
  await assert.rejects(
    validateFiles(Array(9).fill(input)),
    (e) => e.code === "INVALID_FILES",
  );
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 9; i++) pdf.addPage();
  const bytes = await pdf.save();
  await assert.rejects(
    validateFiles([
      {
        name: "many.pdf",
        mime: "application/pdf",
        data: Buffer.from(bytes).toString("base64"),
      },
    ]),
    (e) => e.code === "TOO_MANY_PAGES",
  );
  pdf.removePage(8);
  assert.equal(
    (
      await validateFiles([
        {
          name: "ok.pdf",
          mime: "application/pdf",
          data: Buffer.from(await pdf.save()).toString("base64"),
        },
      ])
    )[0].pages,
    8,
  );
});
test("cross-instance scan lease, upload dedupe, completed-result recovery, failed-job no retry", async () => {
  const store = new MemoryStore(),
    storage = new MemoryStorage(),
    documents = new DocumentService(store, storage),
    png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
  const input = [
    { name: "page.png", mime: "image/png", data: png.toString("base64") },
  ];
  const uploaded = await documents.upload(input, "owner");
  await documents.upload(input, "owner");
  assert.equal(storage.rows.size, 1);
  let release,
    calls = 0;
  const invoke = async () => {
    calls++;
    await new Promise((r) => (release = r));
    return aiResult();
  };
  const one = new ScanService(store, documents, config, invoke),
    two = new ScanService(store, documents, config, invoke),
    body = {
      jobId: randomUUID(),
      attachmentIds: [uploaded[0].id],
      purpose: "invoice",
    };
  const active = one.scan(body, "owner");
  while (!release) await new Promise((r) => setImmediate(r));
  await assert.rejects(
    two.scan({ ...body, jobId: randomUUID() }, "owner"),
    (e) => e.code === "SCAN_IN_PROGRESS",
  );
  release();
  await active;
  assert.equal((await two.scan(body, "owner")).status, "completed");
  assert.equal(calls, 1);
  const failing = new ScanService(store, documents, config, async () => {
    throw Error("fail");
  });
  const b = { ...body, jobId: randomUUID() };
  await assert.rejects(failing.scan(b, "owner"));
  await assert.rejects(
    failing.scan(b, "owner"),
    (e) => e.code === "SCAN_FAILED",
  );
});
test("secure allowlist fails closed; optional UID narrows phone access; no model escalation", async () => {
  const decoded = {
    uid: "authorized-unit-user",
    phone_number: config.allowedPhone,
    firebase: { sign_in_provider: "phone" },
  };
  await assert.rejects(
    authorize("Bearer valid-unit-token", async () => decoded, {
      ...config,
      allowedPhone: "",
      allowedUid: "",
    }),
    (e) => e.code === "AUTH_NOT_CONFIGURED",
  );
  await assert.rejects(
    authorize("Bearer valid-unit-token", async () => decoded, {
      ...config,
      allowedUid: "other-unit-user",
    }),
    (e) => e.code === "FORBIDDEN",
  );
  await assert.rejects(
    authorize(
      "Bearer valid-unit-token",
      async () => ({ ...decoded, firebase: { sign_in_provider: "password" } }),
      config,
    ),
    (e) => e.code === "FORBIDDEN",
  );
  assert.throws(() => configFromEnv({ OPENAI_MODEL: "gpt-5.6-sol" }));
  assert.throws(() => configFromEnv({ ALLOWED_ORIGIN: "*" }));
});
test("optional accountant report preserves missing VAT", () => {
  const r = validateReportExtraction({
    rows: [
      {
        supplierName: "test",
        documentNumber: "3",
        invoiceDate: "2026-09-10",
        totalAgorot: 100,
        vatAgorot: null,
        evidence: "row",
        needsReview: false,
      },
    ],
    warnings: [],
    needsReview: false,
  });
  assert.equal(r.rows[0].vatAgorot, null);
  assert.equal(r.needsReview, true);
});

test('a fractional zero is not evidence of zero VAT',()=>{
  for(const printed of ['מע״מ 18.0','מע״מ 18.00','VAT 100.0','סכום 0.00']){
    const raw=aiResult();raw.vatAgorot=0;raw.evidence.vatAgorot=printed;
    assert.equal(validateInvoiceExtraction(raw).vatAgorot,null);
  }
  const raw=aiResult();raw.vatAgorot=0;raw.evidence.vatAgorot='ללא מע״מ';
  assert.equal(validateInvoiceExtraction(raw).vatAgorot,0);
});
test('production rejects emulator configuration',()=>{
  assert.throws(()=>configFromEnv({NODE_ENV:'production',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}));
});
