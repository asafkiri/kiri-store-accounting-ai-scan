// Log only fixed descriptions of known SDK codes, never SDK messages/payloads.
const messages = {
  "auth/id-token-expired": "Firebase ID token expired",
  "auth/id-token-revoked": "Firebase ID token revoked",
  "auth/invalid-id-token": "Firebase ID token invalid",
  "auth/invalid-argument": "Firebase token verification failed",
  "auth/argument-error": "Firebase token verification failed",
  "auth/user-disabled": "Firebase user disabled",
  "auth/user-not-found": "Firebase user not found",
  "auth/insufficient-permission": "Firebase authentication permission denied",
  "auth/invalid-credential": "Firebase server credentials unavailable",
  "auth/internal-error": "Firebase authentication service error",
  "app/network-error": "Firebase network request failed",
  "app/network-timeout": "Firebase network request timed out",
  "permission-denied": "Backend permission denied",
  unavailable: "Backend service unavailable",
  "deadline-exceeded": "Backend request timed out",
};
export function safeDiagnostic(error) {
  const code =
    {
      7: "permission-denied",
      14: "unavailable",
      4: "deadline-exceeded",
      403: "permission-denied",
      503: "unavailable",
      ETIMEDOUT: "deadline-exceeded",
      ECONNRESET: "unavailable",
      ENOTFOUND: "unavailable",
    }[error?.code] || error?.code;
  return Object.hasOwn(messages, code || "")
    ? { errorCategory: code, errorMessage: messages[code] }
    : {
        errorCategory: "INTERNAL",
        errorMessage:
          "Unexpected backend error; inspect the endpoint and request ID",
      };
}
export function isRejectedToken(error) {
  if (
    [
      "auth/id-token-expired",
      "auth/id-token-revoked",
      "auth/invalid-id-token",
      "auth/user-disabled",
      "auth/user-not-found",
    ].includes(error?.code)
  )
    return true;
  // Admin versions use argument-error or invalid-argument, including for key-fetch failures.
  // Only its known token-content/signature diagnostics prove an invalid token.
  return (
    ["auth/argument-error", "auth/invalid-argument"].includes(error?.code) &&
    /^(?:Decoding Firebase ID token failed\.|Firebase ID token has |verifyIdToken\(\) expects )/.test(
      error.message || "",
    )
  );
}
