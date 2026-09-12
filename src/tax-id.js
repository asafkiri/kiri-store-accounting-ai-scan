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
