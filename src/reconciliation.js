import {
  normalizeDocumentText as normalize,
  normalizeSupplierName,
} from "./supplier-name.js";
export function reconcile(rows, invoices, suppliers) {
  const names = new Map(
    suppliers.map((s) => [s.id, normalizeSupplierName(s.name)]),
  );
  const used = new Set();
  const results = rows.map((row, index) => {
    const possible = invoices.filter(
      (i) =>
        !i.deletedAt &&
        !used.has(i.id) &&
        ((normalize(row.documentNumber) &&
          normalize(i.documentNumber) === normalize(row.documentNumber)) ||
          (normalizeSupplierName(row.supplierName) &&
            names.get(i.supplierId) ===
              normalizeSupplierName(row.supplierName) &&
            row.invoiceDate === i.invoiceDate &&
            row.totalAgorot === i.totalAgorot)),
    );
    const exact = possible.filter(
      (i) =>
        !row.needsReview &&
        row.vatAgorot !== null &&
        row.totalAgorot !== null &&
        normalizeSupplierName(row.supplierName) === names.get(i.supplierId) &&
        normalize(row.documentNumber) === normalize(i.documentNumber) &&
        row.invoiceDate === i.invoiceDate &&
        row.totalAgorot === i.totalAgorot &&
        row.vatAgorot === i.vatAgorot,
    );
    if (exact.length === 1) {
      used.add(exact[0].id);
      return {
        index,
        row,
        status: "matched",
        invoiceId: exact[0].id,
        candidates: [],
      };
    }
    return {
      index,
      row,
      status: "needsReview",
      label: "לא נמצאה התאמה — דורש בדיקה",
      invoiceId: null,
      candidates: possible.slice(0, 5).map((i) => ({
        id: i.id,
        supplierId: i.supplierId,
        documentNumber: i.documentNumber,
        invoiceDate: i.invoiceDate,
        totalAgorot: i.totalAgorot,
        vatAgorot: i.vatAgorot,
      })),
    };
  });
  return {
    results,
    notInReport: invoices.filter((i) => !i.deletedAt && !used.has(i.id)),
    matchedCount: used.size,
  };
}
