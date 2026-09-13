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
  // How long an invoice photo is kept before the service deletes it from
  // Firestore and from Storage. The default covers the seven years that
  // bookkeeping rules count from the END of the tax year, which is close to
  // eight years from the day the photo was taken. 0 keeps every photo until
  // it is deleted by hand. Storage for a family store is a few shekels a
  // year, so the period is a documentation decision, not a cost one.
  const retention = String(env.DOCUMENT_RETENTION_DAYS ?? "").trim() || "2920";
  if (!/^\d{1,4}$/.test(retention) || Number(retention) > 3650)
    throw new Error(
      "DOCUMENT_RETENTION_DAYS must be a whole number of days, 0-3650 (0 disables the purge)",
    );
  return {
    documentRetentionDays: Number(retention),
    production,
    port: Number(env.PORT || 8080),
    projectId: env.FIREBASE_PROJECT_ID || "kiri-store-accounting",
    bucket:
      env.FIREBASE_STORAGE_BUCKET ||
      "kiri-store-accounting.firebasestorage.app",
    allowedPhone: env.ALLOWED_PHONE_NUMBER || "",
    allowedUid: env.ALLOWED_UID || "",
    allowedOrigins,
  };
}
