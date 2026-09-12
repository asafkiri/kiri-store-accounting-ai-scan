// Canonical shared module. The app vendors this file verbatim; its CI checks equality.

// An Israeli ח.פ/ע.מ is nine digits ending in a check digit. Printers drop a
// leading zero (eight digits) or pad the field width (ten). Anything shorter is
// a sequence number: padding it to nine invents an identifier that can pass the
// check digit by luck, which is how an order number and an invoice number first
// slipped through.
export function normalizeTaxId(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10 && digits[0] === "0") return digits.slice(1);
  return digits.length === 8 || digits.length === 9
    ? digits.padStart(9, "0")
    : "";
}
export function isValidTaxId(value) {
  const id = normalizeTaxId(value);
  if (!id) return false;
  let sum = 0;
  for (let index = 0; index < 9; index++) {
    const product = Number(id[index]) * (index % 2 ? 2 : 1);
    sum += product > 9 ? product - 9 : product;
  }
  return sum % 10 === 0;
}
// A consolidated VAT file (תיק איחוד עוסקים) belongs to a whole group, not to
// one company: Strauss Group and Strauss Frito Lay print the same one on
// different invoices. Matching on it merges two suppliers into one, so only an
// entity label identifies a supplier. Group wins over entity because
// "ע.מ מאוחד" and "איחוד עוסקים" each contain an entity word.
const GROUP_LABEL = /מאוחד|איחוד/u;
// The lookbehind keeps the "ע״מ" inside a company's own "בע״מ" from reading as
// a VAT label. "תיק ניכויים" is an income-tax file, never a VAT identifier.
const ENTITY_LABEL =
  /(?<![א-ת])ח["״'.\s]*פ|(?<![א-ת])ע["״'.\s]*מ|עוסק|תאגיד|חברה|תיק\s*ב?מע/u;
export function classifyTaxLabel(label) {
  const text = String(label ?? "");
  if (GROUP_LABEL.test(text)) return "group";
  return ENTITY_LABEL.test(text) ? "entity" : null;
}
// The supplier is the entity identifier that is not the store's own. Reading our
// own number is not a precondition: when only one entity identifier is printed,
// or a supplier mistypes ours, the remaining one still names the supplier. Two
// survivors mean the document is ambiguous and belongs in review.
export function supplierTaxIds(identifiers = [], storeTaxId = "") {
  const store = normalizeTaxId(storeTaxId);
  const seen = new Set();
  for (const entry of identifiers) {
    if (classifyTaxLabel(entry?.label) !== "entity") continue;
    const id = normalizeTaxId(entry?.value);
    if (!id || id === store || !isValidTaxId(id)) continue;
    if (entry?.party === "recipient" && store) continue;
    seen.add(id);
  }
  return [...seen];
}
export function groupTaxIds(identifiers = []) {
  const seen = new Set();
  for (const entry of identifiers) {
    if (classifyTaxLabel(entry?.label) !== "group") continue;
    const id = normalizeTaxId(entry?.value);
    if (id && isValidTaxId(id)) seen.add(id);
  }
  return [...seen];
}
