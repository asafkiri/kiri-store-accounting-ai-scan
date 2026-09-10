// Canonical shared module. The app vendors this file verbatim; its CI checks equality.
export function normalizeDocumentText(value) {
  return (value || "")
    .normalize("NFKC")
    .replace(/[\s\-–״"'׳.,]/g, "")
    .toLowerCase();
}
export function normalizeSupplierName(value) {
  const text = (value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/["'״׳]/g, "")
    .trim()
    // Only legal suffixes at the end, separated from the business name.
    .replace(/(?:\s+(?:בעמ|ח\s*\.\s*פ\.?|ע\s*\.\s*מ\.?))+$/u, "");
  return normalizeDocumentText(text);
}
