import test from "node:test";
import assert from "node:assert/strict";
import { isValidTaxId, normalizeTaxId } from "../src/tax-id.js";

const STORE = "069991651";

test("printed identifiers normalize to nine digits; shorter runs are not identifiers", () => {
  // Berman, Bezeq and Chion print the store's own number without its leading zero.
  assert.equal(normalizeTaxId("69991651"), STORE);
  // Tnuva pads the field to ten characters.
  assert.equal(normalizeTaxId("0570000745"), "570000745");
  assert.equal(normalizeTaxId("069991651"), STORE);
  assert.equal(normalizeTaxId("ע.מ 511091753"), "511091753");
  // A six-digit invoice number and a thirteen-digit barcode are out of range.
  assert.equal(normalizeTaxId("274076"), "");
  assert.equal(normalizeTaxId("7290003069705"), "");
  assert.equal(normalizeTaxId(""), "");
  assert.equal(normalizeTaxId(null), "");
});

test("every supplier identifier read off a real invoice passes its check digit", () => {
  for (const id of [
    "570000745", // תנובה מרלו״ג דרום
    "783034218", // ד.מ.ד שיווק (״תנובה קפואים״)
    "511091753", // אחים אוחיון
    "513036434", // גלובוס
    "512830266", // מרינה פטריות הגליל
    "510018187", // י. את א. ברמן
    "513045252", // המתוקים של שטרית
    "510901309", // טמפו שיווק (1981)
    "513682625", // טמפו משקאות
    "511532863", // חביב את פרנק
    "515367175", // טופז
    "514965839", // דובק הפצה
    "516285293", // ב.נווה ציון
    "515984300", // אוטופורס
    "520003781", // שטראוס גרופ
    "510909450", // שטראוס פריטו לי
    "520031931", // בזק
    "58323544", //  לוי מאיר, printed with eight digits
    "510869597", // שיווק לביא
    "513910752", // צ׳יון תורג׳מן
    "511175135", // Mr. ICE
    "053008348", // the credit note's issuer
    STORE, //      the store, on all twenty-nine documents
  ])
    assert.ok(isValidTaxId(id), id);
});

test("a single misread digit is rejected, including the store's number on Mr. ICE", () => {
  // Mr. ICE prints the store as 89991651 where every other document prints
  // 69991651. Whether the supplier mistyped it or the photo misread it, an
  // identifier that fails its own arithmetic must never bind a supplier.
  assert.equal(isValidTaxId("89991651"), false);
  assert.equal(isValidTaxId("513036435"), false);
  assert.equal(isValidTaxId("613036434"), false);
  // Phone numbers are nine or ten digits and do not survive the check digit.
  assert.equal(isValidTaxId("086885556"), false);
  assert.equal(isValidTaxId("0545328397"), false);
});

