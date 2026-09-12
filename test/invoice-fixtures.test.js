import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoiceExtraction } from "../src/ai-schema.js";
import { supplierTaxIds } from "../src/tax-id.js";

const STORE = "069991651";

// Figures dictated from real supplier invoices; no customer document is stored
// here and no image is committed. Each row is the printed pre-VAT figure, the
// printed VAT, any separately printed rounding line, and the printed total.
// rounding is the signed agorot of a printed עיגול line already inside the total.
const PRINTED = [
  // supplier,               subtotal,  vat,     rounding, total
  ["תנובה מרלו״ג דרום", 138600, 24948, 2, 163550],
  ["ד.מ.ד שיווק (קפואים)", 338550, 60941, 9, 399500],
  ["אחים אוחיון", 456780, 82220, 0, 539000],
  ["גלובוס", 791220, 142420, 0, 933640],
  ["י. את א. ברמן", 1438591, 258946, 0, 1697537],
  ["המתוקים של שטרית", 131271, 23629, 0, 154900],
  ["טמפו (חשבונית/קבלה)", 388088, 69856, 0, 457944],
  ["טמפו (זיכוי)", 36440, 6559, 0, 42999],
  ["חביב את פרנק", 188644, 33956, 0, 222600],
  ["טופז", 73559, 13241, 0, 86800],
  ["ב.נווה ציון", 242349, 43623, 0, 285972],
  ["אוטופורס", 135856, 24454, 0, 160310],
  ["שטראוס פריטו לי", 314652, 56637, 0, 371289],
  ["019 מובייל", 54240, 9760, 0, 64000],
  ["בזק", 33977, 6116, 0, 40093],
  ["פריד אורן", 98304, 17695, 0, 115999],
  ["שיווק לביא", 191780, 34520, 0, 226300],
  ["צ׳יון תורג׳מן", 759915, 136785, 0, 896700],
  ["Mr. ICE", 35815, 6453, 32, 42300],
  ["לוי מאיר", 31176, 5612, 0, 36788],
  ["זיכוי (חמיץ/זנגלוק)", 11625, 2092, 0, 13717],
  ["חשבונית מרכזת SI266045233", 14900, 2682, 0, 17582],
];

function extraction({ subtotal, vat, total, rounding = 0, deductions = [], pagesPrinted = null, pagesRead = null }) {
  const rows = [...deductions];
  if (rounding)
    rows.push({
      label: "הפרש עיגול",
      amountAgorot: rounding,
      includedInTotal: true,
      evidence: `הפרש עיגול ${(Math.abs(rounding) / 100).toFixed(2)}${rounding < 0 ? "-" : ""}`,
    });
  return {
    supplierName: "ספק",
    documentNumber: "1",
    invoiceDate: "2026-06-01",
    documentType: "invoice",
    pagesPrinted,
    pagesRead,
    subtotalAgorot: subtotal,
    vatAgorot: vat,
    totalAgorot: total,
    finalAgorot: total,
    identifiers: [],
    deductions: rows,
    evidence: {
      supplierName: "ספק",
      documentNumber: "1",
      invoiceDate: "01/06/2026",
      subtotalAgorot: "סה״כ לפני מע״מ",
      vatAgorot: "מע״מ 18%",
      totalAgorot: "סה״כ לתשלום",
      finalAgorot: "סה״כ לתשלום",
    },
    uncertainFields: [],
    needsReview: false,
    warnings: [],
  };
}

test("every printed invoice reconciles, and the derivation recovers its pre-VAT figure", () => {
  for (const [supplier, subtotal, vat, rounding, total] of PRINTED) {
    assert.equal(subtotal + vat + rounding, total, supplier);
    // What the app fills when the pre-VAT figure is absent or discarded.
    assert.equal(total - vat - rounding, subtotal, supplier);
    const result = validateInvoiceExtraction(
      extraction({ subtotal, vat, total, rounding }),
    );
    assert.equal(result.subtotalAgorot, subtotal, supplier);
    assert.deepEqual(result.warnings, [], supplier);
  }
});

test("a pre-discount figure read as the subtotal is attributed and corrected", () => {
  // ד.מ.ד prints ערך תעודה לפי מחירון 4322.78 above ערך תעודה לאחר הנחות 3385.50.
  const result = validateInvoiceExtraction(
    extraction({
      subtotal: 432278,
      vat: 60941,
      total: 399500,
      rounding: 9,
      deductions: [
        {
          label: "סה״כ הנחה",
          amountAgorot: 93728,
          includedInTotal: true,
          evidence: 'ערך תעודה לפי מחירון 4322.78 / סה"כ הנחה 937.28',
        },
      ],
    }),
  );
  assert.equal(result.subtotalAgorot, 338550);
  assert.equal(result.needsReview, true);
  assert.ok(result.uncertainFields.includes("subtotalAgorot"));
  assert.match(result.warnings[0], /לפני ההנחה/);
});

