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
  };
}
