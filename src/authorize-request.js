import { authorize } from "./auth.js";
import { AppError } from "./errors.js";
import { isRejectedToken, safeDiagnostic } from "./diagnostics.js";

export async function authorizeRequest(header, verifyToken, config) {
  let verificationError;
  try {
    // Keep authorize(), including provider/phone/UID checks, byte-for-byte unchanged.
    return await authorize(
      header,
      async (token) => {
        try {
          return await verifyToken(token);
        } catch (error) {
          verificationError = { error };
          throw error;
        }
      },
      config,
    );
  } catch (error) {
    if (!verificationError) throw error;
    const rejected = isRejectedToken(verificationError.error);
    const failure = new AppError(
      rejected ? 401 : 503,
      rejected ? "INVALID_TOKEN" : "AUTH_UNAVAILABLE",
      rejected
        ? "ההתחברות אינה תקפה. יש להתחבר שוב."
        : "לא ניתן לאמת את ההתחברות כרגע בגלל תקלה בשירות. נסה שוב בעוד רגע.",
    );
    failure.diagnostic = safeDiagnostic(verificationError.error);
    throw failure;
  }
}