test("a document that does not reconcile keeps its printed numbers and asks", () => {
  // Dubek and B2B are each one agora out on the page itself: 4561.86 + 821.13
  // is 5382.99 against a printed 5383.00. Nothing here identifies which figure
  // is wrong, so none of them is touched.
  for (const [supplier, subtotal, vat, total] of [
    ["דובק הפצה", 456186, 82113, 538300],
    ["ביטובי B2B", 64152, 11547, 75700],
  ]) {
    const result = validateInvoiceExtraction(extraction({ subtotal, vat, total }));
    assert.equal(result.subtotalAgorot, subtotal, supplier);
    assert.equal(result.vatAgorot, vat, supplier);
    assert.equal(result.totalAgorot, total, supplier);
    assert.equal(result.needsReview, true, supplier);
    assert.match(result.warnings[0], /אינו שווה לסכום הכולל/);
  }
});

test("a consolidated invoice without a printed VAT line stays empty for review", () => {
  // Marina's monthly חשבונית מס מרכזת prints only an inclusive column.
  const result = validateInvoiceExtraction(
    extraction({ subtotal: null, vat: null, total: 1689869 }),
  );
  assert.equal(result.vatAgorot, null);
  assert.equal(result.subtotalAgorot, null);
  assert.equal(result.needsReview, true);
  assert.ok(result.uncertainFields.includes("vatAgorot"));
});

test("each supplier resolves to its own entity identifier, never a group file", () => {
  const cases = [
    ["תנובה מרלו״ג דרום", [["ע.מ", "0570000745"]], ["570000745"]],
    ["ד.מ.ד שיווק", [["ע.מ", "783034218"]], ["783034218"]],
    ["אחים אוחיון", [["מספר עוסק", "511091753"]], ["511091753"]],
    [
      "גלובוס",
      [
        ["ח.פ", "513036434"],
        ["איחוד עסקים", "557904679"],
      ],
      ["513036434"],
    ],
    [
      "טמפו",
      [
        ["ח.פ.", "510901309"],
        ["ח.פ.", "513682625"],
        ['תיק איחוד עוסקים לעניין מע"מ מס', "557652815"],
      ],
      ["510901309", "513682625"],
    ],
    [
      "שטראוס גרופ",
      [
        ["מס חברה", "520003781"],
        ["ע.מ מאוחד", "557268851"],
      ],
      ["520003781"],
    ],
    [
      "שטראוס פריטו לי",
      [
        ["מס חברה", "510909450"],
        ["ע.מ מאוחד", "557268851"],
      ],
      ["510909450"],
    ],
    [
      "מרינה פטריות הגליל",
      [
        ["עוסק מורשה", "512830266"],
        ["מס. תיק ניכויים", "907244552"],
      ],
      ["512830266"],
    ],
    ["י. את א. ברמן", [["עוסק מורשה ח.פ.", "510018187"]], ["510018187"]],
    // Levi Meir prints eight digits; the dropped leading zero is restored.
    ["לוי מאיר", [["עוסק מורשה", "58323544"]], ["058323544"]],
    ["בזק", [["ח.פ", "520031931"]], ["520031931"]],
    ["Mr. ICE", [["ח.פ", "511175135"]], ["511175135"]],
    ["צ׳יון תורג׳מן", [["עוסק מורשה", "513910752"]], ["513910752"]],
    ["שיווק לביא", [["ח.פ", "510869597"]], ["510869597"]],
    ["אוטופורס", [["עוסק מורשה", "515984300"]], ["515984300"]],
    ["דובק הפצה", [["ח.פ", "514965839"]], ["514965839"]],
    ["ב.נווה ציון", [["ח.פ", "516285293"]], ["516285293"]],
    ["טופז", [["עוסק מורשה", "515367175"]], ["515367175"]],
    ["חביב את פרנק", [["ע.מ", "511532863"]], ["511532863"]],
    ["המתוקים של שטרית", [['ח"פ', "513045252"]], ["513045252"]],
  ];
  for (const [supplier, printed, expected] of cases) {
    const identifiers = [
      ...printed.map(([label, value]) => ({ label, value, party: "issuer" })),
      // Every one of these documents also prints the store's own number.
      { label: "ע.מ/ח.פ", value: STORE, party: "recipient" },
    ];
    assert.deepEqual(supplierTaxIds(identifiers, STORE), expected, supplier);
  }
});

test("a document handed fewer pages than it states says so instead of just asking", () => {
  // Strauss Group prints "דף 1 מתוך 2" with the total on the page that was not
  // photographed, so the amount is missing rather than illegible.
  const result = validateInvoiceExtraction(
    extraction({
      subtotal: 2092453,
      vat: 376642,
      total: null,
      pagesPrinted: 2,
      pagesRead: 1,
    }),
  );
  assert.equal(result.totalAgorot, null);
  assert.equal(result.needsReview, true);
  assert.ok(result.warnings.some((w) => /2 עמודים ונסרקו 1/.test(w)));
});

test("a complete document, or one that never states a page count, says nothing", () => {
  for (const pages of [
    { pagesPrinted: 2, pagesRead: 2 },
    { pagesPrinted: null, pagesRead: null },
    { pagesPrinted: null, pagesRead: 1 },
  ]) {
    const result = validateInvoiceExtraction(
      extraction({ subtotal: 456780, vat: 82220, total: 539000, ...pages }),
    );
    assert.deepEqual(result.warnings, [], JSON.stringify(pages));
  }
});
