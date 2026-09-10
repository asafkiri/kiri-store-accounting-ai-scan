import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSupplierName,
  normalizeDocumentText,
} from "../src/supplier-name.js";
import { reconcile } from "../src/reconciliation.js";
import { inv } from "./helpers.js";

test("shared normalization handles quotes, whitespace, Latin case and legal suffixes without editing names", () => {
  for (const text of [
    "מרינה",
    " מרינה ",
    'מרינה בע"מ',
    "מרינה בע״מ",
    "מרינה בע'מ",
    "מרינה ח.פ.",
    "מרינה ע.מ.",
    "מרינה בע״מ ח.פ.",
  ])
    assert.equal(normalizeSupplierName(text), "מרינה");
  assert.equal(normalizeSupplierName(" ACME  Foods בע״מ "), "acmefoods");
  assert.equal(normalizeSupplierName(null), "");
  assert.equal(normalizeSupplierName("בעמק"), "בעמק");
  assert.notEqual(
    normalizeSupplierName("מרינה צפון"),
    normalizeSupplierName("מרינה דרום"),
  );
  assert.equal(normalizeDocumentText(" A-1/23 "), "a1/23");
});
test("accountant comparison reuses supplier normalization but still requires all other matching evidence", () => {
  const row = {
    supplierName: "מרינה",
    documentNumber: "1001",
    invoiceDate: "2026-09-10",
    totalAgorot: 11800,
    vatAgorot: 1800,
    needsReview: false,
  };
  const suppliers = [{ id: "supplier-001", name: "מרינה בע״מ" }];
  const invoices = [{ ...inv(), id: "invoice-001" }];
  assert.equal(reconcile([row], invoices, suppliers).matchedCount, 1);
  assert.equal(
    reconcile([{ ...row, vatAgorot: null }], invoices, suppliers).matchedCount,
    0,
  );
});
