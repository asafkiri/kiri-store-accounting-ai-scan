import { isRecord, date, MAX_MONEY } from "./validation.js";
import { fail } from "./errors.js";
import { creditSignIssues } from "./credit.js";
import { isValidTaxId } from "./tax-id.js";
const shekels = (agorot) => (agorot / 100).toFixed(2);
const nullableString = { type: ["string", "null"] };
const fields = [
  "supplierName",
  "documentNumber",
  "invoiceDate",
  "subtotalAgorot",
  "vatAgorot",
  "totalAgorot",
  "finalAgorot",
];
export const extractedFields = fields;
const evidenceSchema = {
  type: "object",
  properties: Object.fromEntries(fields.map((k) => [k, nullableString])),
  required: fields,
  additionalProperties: false,
};
const amountSchema = { type: ["integer", "null"] };
export const invoiceJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    ...fields,
    "documentType",
    "pagesPrinted",
    "pagesRead",
    "identifiers",
    "deductions",
    "evidence",
    "uncertainFields",
    "needsReview",
    "warnings",
  ],
  properties: {
    supplierName: nullableString,
    documentNumber: nullableString,
    invoiceDate: nullableString,
    documentType: {
      type: ["string", "null"],
      enum: ["invoice", "credit", "delivery", "receipt", null],
    },
    subtotalAgorot: amountSchema,
    vatAgorot: amountSchema,
    totalAgorot: amountSchema,
    finalAgorot: amountSchema,
    // "דף 1 מתוך 2" printed on a page whose second page was never photographed
    // leaves the total on the page that is missing, so the count is read and
    // compared here instead of the shortfall showing up as an unexplained
    // question about an amount that is not in front of anyone.
    pagesPrinted: { type: ["integer", "null"] },
    pagesRead: { type: ["integer", "null"] },
    // Transcribed, not interpreted: the printed label and digits of every
    // company/VAT number on the page. Which one is the supplier is decided here
    // against the store's own number, never by the model.
    identifiers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value", "party", "evidence"],
        properties: {
          label: nullableString,
          value: nullableString,
          party: {
            type: ["string", "null"],
            enum: ["issuer", "recipient", null],
          },
          evidence: nullableString,
        },
      },
    },
    deductions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "amountAgorot", "includedInTotal", "evidence"],
        properties: {
          label: nullableString,
          amountAgorot: amountSchema,
          includedInTotal: { type: ["boolean", "null"] },
          evidence: nullableString,
        },
      },
    },
    evidence: evidenceSchema,
    uncertainFields: {
      type: "array",
      items: { type: "string", enum: [...fields, "documentType"] },
    },
    needsReview: { type: "boolean" },
    warnings: { type: "array", items: { type: "string" } },
  },
};
export const reportJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rows", "needsReview", "warnings"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "supplierName",
          "documentNumber",
          "invoiceDate",
          "totalAgorot",
          "vatAgorot",
          "evidence",
          "needsReview",
        ],
        properties: {
          supplierName: nullableString,
          documentNumber: nullableString,
          invoiceDate: nullableString,
          totalAgorot: amountSchema,
          vatAgorot: amountSchema,
          evidence: nullableString,
          needsReview: { type: "boolean" },
        },
      },
    },
    needsReview: { type: "boolean" },
    warnings: { type: "array", items: { type: "string" } },
  },
};
// Independently validate all schema fields; never trust a schema-constrained model alone.
export function matchesSchema(value, schema) {
  if (value === null)
    return (
      schema.type === "null" ||
      (Array.isArray(schema.type) && schema.type.includes("null"))
    );
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (types.includes("object") && isRecord(value))
    return (
      (schema.required || []).every((k) => Object.hasOwn(value, k)) &&
      Object.keys(value).every(
        (k) =>
          Object.hasOwn(schema.properties, k) &&
          matchesSchema(value[k], schema.properties[k]),
      )
    );
  if (types.includes("array") && Array.isArray(value))
    return (
      value.length <= 200 && value.every((v) => matchesSchema(v, schema.items))
    );
  if (types.includes("integer"))
    return Number.isSafeInteger(value) && Math.abs(value) <= MAX_MONEY;
  if (types.includes("string"))
    return typeof value === "string" && value.length <= 2000;
  if (types.includes("boolean")) return typeof value === "boolean";
  return false;
}
export function hasExplicitZeroVat(evidence = "") {
  if (!evidence) return false;
  const label = String.raw`(?:מע[״"'׳]?מ|מ\.ע\.מ\.?|\bVAT\b|\btax\b)`;
  const exempt = new RegExp(
    String.raw`(?:עוסק\s+פטור|ללא\s*${label}|פטור\s*(?:מ)?${label}|\bno\s+VAT\b|\bVAT\s+exempt\b|\btax\s+exempt\b)`,
    "iu",
  );
  // A zero must immediately follow its own VAT label, on the same line.
  // No intervening rate, item count, decimal suffix or unrelated text.
  const zero = new RegExp(
    String.raw`${label}[^\S\r\n]*[:=–-]?[^\S\r\n]*₪?[^\S\r\n]*0(?:[.,]0{1,2})?(?![\d.,])[^\S\r\n]*(?:%|₪|ILS|ש[״"]ח)?[^\S\r\n]*(?=$|[\r\n;|])`,
    "iu",
  );
  return exempt.test(evidence) || zero.test(evidence);
}
const roundingLabel = /(?:עיגול|\brounding\b)/iu;
// A rounding allowance must come from its own printed line and exact signed
// amount. A label alone, an unrelated excerpt, or a balancing guess is not proof.
function hasPrintedRounding(deduction) {
  if (!roundingLabel.test(deduction.label || "") || deduction.amountAgorot === null) return false;
  return (deduction.evidence || "").split(/\r?\n/).some(line => {
    if (!roundingLabel.test(line)) return false;
    const amounts = [...line.matchAll(/(?<![\d.,])([+\-−]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?([\-−]?)(?![\d.,%])/gu)];
    if (amounts.length !== 1) return false;
    const [, sign, whole, fraction = "", suffix] = amounts[0];
    const agorot = Number(whole.replaceAll(",", "")) * 100 + Number(fraction.padEnd(2, "0"));
    return (sign === "-" || sign === "−" || suffix ? -agorot : agorot) === deduction.amountAgorot;
  });
}
export function validateInvoiceExtraction(raw) {
  if (!matchesSchema(raw, invoiceJsonSchema))
    fail(
      502,
      "AI_INVALID_RESPONSE",
      "הסריקה לא החזירה נתונים תקינים. אפשר להקליד את החשבונית ידנית.",
    );
  const result = structuredClone(raw),
    uncertain = new Set(raw.uncertainFields);
  if (!result.documentType) uncertain.add("documentType");
  for (const key of fields) {
    // An explicit printed excerpt is required for every populated field, particularly zero VAT.
    if (result[key] !== null && !result.evidence[key]?.trim()) {
      result[key] = null;
      uncertain.add(key);
    }
    if (result[key] === null) uncertain.add(key);
  }
  if (
    result.vatAgorot === 0 &&
    !hasExplicitZeroVat(result.evidence.vatAgorot)
  ) {
    result.vatAgorot = null;
    uncertain.add("vatAgorot");
  }
  if (result.invoiceDate)
    try {
      date(result.invoiceDate);
    } catch {
      result.invoiceDate = null;
      uncertain.add("invoiceDate");
    }
  if (result.deductions.length > 30)
    fail(
      502,
      "AI_INVALID_RESPONSE",
      "יש יותר מדי שורות הפחתה. יש לבדוק ידנית.",
    );
  let printedRoundingAgorot = 0;
  for (const d of result.deductions) {
    if (!d.evidence?.trim()) d.amountAgorot = null;
    if (d.amountAgorot === null || d.includedInTotal === null || !d.label)
      result.needsReview = true;
    if (roundingLabel.test(d.label || "") && d.includedInTotal === true) {
      if (hasPrintedRounding(d)) printedRoundingAgorot += d.amountAgorot;
      else result.needsReview = true;
    }
  }
  // A document that states how many pages it has, and was handed fewer, is
  // missing printed figures rather than illegible ones. Say which, so the fix
  // is to photograph the rest instead of to hunt for a number.
  const { pagesPrinted, pagesRead } = result;
  if (
    Number.isInteger(pagesPrinted) &&
    Number.isInteger(pagesRead) &&
    pagesPrinted > 0 &&
    pagesRead > 0 &&
    pagesRead < pagesPrinted
  ) {
    result.needsReview = true;
    result.warnings.push(
      `המסמך מצוין כבן ${pagesPrinted} עמודים ונסרקו ${pagesRead}. הסכומים שמופיעים בעמודים החסרים לא נקראו. יש לצלם את שאר העמודים.`,
    );
  }
  // An identifier needs its printed excerpt exactly as an amount does, and a
  // value failing its own check digit was misread or mistyped at the supplier.
  result.identifiers = result.identifiers.filter(
    (entry) =>
      entry.label?.trim() && entry.evidence?.trim() && isValidTaxId(entry.value),
  );
  // The printed pre-VAT figure keeps its job as the one independent check on the
  // two anchored numbers: deriving it unconditionally would make that check
  // always pass and hide a misread VAT.
  if (
    [result.subtotalAgorot, result.vatAgorot, result.totalAgorot].every(
      (v) => v !== null,
    ) &&
    result.subtotalAgorot + result.vatAgorot + printedRoundingAgorot !== result.totalAgorot
  ) {
    // One mismatch can be attributed rather than merely reported: these
    // documents print a pre-discount figure (ערך תעודה לפי מחירון, סה"כ לפני
    // הנחה) directly above the after-discount one, and reading the wrong one
    // leaves a gap that is exactly a document discount already inside the total.
    // That identity is exact, so correcting it needs no arithmetic tolerance.
    // Every other mismatch leaves all three printed numbers untouched, because
    // there we cannot tell which of them was misread.
    const corrected =
      result.totalAgorot - result.vatAgorot - printedRoundingAgorot;
    const applied = result.deductions.find(
      (d) =>
        d.includedInTotal === true &&
        d.amountAgorot !== null &&
        result.subtotalAgorot - d.amountAgorot === corrected,
    );
    if (applied) {
      result.warnings.push(
        `הסכום שנקרא לפני מע״מ (${shekels(result.subtotalAgorot)}) הוא לפני ההנחה ״${applied.label}״. נרשם ${shekels(corrected)}, שכבר כולל אותה. יש לבדוק מול המסמך.`,
      );
      result.subtotalAgorot = corrected;
    } else
      result.warnings.push(
        "הסכום לפני מע״מ ועוד המע״מ אינו שווה לסכום הכולל. המספרים שנקראו לא שונו.",
      );
    ["subtotalAgorot", "vatAgorot", "totalAgorot"].forEach((k) =>
      uncertain.add(k),
    );
  }
  const signIssues = creditSignIssues(result);
  if (signIssues.length) {
    signIssues.forEach((key) => uncertain.add(key));
    result.warnings.push(
      "זהו זיכוי: במסמך נקראו סכומים שאינם שליליים. בדוק שסוג המסמך הוא זיכוי ואת גובה הסכומים. בשמירה מאושרת הזיכוי נרשם כהפחתה. המספרים שנקראו לא שונו.",
    );
  }
  result.uncertainFields = [...uncertain];
  result.needsReview =
    result.needsReview || uncertain.size > 0 || !result.documentType;
  return result;
}
export function validateReportExtraction(raw) {
  if (!matchesSchema(raw, reportJsonSchema))
    fail(502, "AI_INVALID_RESPONSE", "הדוח לא נקרא בצורה תקינה.");
  const result = structuredClone(raw);
  for (const row of result.rows) {
    if (row.invoiceDate)
      try {
        date(row.invoiceDate);
      } catch {
        row.invoiceDate = null;
      }
    if (!row.evidence?.trim()) {
      row.totalAgorot = null;
      row.vatAgorot = null;
    }
    if (row.vatAgorot === 0 && !hasExplicitZeroVat(row.evidence))
      row.vatAgorot = null;
    row.needsReview =
      row.needsReview ||
      [
        "supplierName",
        "documentNumber",
        "invoiceDate",
        "totalAgorot",
        "vatAgorot",
      ].some((k) => row[k] === null);
  }
  result.needsReview ||= result.rows.some((r) => r.needsReview);
  return result;
}
