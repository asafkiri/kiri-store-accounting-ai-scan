import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTaxLabel,
  groupTaxIds,
  isValidTaxId,
  normalizeTaxId,
  supplierTaxIds,
} from "../src/tax-id.js";

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

test("labels separate an entity from a consolidated group file and from noise", () => {
  for (const label of [
    "ח.פ",
    'ח"פ',
    "ע.מ",
    "ע.מ/ח.פ",
    "ע.מ. לקוח",
    "עוסק מורשה",
    "עוסק מורשה ח.פ.",
    "מספר עוסק",
    "מס חברה",
    "מס' חברה",
    "מספר תאגיד לקוח",
    'תיק מע"מ לקוח',
    'מספר תיק במע"מ',
  ])
    assert.equal(classifyTaxLabel(label), "entity", label);
  for (const label of [
    "ע.מ מאוחד",
    "איחוד עוסקים",
    "איחוד עסקים",
    'תיק איחוד עוסקים לעניין מע"מ מס',
  ])
    assert.equal(classifyTaxLabel(label), "group", label);
  for (const label of [
    "תיק ניכויים",
    "מס' הזמנה",
    "מספר חשבונית",
    "מס לקוח",
    "קוד לקוח",
    "מספר הקצאה",
    "טלפון",
    "מספר מחלק",
    "מסלול",
    "ברקוד",
    "סוכן",
    "מזהה",
    // A supplier's own name must not read as a VAT label through its "בע״מ".
    'שטראוס גרופ בע"מ',
    "אחים אוחיון בעמ",
  ])
    assert.equal(classifyTaxLabel(label), null, label);
});

test("the supplier is the entity identifier that is not the store's", () => {
  // Globus prints its own number, its group file and the store's.
  assert.deepEqual(
    supplierTaxIds(
      [
        { label: "ח.פ", value: "513036434", party: "issuer" },
        { label: "איחוד עסקים", value: "557904679", party: "issuer" },
        { label: "ע.מ/ח.פ", value: "069991651", party: "recipient" },
        { label: "מספר לקוח", value: "106694", party: "recipient" },
      ],
      STORE,
    ),
    ["513036434"],
  );
});

test("a shared consolidated file never merges two companies of one group", () => {
  const group = { label: "ע.מ מאוחד", value: "557268851", party: "issuer" };
  const recipient = { label: "ע.מ. לקוח", value: "069991651", party: "recipient" };
  const strauss = supplierTaxIds(
    [group, { label: "מס חברה", value: "520003781", party: "issuer" }, recipient],
    STORE,
  );
  const frito = supplierTaxIds(
    [group, { label: "מס חברה", value: "510909450", party: "issuer" }, recipient],
    STORE,
  );
  assert.deepEqual(strauss, ["520003781"]);
  assert.deepEqual(frito, ["510909450"]);
  // The two invoices share no supplier identifier, so they stay two suppliers.
  assert.equal(strauss.some((id) => frito.includes(id)), false);
  assert.deepEqual(groupTaxIds([group]), ["557268851"]);
});

test("a group with several companies keeps each entity identifier it prints", () => {
  // Tempo prints both group companies and the consolidated file on one footer.
  assert.deepEqual(
    supplierTaxIds(
      [
        { label: "ח.פ.", value: "510901309", party: "issuer" },
        { label: "ח.פ.", value: "513682625", party: "issuer" },
        { label: 'תיק איחוד עוסקים לעניין מע"מ מס', value: "557652815", party: "issuer" },
        { label: "ע.מ", value: "069991651", party: "recipient" },
        { label: "מס' הזמנה", value: "64687833", party: null },
      ],
      STORE,
    ),
    ["510901309", "513682625"],
  );
});

test("sequence numbers that pass the check digit are held out by their label", () => {
  // Both of these are valid nine-digit values once padded; only the label saves us.
  assert.ok(isValidTaxId("64687833"), "Tempo order number passes the check digit");
  assert.ok(isValidTaxId("70547336"), "Levi Meir customer code passes the check digit");
  assert.deepEqual(
    supplierTaxIds(
      [
        { label: "מס' הזמנה", value: "64687833", party: "issuer" },
        { label: "לקוח", value: "70547336", party: "recipient" },
        { label: "מספר חשבונית", value: "274076", party: "issuer" },
      ],
      STORE,
    ),
    [],
  );
});

test("the store's number is not required to identify the supplier", () => {
  // Mr. ICE corrupts the store's number; its own stays readable, so the
  // supplier is still named and the document does not fall back to the name.
  assert.deepEqual(
    supplierTaxIds(
      [
        { label: "ח.פ", value: "511175135", party: "issuer" },
        { label: "ע.מ / ח.פ", value: "89991651", party: "recipient" },
      ],
      STORE,
    ),
    ["511175135"],
  );
  // With no configured store number the recipient hint is all that separates them.
  assert.deepEqual(
    supplierTaxIds(
      [
        { label: "ח.פ", value: "511175135", party: "issuer" },
        { label: "ע.מ / ח.פ", value: "069991651", party: "recipient" },
      ],
      "",
    ),
    ["511175135", STORE],
  );
});
