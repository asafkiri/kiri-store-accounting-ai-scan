export class MemoryStore {
  constructor() {
    this.rows = new Map();
    this.chain = Promise.resolve();
  }
  async get(key) {
    return structuredClone(this.rows.get(key) || null);
  }
  async list(collection, after = "", limit = 250) {
    return [...this.rows]
      .filter(
        ([k]) =>
          k.startsWith(collection + "/") &&
          k.slice(collection.length + 1) > after,
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([, v]) => structuredClone(v));
  }
  async transaction(fn) {
    let release;
    const previous = this.chain;
    this.chain = new Promise((r) => (release = r));
    await previous;
    const staged = new Map(this.rows);
    let wrote = false;
    try {
      const result = await fn({
        get: async (k) => {
          if (wrote) throw new Error("Firestore reads must precede writes");
          return structuredClone(staged.get(k) || null);
        },
        list: async (collection) => {
          if (wrote) throw new Error("Firestore reads must precede writes");
          return [...staged]
            .filter(([key]) => key.startsWith(collection + "/"))
            .map(([, value]) => structuredClone(value));
        },
        set: (k, v) => {
          wrote = true;
          staged.set(k, structuredClone(v));
        },
        stamp: () => Date.now(),
      });
      this.rows = staged;
      return result;
    } finally {
      release();
    }
  }
}
export class MemoryStorage {
  constructor() {
    this.rows = new Map();
  }
  async put(k, b) {
    if (!this.rows.has(k)) this.rows.set(k, b);
  }
  async get(k) {
    return this.rows.get(k);
  }
}
export const config = {
  allowedPhone: "+15555550123",
  allowedUid: "",
  allowedOrigins: ["https://kiri-store-accounting.web.app"],
  model: "gpt-5.6-luna",
  openaiKey: "unit-test-only",
  dailyScanLimit: 30,
  monthlyScanLimit: 300,
};
export const inv = () => ({
  supplierId: "supplier-001",
  documentNumber: "1001",
  invoiceDate: "2026-09-10",
  documentType: "invoice",
  subtotalAgorot: 10000,
  vatAgorot: 1800,
  totalAgorot: 11800,
  finalAgorot: 11800,
  deductions: [],
  notes: "",
  attachmentIds: [],
  source: "manual",
  scanJobId: null,
  reviewConfirmed: true,
});
export const aiResult = () => ({
  supplierName: "ספק בדיקה",
  documentNumber: "123",
  invoiceDate: "2026-09-10",
  subtotalAgorot: 10000,
  vatAgorot: 1800,
  totalAgorot: 11800,
  finalAgorot: 11800,
  documentType: "invoice",
  deductions: [],
  evidence: {
    supplierName: "ספק בדיקה",
    documentNumber: "123",
    invoiceDate: "10.9.2026",
    subtotalAgorot: "100.00",
    vatAgorot: "מע״מ 18.00",
    totalAgorot: "118.00",
    finalAgorot: "118.00",
  },
  uncertainFields: [],
  needsReview: false,
  warnings: [],
});
