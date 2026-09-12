import { isValidTaxId, normalizeTaxId } from "./tax-id.js";
export function configFromEnv(env = process.env) {
  const production = env.NODE_ENV === "production";
  if (
    production &&
    [
      "FIREBASE_AUTH_EMULATOR_HOST",
      "FIRESTORE_EMULATOR_HOST",
      "FIREBASE_STORAGE_EMULATOR_HOST",
    ].some((k) => env[k])
  )
    throw new Error("Emulators must never be enabled in production");
  const allowedOrigins = (
    env.ALLOWED_ORIGIN ||
    "https://kiri-store-accounting.web.app,https://kiri-store-accounting.firebaseapp.com"
  )
    .split(",")
    .map((s) => s.trim());
  if (
    allowedOrigins.some(
      (s) =>
        !s ||
        s === "*" ||
        new URL(s).origin !== s ||
        (production && !s.startsWith("https://")),
    )
  )
    throw new Error("Invalid ALLOWED_ORIGIN");
  if (
    env.ALLOWED_PHONE_NUMBER &&
    !/^\+[1-9]\d{7,14}$/.test(env.ALLOWED_PHONE_NUMBER)
  )
    throw new Error("ALLOWED_PHONE_NUMBER must be E.164");
  if (env.OPENAI_MODEL && env.OPENAI_MODEL !== "gpt-5.6-luna")
    throw new Error("V1 permits gpt-5.6-luna only");
  // The store's own ח.פ/ע.מ separates the supplier from the recipient on every
  // invoice. A wrong value here misreads every document, so reject it at boot
  // rather than at scan time.
  const storeTaxId = normalizeTaxId(env.STORE_TAX_ID || "");
  if (env.STORE_TAX_ID && !isValidTaxId(storeTaxId))
    throw new Error("STORE_TAX_ID must be a valid Israeli ח.פ/ע.מ");
  const limit = (name, fallback, max) => {
    const v = Number(env[name] ?? fallback);
    if (!Number.isInteger(v) || v < 1 || v > max)
      throw new Error("Invalid " + name);
    return v;
  };
  return {
    production,
    port: Number(env.PORT || 8080),
    projectId: env.FIREBASE_PROJECT_ID || "kiri-store-accounting",
    bucket:
      env.FIREBASE_STORAGE_BUCKET ||
      "kiri-store-accounting.firebasestorage.app",
    allowedPhone: env.ALLOWED_PHONE_NUMBER || "",
    allowedUid: env.ALLOWED_UID || "",
    allowedOrigins,
    openaiKey: env.OPENAI_API_KEY || "",
    model: "gpt-5.6-luna",
    storeTaxId,
    // Each scan is read this many times at once and the readings are compared,
    // so a field only survives when they agree. It multiplies what a scan costs
    // at the model, and the scan counters below still count one per document.
    readingsPerScan: limit("READINGS_PER_SCAN", 2, 3),
    dailyScanLimit: limit("MAX_SCANS_PER_DAY", 30, 100),
    // Every document is photographed, so the month's ceiling has to cover a
    // full store: roughly twenty invoices a day over twenty-two working days.
    monthlyScanLimit: limit("MAX_SCANS_PER_MONTH", 900, 3000),
  };
}
