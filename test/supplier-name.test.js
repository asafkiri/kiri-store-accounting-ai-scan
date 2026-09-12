import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSupplierName,
  normalizeDocumentText,
} from "../src/supplier-name.js";
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
