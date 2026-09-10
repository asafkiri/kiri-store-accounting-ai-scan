import { fail } from "./errors.js";
export async function authorize(header, verifyToken, config) {
  if (typeof header !== "string" || !/^Bearer [^\s]{10,8192}$/.test(header))
    fail(401, "AUTH_REQUIRED", "יש להתחבר כדי להמשיך.");
  let decoded;
  try {
    decoded = await verifyToken(header.slice(7));
  } catch {
    fail(401, "INVALID_TOKEN", "ההתחברות פגה. יש להתחבר שוב.");
  }
  if (!config.allowedPhone && !config.allowedUid)
    fail(
      503,
      "AUTH_NOT_CONFIGURED",
      "הגישה למערכת טרם הוגדרה. יש לפנות למי שהקים אותה.",
    );
  // Firebase signature/audience/issuer/expiry/revocation are verified by Admin, never by the client.
  if (
    decoded.firebase?.sign_in_provider !== "phone" ||
    !decoded.phone_number ||
    (config.allowedPhone && decoded.phone_number !== config.allowedPhone) ||
    (config.allowedUid && decoded.uid !== config.allowedUid)
  )
    fail(403, "FORBIDDEN", "לחשבון הזה אין הרשאה לחנות.");
  return { uid: decoded.uid };
}
