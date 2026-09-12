import { fail } from "./errors.js";
import { normalizeSupplierName } from "./supplier-name.js";

export function supplierConflict(supplier, code = "SUPPLIER_EXISTS") {
  fail(
    409,
    code,
    code === "SUPPLIER_CHANGED"
      ? "פרטי הספק השתנו. יש לבדוק את הספק העדכני לפני השמירה."
      : supplier.active
        ? "כבר קיים ספק בשם הזה. אפשר לשייך אליו את התעודה."
        : "כבר קיים ספק בשם הזה שסומן כלא פעיל. אפשר להפעיל אותו מחדש.",
    { supplierId: supplier.id },
  );
}
export async function checkSupplierName(tx, next, previous) {
  if (
    next.deletedAt ||
    (previous && !previous.deletedAt &&
      previous.name === next.name &&
      (previous.active || !next.active))
  )
    return;
  const name = normalizeSupplierName(next.name);
  if (!name) fail(400, "INVALID_INPUT", "יש להזין שם ספק ברור.");
  // Supplier changes are rare. Read existing names only on creation, rename or
  // reactivation, including legacy rows. No migration or supplier schema change.
  // The shared dataVersion read/write in mutate serializes concurrent insertions.
  const existing = (await tx.list("suppliers")).find(
    (s) =>
      !s.deletedAt &&
      s.id !== next.id &&
      normalizeSupplierName(s.name) === name,
  );
  if (existing) supplierConflict(existing);
}
export async function prepareInvoiceSupplier(
  tx,
  invoice,
  previous,
  intent,
  uid,
) {
  const supplier = await tx.get("suppliers/" + invoice.supplierId);
  if (intent?.newSupplier) {
    if (supplier) supplierConflict(supplier);
    const next = {
      ...intent.newSupplier,
      id: invoice.supplierId,
      version: 1,
      active: true,
      createdAt: tx.stamp(),
      createdBy: uid,
      updatedAt: tx.stamp(),
      updatedBy: uid,
      deletedAt: null,
      createdFrom: "manual",
    };
    await checkSupplierName(tx, next, null);
    return { record: next, before: null, action: "created" };
  }
  if (intent?.reactivateSupplier && supplier && !supplier.deletedAt) {
    if (supplier.version !== intent.reactivateSupplier.expectedVersion)
      supplierConflict(supplier, "SUPPLIER_CHANGED");
    const next = {
      ...supplier,
      active: true,
      version: supplier.version + 1,
      updatedAt: tx.stamp(),
      updatedBy: uid,
    };
    await checkSupplierName(tx, next, supplier);
    return { record: next, before: supplier, action: "reactivated" };
  }
  if (
    !supplier ||
    (supplier.deletedAt && previous?.supplierId !== invoice.supplierId) ||
    (!supplier.active && previous?.supplierId !== invoice.supplierId)
  )
    fail(400, "SUPPLIER_MISSING", "יש לבחור ספק פעיל.");
  return null;
}
