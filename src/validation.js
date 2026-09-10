import { fail } from "./errors.js";
export const MAX_MONEY = 100_000_000_000;
export const isRecord = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function object(v, keys) {
  if (!isRecord(v) || Object.keys(v).some((k) => !keys.includes(k)))
    fail(400, "INVALID_INPUT", "הנתונים שנשלחו אינם תקינים.");
  return v;
}
export function str(v, max = 200, required = false) {
  if (typeof v !== "string" || v.length > max || (required && !v.trim()))
    fail(400, "INVALID_INPUT", "יש לבדוק את שדות הטקסט.");
  return v.trim();
}
export function id(v) {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(v))
    fail(400, "INVALID_ID", "מזהה הרשומה אינו תקין.");
  return v;
}
export function date(v) {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    v < "1900-01-01" ||
    v > "2200-12-31" ||
    Number.isNaN(Date.parse(v)) ||
    new Date(v + "T12:00:00Z").toISOString().slice(0, 10) !== v
  )
    fail(400, "INVALID_DATE", "התאריך אינו תקין.");
  return v;
}
export function money(v, nullable = false) {
  if (nullable && v === null) return null;
  if (!Number.isSafeInteger(v) || Math.abs(v) > MAX_MONEY)
    fail(
      400,
      "INVALID_MONEY",
      "יש להזין סכום תקין עם עד שתי ספרות אחרי הנקודה.",
    );
  return v;
}
export function version(v) {
  if (!Number.isInteger(v) || v < 0)
    fail(400, "INVALID_VERSION", "גרסת הרשומה אינה תקינה.");
  return v;
}
export function oneOf(v, options) {
  if (!options.includes(v))
    fail(400, "INVALID_INPUT", "אחת הבחירות אינה תקינה.");
  return v;
}
export function supplier(v) {
  object(v, ["name", "notes", "contact", "active"]);
  if (typeof v.active !== "boolean")
    fail(400, "INVALID_INPUT", "מצב הספק אינו תקין.");
  return {
    name: str(v.name, 160, true),
    notes: str(v.notes, 2000),
    contact: str(v.contact, 200),
    active: v.active,
  };
}
export function invoice(v) {
  object(v, [
    "supplierId",
    "documentNumber",
    "invoiceDate",
    "documentType",
    "subtotalAgorot",
    "vatAgorot",
    "totalAgorot",
    "deductions",
    "finalAgorot",
    "notes",
    "attachmentIds",
    "source",
    "scanJobId",
    "reviewConfirmed",
  ]);
  if (!Array.isArray(v.deductions) || v.deductions.length > 30)
    fail(400, "INVALID_INPUT", "אפשר להוסיף עד 30 שורות הפחתה.");
  const deductions = v.deductions.map((d) => {
    object(d, ["label", "amountAgorot", "includedInTotal"]);
    if (typeof d.includedInTotal !== "boolean")
      fail(400, "INVALID_INPUT", "יש לציין אם ההפחתה כבר כלולה בסכום.");
    return {
      label: str(d.label, 160, true),
      amountAgorot: money(d.amountAgorot),
      includedInTotal: d.includedInTotal,
    };
  });
  if (!Array.isArray(v.attachmentIds) || v.attachmentIds.length > 8)
    fail(400, "INVALID_INPUT", "אפשר לצרף עד 8 קבצים.");
  const source = oneOf(v.source, ["manual", "ai"]);
  if (v.reviewConfirmed !== true)
    fail(400, "REVIEW_REQUIRED", "יש לבדוק ולאשר את החשבונית לפני השמירה.");
  const result = {
    supplierId: id(v.supplierId),
    documentNumber: str(v.documentNumber, 100, true),
    invoiceDate: date(v.invoiceDate),
    documentType: oneOf(v.documentType, [
      "invoice",
      "credit",
      "delivery",
      "receipt",
    ]),
    subtotalAgorot: money(v.subtotalAgorot, true),
    vatAgorot: money(v.vatAgorot, true),
    totalAgorot: money(v.totalAgorot),
    finalAgorot: money(v.finalAgorot),
    deductions,
    notes: str(v.notes, 4000),
    attachmentIds: [...new Set(v.attachmentIds.map(id))],
    source,
    scanJobId: v.scanJobId === null ? null : id(v.scanJobId),
    reviewConfirmed: true,
  };
  if (source === "ai" && !result.scanJobId)
    fail(400, "REVIEW_REQUIRED", "לא נמצאה סריקה לבדיקה.");
  return result;
}
export function payment(v) {
  object(v, ["method", "paymentDate", "checkNumber", "checkDueDate", "notes"]);
  const method = oneOf(v.method, [
    "cash",
    "check",
    "transfer",
    "card",
    "other",
  ]);
  const result = {
    method,
    paymentDate: date(v.paymentDate),
    checkNumber: str(v.checkNumber, 80),
    checkDueDate: v.checkDueDate ? date(v.checkDueDate) : null,
    notes: str(v.notes, 1000),
  };
  if (method !== "check" && (result.checkDueDate || result.checkNumber))
    fail(400, "INVALID_INPUT", "פרטי צ׳ק זמינים רק לתשלום בצ׳ק.");
  return result;
}
export function cash(v) {
  object(v, ["date", "cashAgorot", "ravKavAgorot", "notes"]);
  const result = {
    date: date(v.date),
    cashAgorot: money(v.cashAgorot, true),
    ravKavAgorot: money(v.ravKavAgorot, true),
    notes: str(v.notes, 1000),
  };
  if (result.cashAgorot === null && result.ravKavAgorot === null)
    fail(400, "INVALID_INPUT", "יש למלא קופה או רב־קו.");
  if ((result.cashAgorot ?? 0) < 0 || (result.ravKavAgorot ?? 0) < 0)
    fail(400, "INVALID_INPUT", "סכום סגירה חייב להיות אפס או יותר.");
  return result;
}
export function filters(search) {
  const f = Object.fromEntries(search);
  object(f, [
    "month",
    "from",
    "to",
    "supplierId",
    "status",
    "method",
    "q",
    "after",
    "limit",
  ]);
  if (f.month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.month))
      fail(400, "INVALID_DATE", "החודש אינו תקין.");
    date(f.month + "-01");
  }
  if (f.from) date(f.from);
  if (f.to) date(f.to);
  if (f.from && f.to && f.from > f.to)
    fail(400, "INVALID_DATE", "תאריך ההתחלה מאוחר מתאריך הסיום.");
  if (f.supplierId) id(f.supplierId);
  if (f.status) oneOf(f.status, ["paid", "unpaid"]);
  if (f.method) oneOf(f.method, ["cash", "check", "transfer", "card", "other"]);
  if (f.q) str(f.q, 200);
  if (f.after) id(f.after);
  if (
    f.limit &&
    (!/^\d+$/.test(f.limit) || Number(f.limit) < 1 || Number(f.limit) > 250)
  )
    fail(400, "INVALID_INPUT", "גודל העמוד אינו תקין.");
  return f;
}
export function filterInvoices(items, f, suppliers = []) {
  const names = new Map(suppliers.map((s) => [s.id, s.name]));
  const q = (f.q || "").trim().toLocaleLowerCase("he");
  return items.filter(
    (i) =>
      !i.deletedAt &&
      (!f.month || i.invoiceDate.startsWith(f.month)) &&
      (!f.from || i.invoiceDate >= f.from) &&
      (!f.to || i.invoiceDate <= f.to) &&
      (!f.supplierId || i.supplierId === f.supplierId) &&
      (!f.status || i.status === f.status) &&
      (!f.method || i.payment?.method === f.method) &&
      (!q ||
        [names.get(i.supplierId), i.documentNumber, i.notes]
          .join(" ")
          .toLocaleLowerCase("he")
          .includes(q)),
  );
}
export function summarize(invoices) {
  const sum = (k) => invoices.reduce((a, i) => a + (i[k] ?? 0), 0);
  return {
    count: invoices.length,
    subtotalAgorot: sum("subtotalAgorot"),
    vatAgorot: sum("vatAgorot"),
    totalAgorot: sum("totalAgorot"),
    finalAgorot: sum("finalAgorot"),
    unknownVat: invoices.filter((i) => i.vatAgorot === null).length,
    unknownSubtotal: invoices.filter((i) => i.subtotalAgorot === null).length,
    unpaidAgorot: invoices
      .filter((i) => i.status === "unpaid")
      .reduce((a, i) => a + i.finalAgorot, 0),
  };
}
