// Canonical shared module; the app vendors this file verbatim and checks it in CI.
export function creditSignIssues(invoice) {
  if (invoice.documentType !== "credit") return [];
  return ["subtotalAgorot", "vatAgorot", "totalAgorot", "finalAgorot"].filter(
    (key) => {
      const value = invoice[key];
      return (
        value != null &&
        (key === "totalAgorot" || key === "finalAgorot"
          ? value >= 0
          : value > 0)
      );
    },
  );
}
