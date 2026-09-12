import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import {
  validateInvoiceExtraction,
  validateReportExtraction,
  hasExplicitZeroVat,
} from "../src/ai-schema.js";
import { callLuna, ScanService } from "../src/ai.js";
import { DocumentService, validateFiles } from "../src/files.js";
import { authorize } from "../src/auth.js";
import { configFromEnv } from "../src/config.js";
import { MemoryStore, MemoryStorage, config, aiResult } from "./helpers.js";

function osemExtraction() {
  const result = aiResult();
  Object.assign(result, { supplierName: "אסם", subtotalAgorot: 338550, vatAgorot: 60941, totalAgorot: 399500, finalAgorot: 399500 });
  Object.assign(result.evidence, {
    supplierName: "אסם", subtotalAgorot: "ערך תעודה לאחר הנחות 3385.50",
    vatAgorot: "מע״מ 609.41", totalAgorot: "סה״כ לתשלום 3995.00", finalAgorot: "סה״כ לתשלום 3995.00",
  });
  result.deductions = [
    { label: "הנחה", amountAgorot: 93728, includedInTotal: true, evidence: 'ערך תעודה לפי מחירון 4322.78 / סה"כ הנחה 937.28 / ערך תעודה לאחר הנחות 3385.50' },
    { label: "הפרש עיגול", amountAgorot: 9, includedInTotal: true, evidence: "הפרש עיגול 0.09" },
  ];
  return result;
}
test("printed Osem rounding reconciles exact agorot; document discount is already in subtotal", () => {
  const raw = osemExtraction(), result = validateInvoiceExtraction(raw);
  assert.deepEqual(result, raw);
  assert.equal(result.needsReview, false);
  assert.equal(result.deductions.filter(d => d.label === "הנחה").length, 1);
  assert.equal(result.subtotalAgorot + result.vatAgorot + 9, result.totalAgorot);
  assert.deepEqual(raw, osemExtraction(), "validation must not mutate the source");
});
test("rounding supports printed negative signs and never invents a balancing sign", () => {
  for (const evidence of ["עיגול -0.09", "rounding −0.09", "הפרש עיגול 0.09-"]) {
    const raw = osemExtraction();
    raw.totalAgorot = raw.finalAgorot = 399482;
    Object.assign(raw.deductions[1], { amountAgorot: -9, evidence });
    assert.deepEqual(validateInvoiceExtraction(raw), raw);
  }
  const raw = osemExtraction();
  raw.deductions[1].amountAgorot = -9;
  assert.equal(validateInvoiceExtraction(raw).needsReview, true);
});
test("no tolerance for missing, unrelated, ambiguous, excluded or misread rounding evidence", () => {
  const variants = [
    d => { d.evidence = null; },
    d => { d.evidence = "סה״כ 0.09"; },
    d => { d.evidence = "הפרש עיגול 0.90"; },
    d => { d.evidence = "הפרש עיגול\nסה״כ 0.09"; },
    d => { d.evidence = "הפרש עיגול 0.09 סה״כ 3995.00"; },
    d => { d.evidence = "הפרש עיגול -0.09"; },
    d => { d.includedInTotal = false; },
    d => { d.includedInTotal = null; },
    d => { d.label = "הנחה"; },
    d => { d.amountAgorot = null; },
  ];
  for (const change of variants) {
    const raw = osemExtraction(); change(raw.deductions[1]);
    const result = validateInvoiceExtraction(raw);
    assert.equal(result.needsReview, true, JSON.stringify(raw.deductions[1]));
    assert.ok(result.uncertainFields.includes("totalAgorot"));
    assert.equal(result.totalAgorot, 399500);
    assert.equal(result.vatAgorot, 60941);
    assert.equal(result.subtotalAgorot, 338550);
  }
  const raw = osemExtraction(); raw.deductions.pop();
  assert.equal(validateInvoiceExtraction(raw).needsReview, true);
});
test("multi-page Osem response passes through the request validator with the new instructions", async () => {
  let sent;
  const expected = osemExtraction();
  const result = await callLuna(
    Array.from({ length: 3 }, () => ({ mime: "image/jpeg", bytes: Buffer.from("fixture") })),
    "invoice", config, async (_url, options) => {
      sent = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(expected) }] }] }) };
    },
  );
  // The supplier is resolved here, against the store's own number, so the app
  // receives the answer rather than the configuration it would need to repeat.
  assert.deepEqual(result, { ...expected, readings: 2, supplierTaxIds: ["511091753"], groupTaxIds: [] },
    "readings that agree leave the extraction exactly as it was read");
  assert.equal(sent.input[0].content.filter(c => c.type === "input_image").length, 3);
  assert.match(sent.instructions, /Ignore running customer balance lines/);
  assert.match(sent.instructions, /יתרת לקוח ללא חשבונית זו/);
  assert.match(sent.instructions, /AFTER-discount, pre-VAT figure/);
  assert.match(sent.instructions, /Do not subtract it a second time/);
  assert.match(sent.instructions, /Never fabricate a rounding line/);
  assert.match(sent.instructions, /Overlapping photos/);
  // Each of these rules is here because a real supplier invoice needed it.
  assert.match(sent.instructions, /business that ISSUED the document/);
  assert.match(sent.instructions, /שם מחלק, נהג, סוכן, איש מכירות, מוכרן/);
  assert.match(sent.instructions, /Do not decide which one is the supplier/);
  assert.match(sent.instructions, /MINUS AFTER the digits/);
  assert.match(sent.instructions, /may be printed NEGATIVE and therefore ADD/);
  assert.match(sent.instructions, /percentage rather than shekels/);
  assert.match(sent.instructions, /is a disclosure, not a deduction/);
  assert.match(sent.instructions, /דף X מתוך Y/);
  assert.match(sent.instructions, /only what the reader can answer/);
  assert.match(sent.instructions, /which printed company number belongs to whom/);
});
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
test("notes about numbers the review cannot correct are dropped; anything else survives", () => {
  const a = aiResult();
  a.warnings = [
    "יש לאמת ידנית את שיוך מספרי הלקוח ואת כל המזהים הנוספים המודפסים במסמך, שחלקם אינם קריאים לחלוטין.",
    "כתובת הלקוח ומספר ההזמנה אינם קריאים.",
    "  הצילום אינו ברור.  ",
    "הצילום אינו ברור.",
    "ח.פ של הספק אינו קריא במלואו.",
    "המסמך אינו קריא כלל.",
    "   ",
  ];
  const kept = validateInvoiceExtraction(a).warnings;
  assert.deepEqual(kept, [
    "הצילום אינו ברור.",
    "ח.פ של הספק אינו קריא במלואו.",
    "המסמך אינו קריא כלל.",
  ], "a note naming a field, the photograph or nothing we recognise is kept");
  // A note this file derives from the numbers is never filtered away with them.
  const b = aiResult();
  b.warnings = ["יש לוודא ידנית את מספר ההזמנה המודפס במסמך."];
  b.vatAgorot = 1750;
  const derived = validateInvoiceExtraction(b).warnings;
  assert.equal(derived.length, 1);
  assert.match(derived[0], /אינו שווה לסכום הכולל/);
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
  assert.equal(calls, config.readingsPerScan, "one call per reading, and no retry");
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
  assert.equal(calls, config.readingsPerScan, "a failed reading is never retried");
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

test("a fractional zero is not evidence of zero VAT", () => {
  for (const printed of ["מע״מ 18.0", "מע״מ 18.00", "VAT 100.0", "סכום 0.00"]) {
    const raw = aiResult();
    raw.vatAgorot = 0;
    raw.evidence.vatAgorot = printed;
    assert.equal(validateInvoiceExtraction(raw).vatAgorot, null);
  }
  const raw = aiResult();
  raw.vatAgorot = 0;
  raw.evidence.vatAgorot = "ללא מע״מ";
  assert.equal(validateInvoiceExtraction(raw).vatAgorot, 0);
});
test("production rejects emulator configuration", () => {
  assert.throws(() =>
    configFromEnv({
      NODE_ENV: "production",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    }),
  );
});
test("zero VAT evidence ties the zero to its own label, without borrowing another line", () => {
  for (const evidence of [
    "מע״מ 18% … 0 פריטים",
    "מע״מ 18%\nסה״כ 0.00",
    "VAT items 0",
    "taxable 0",
    "VAT: 0.18",
    "VAT: 0,180",
    "VAT 0 items",
  ])
    assert.equal(hasExplicitZeroVat(evidence), false, evidence);
  for (const evidence of [
    "עוסק פטור",
    "מ.ע.מ 0.00",
    "מע״מ: ₪ 0.00",
    "VAT 0%",
    "ללא מע״מ",
    "VAT exempt",
  ])
    assert.equal(hasExplicitZeroVat(evidence), true, evidence);
});
test("24MP and 48MP phone photos are safely oriented, resized and encoded for storage", async () => {
  for (const [width, height] of [
    [5712, 4284],
    [8064, 6048],
  ]) {
    const bytes = await sharp({
      create: { width, height, channels: 3, background: "#fff" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const [file] = await validateFiles([
      { name: "phone.jpg", mime: "image/jpeg", data: bytes.toString("base64") },
    ]);
    const m = await sharp(file.bytes).metadata();
    assert.equal(m.width, 1875);
    assert.equal(m.height, 2500);
    assert.equal(m.orientation, undefined);
    assert.equal(file.mime, "image/jpeg");
  }
});
test("eight phone pages fit the upload ceiling after resizing; PDFs are kept byte-for-byte", async () => {
  const bytes = await sharp({
    create: { width: 5712, height: 4284, channels: 3, background: "#fff" },
  })
    .jpeg()
    .toBuffer();
  const files = await validateFiles(
    Array.from({ length: 8 }, (_, i) => ({
      name: `page-${i}.jpg`,
      mime: "image/jpeg",
      data: bytes.toString("base64"),
    })),
  );
  assert.equal(files.length, 8);
  assert.ok(files.reduce((n, f) => n + f.bytes.length, 0) < 12 * 1024 * 1024);
  assert.ok(files.every((f) => f.bytes.length < bytes.length));
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const original = Buffer.from(await pdf.save());
  const [kept] = await validateFiles([
    {
      name: "doc.pdf",
      mime: "application/pdf",
      data: original.toString("base64"),
    },
  ]);
  assert.deepEqual(kept.bytes, original);
});
test("normalization keeps white transparency and rejects decompression bombs", async () => {
  const png = await sharp({
    create: {
      width: 10,
      height: 20,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const [file] = await validateFiles([
    {
      name: "transparent.png",
      mime: "image/png",
      data: png.toString("base64"),
    },
  ]);
  assert.equal(file.mime, "image/jpeg");
  assert.match(file.name, /\.jpg$/);
  const { data, info } = await sharp(file.bytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 10);
  assert.equal(info.height, 20);
  assert.ok(data.every((v) => v >= 250));
  const huge = await sharp({
    create: { width: 10000, height: 8001, channels: 3, background: "#fff" },
  })
    .jpeg()
    .toBuffer();
  await assert.rejects(
    validateFiles([
      { name: "huge.jpg", mime: "image/jpeg", data: huge.toString("base64") },
    ]),
    (e) => e.code === "INVALID_FILE",
  );
});

const luna = (values) => {
  let call = 0;
  return async () => {
    const value = values[Math.min(call++, values.length - 1)];
    if (value instanceof Error) throw value;
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }],
      }),
    };
  };
};
const pdf = [{ mime: "application/pdf", bytes: Buffer.from("%PDF-") }];
test("two readings of one photograph: what they agree on stays, what they dispute is asked", async () => {
  const first = aiResult(), second = aiResult();
  // The same printed number, read twice, differently.
  second.documentNumber = "1234";
  second.evidence.documentNumber = "חשבונית 1234";
  const result = await callLuna(pdf, "invoice", config, luna([first, second]));
  assert.equal(result.readings, 2);
  assert.equal(result.documentNumber, null, "neither reading is presented as the printed one");
  assert.equal(result.evidence.documentNumber, null, "no excerpt stands behind an emptied field");
  assert.ok(result.uncertainFields.includes("documentNumber"));
  assert.equal(result.needsReview, true);
  assert.equal(result.totalAgorot, 11800, "a figure both readings reached is kept");
  assert.equal(result.invoiceDate, "2026-09-10");
});
test("the same supplier written two ways is not a disagreement; a different one is", async () => {
  const first = aiResult(), second = aiResult();
  second.supplierName = 'ספק בדיקה בע"מ';
  const same = await callLuna(pdf, "invoice", config, luna([first, second]));
  assert.equal(same.supplierName, "ספק בדיקה", "a legal suffix is the same business");
  assert.ok(!same.uncertainFields.includes("supplierName"));
  const other = aiResult();
  other.supplierName = "ספק אחר";
  const differs = await callLuna(pdf, "invoice", config, luna([aiResult(), other]));
  assert.equal(differs.supplierName, null);
  assert.ok(differs.uncertainFields.includes("supplierName"));
});
test("disputed deductions keep the lines that were read and ask about each one", async () => {
  const first = aiResult(), second = aiResult();
  const line = { label: "הנחה", amountAgorot: 500, includedInTotal: true, evidence: "הנחה 5.00" };
  first.deductions = [line];
  second.deductions = [{ ...line, amountAgorot: 900, evidence: "הנחה 9.00" }];
  const result = await callLuna(pdf, "invoice", config, luna([first, second]));
  assert.deepEqual(result.deductions, first.deductions, "a discount is never dropped in silence");
  assert.ok(result.uncertainFields.includes("deductions"));
  assert.equal(result.needsReview, true);
});
test("a reading that fails is not the scan failing; only no reading at all is", async () => {
  const alone = await callLuna(pdf, "invoice", config, luna([Error("offline"), aiResult()]));
  assert.equal(alone.readings, 1, "the reading that answered is used");
  assert.equal(alone.documentNumber, "123");
  await assert.rejects(
    callLuna(pdf, "invoice", config, luna([Error("offline")])),
    (e) => e.code === "AI_TIMEOUT",
  );
});
test("notes and identifiers from both readings are merged without repeating or guessing", async () => {
  const first = aiResult(), second = aiResult();
  first.warnings = ["הצילום אינו ברור."];
  second.warnings = ["הצילום אינו ברור.", "חלק מהמסמך חתוך בצילום."];
  second.identifiers = [first.identifiers[0]];
  const result = await callLuna(pdf, "invoice", config, luna([first, second]));
  assert.deepEqual(result.warnings, ["הצילום אינו ברור.", "חלק מהמסמך חתוך בצילום."]);
  assert.deepEqual(
    result.identifiers.map((i) => i.value),
    [first.identifiers[0].value],
    "only an identifier both readings saw survives",
  );
});
