import { fail } from "./errors.js";
import { object, str } from "./validation.js";
import { hash } from "./invoices.js";
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024,
  MAX_PAGES = 8;
export async function validateFiles(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_PAGES)
    fail(400, "INVALID_FILES", "יש לבחור בין קובץ אחד ל־8 קבצים.");
  let total = 0,
    pages = 0;
  const files = [];
  for (const f of input) {
    object(f, ["name", "mime", "data"]);
    str(f.name, 180, true);
    if (
      !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
        f.mime,
      )
    )
      fail(
        415,
        "INVALID_FILE",
        "ניתן להעלות JPG, PNG, WebP או PDF. בתמונה מסוג HEIC יש לבחור צילום בפורמט תואם.",
      );
    if (
      typeof f.data !== "string" ||
      !f.data.length ||
      f.data.length > 17 * 1024 * 1024 ||
      f.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)
    )
      fail(400, "INVALID_FILE", "קובץ לא תקין. יש לבחור אותו מחדש.");
    const bytes = Buffer.from(f.data, "base64");
    total += bytes.length;
    if (total > MAX_UPLOAD_BYTES)
      fail(
        413,
        "FILE_TOO_LARGE",
        "סך הקבצים מוגבל ל־12 מגה. בחר פחות עמודים או תמונות קטנות יותר.",
      );
    let count = 1,
      mime = f.mime;
    try {
      if (mime === "application/pdf") {
        if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error();
        const { PDFDocument } = await import("pdf-lib");
        const pdf = await PDFDocument.load(bytes, {
          updateMetadata: false,
          throwOnInvalidObject: true,
        });
        count = pdf.getPageCount();
        if (!count) throw new Error();
      } else {
        const { default: sharp } = await import("sharp");
        const image = sharp(bytes, {
          limitInputPixels: 24_000_000,
          failOn: "error",
          sequentialRead: true,
        });
        const metadata = await image.metadata();
        if (
          { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[
            metadata.format
          ] !== mime ||
          (metadata.pages || 1) !== 1 ||
          !metadata.width ||
          !metadata.height
        )
          throw new Error();
        // Decode to catch corrupt/truncated images. Originals remain untouched; no cropping or aggressive sharpening.
        await image.stats();
      }
    } catch {
      fail(
        415,
        "INVALID_FILE",
        "הקובץ פגום, נעול, גדול מדי לפענוח או אינו תואם לסוג שלו. יש לבחור קובץ אחר.",
      );
    }
    pages += count;
    if (pages > MAX_PAGES)
      fail(413, "TOO_MANY_PAGES", "ניתן לסרוק עד 8 עמודים בכל פעם.");
    files.push({
      id: hash(bytes),
      bytes,
      mime,
      pages: count,
      name: f.name.replace(/[\x00-\x1f/\\]/g, "_"),
    });
  }
  return files;
}
export class DocumentService {
  constructor(store, storage) {
    Object.assign(this, { store, storage });
  }
  async upload(input, uid) {
    const files = await validateFiles(input);
    const records = [];
    for (const f of files) {
      const key = "documents/" + f.id;
      let record = await this.store.get(key);
      if (!record) {
        await this.storage.put("documents/" + f.id, f.bytes, f.mime);
        await this.store.transaction(async (tx) => {
          const old = await tx.get(key);
          if (!old)
            tx.set(key, {
              id: f.id,
              name: f.name,
              mime: f.mime,
              pages: f.pages,
              size: f.bytes.length,
              createdAt: tx.stamp(),
              createdBy: uid,
            });
        });
        record = await this.store.get(key);
      }
      records.push(record);
    }
    return records;
  }
  async load(ids) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 8 ||
      ids.some((x) => typeof x !== "string" || !/^[a-f0-9]{64}$/.test(x))
    )
      fail(400, "INVALID_FILES", "יש לבחור קבצים תקינים.");
    const files = [];
    let pages = 0,
      total = 0;
    for (const id of [...new Set(ids)]) {
      const meta = await this.store.get("documents/" + id);
      if (!meta)
        fail(404, "FILE_MISSING", "המסמך לא נמצא. יש להעלות אותו שוב.");
      pages += meta.pages;
      total += meta.size;
      if (pages > 8 || total > MAX_UPLOAD_BYTES)
        fail(413, "TOO_MANY_PAGES", "סך הקבצים מוגבל ל־8 עמודים ו־12 מגה.");
      files.push({ ...meta, bytes: await this.storage.get("documents/" + id) });
    }
    return files;
  }
}
