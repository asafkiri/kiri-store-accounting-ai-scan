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
  async query(collection, field, value, limit = 50) {
    return [...this.rows]
      .filter(
        ([k, v]) =>
          k.startsWith(collection + "/") &&
          Array.isArray(v[field]) &&
          v[field].includes(value),
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
        query: async (collection, field, value, limit = 50) => {
          if (wrote) throw new Error("Firestore reads must precede writes");
          return [...staged]
            .filter(
              ([key, row]) =>
                key.startsWith(collection + "/") &&
                Array.isArray(row[field]) &&
                row[field].includes(value),
            )
            .sort(([a], [b]) => a.localeCompare(b))
            .slice(0, limit)
            .map(([, row]) => structuredClone(row));
        },
        set: (k, v) => {
          wrote = true;
          staged.set(k, structuredClone(v));
        },
        delete: (k) => {
          wrote = true;
          staged.delete(k);
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
  async delete(k) {
    this.rows.delete(k);
  }
}
export const config = {
  allowedPhone: "+15555550123",
  allowedUid: "",
  allowedOrigins: ["https://kiri-store-accounting.web.app"],
  documentRetentionDays: 365,
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
  reviewConfirmed: true,
});
