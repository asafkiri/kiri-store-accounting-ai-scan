import { randomUUID } from "node:crypto";
import { AppError, fail } from "./errors.js";
import { authorizeRequest } from "./authorize-request.js";
import { safeDiagnostic } from "./diagnostics.js";
import { AccountingService } from "./invoices.js";
import { DocumentService } from "./files.js";
import { ScanService } from "./ai.js";
import { reconcile } from "./reconciliation.js";
import * as v from "./validation.js";
const MAX_BODY = 17 * 1024 * 1024;
async function jsonBody(req, limit = 96 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
    fail(415, "CONTENT_TYPE", "יש לשלוח נתונים בפורמט JSON.");
  if (Number(req.headers["content-length"]) > limit)
    fail(413, "TOO_LARGE", "הבקשה גדולה מדי.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, "TOO_LARGE", "הבקשה גדולה מדי.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(400, "INVALID_JSON", "הנתונים שנשלחו אינם תקינים.");
  }
}
export function createHandler({
  store,
  storage,
  verifyToken,
  config,
  invokeAI,
  log = (entry) => console.log(JSON.stringify(entry)),
}) {
  const accounting = new AccountingService(store),
    documents = new DocumentService(store, storage),
    scanner = new ScanService(store, documents, config, invokeAI);
  // Per-instance in-flight guard bounds decoding memory before the global paid-scan lease.
  let uploadBusy = false;
  return async function handler(req, res) {
    const requestId = randomUUID(),
      start = Date.now();
    let diagnostic = null,
      category = null,
      route = "unknown";
    const send = (status, data) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    };
    res.setHeader("X-Request-ID", requestId);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const url = new URL(req.url, "http://localhost");
      route = url.pathname.replace(/\/[a-zA-Z0-9_-]{8,}/g, (segment) =>
        [
          "/api",
          "/invoices",
          "/suppliers",
          "/daily-cash",
          "/documents",
          "/scan-invoice",
          "/scan-report",
          "/reconcile",
          "/scan-jobs",
          "/backup",
        ].includes(segment)
          ? segment
          : "/:id",
      );
      const origin = req.headers.origin;
      if (origin) {
        if (!config.allowedOrigins.includes(origin))
          fail(403, "ORIGIN_DENIED", "הגישה מהכתובת הזאת אינה מורשית.");
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, PUT, POST, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        res.setHeader("Access-Control-Max-Age", "3600");
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === "/health" && req.method === "GET") {
        route = "/health";
        send(200, { ok: true, service: "kiri-store-accounting", version: 1 });
        return;
      }
      if (!url.pathname.startsWith("/api/v1/"))
        fail(404, "NOT_FOUND", "הפעולה לא נמצאה.");
      const user = await authorizeRequest(
        req.headers.authorization,
        verifyToken,
        config,
      );
      const path = url.pathname.slice(8),
        method = req.method;
      if (path === "me" && method === "GET") {
        send(200, { uid: user.uid, authorized: true });
        return;
      }
      if (path === "sync" && method === "GET") {
        v.object(Object.fromEntries(url.searchParams), ["since"]);
        const since = Number(url.searchParams.get("since") || 0);
        if (!Number.isSafeInteger(since) || since < 0)
          fail(400, "INVALID_INPUT", "גרסת הסנכרון אינה תקינה.");
        const meta = await store.get("system/dataVersion"),
          current = meta?.version || 0;
        if (since === current && since !== 0) {
          send(200, { version: current, unchanged: true });
          return;
        }
        // Initial snapshot is read after recording the cursor; later refreshes cannot skip concurrent changes.
        if (since === 0 || since > current || current - since > 200) {
          const [suppliers, invoices, dailyCash] = await Promise.all(
            ["suppliers", "invoices", "dailyCash"].map((c) =>
              accounting.all(c),
            ),
          );
          send(200, {
            version: current,
            full: true,
            suppliers,
            invoices,
            dailyCash,
          });
          return;
        }
        const changes = await store.list(
          "changes",
          String(since).padStart(16, "0"),
          250,
        );
        const unique = [
          ...new Set(
            changes.filter((c) => c.version <= current).map((c) => c.entity),
          ),
        ];
        const data = { suppliers: [], invoices: [], dailyCash: [] };
        await Promise.all(
          unique.map(async (key) => {
            const record = await store.get(key);
            if (record) data[key.split("/")[0]].push(record);
          }),
        );
        send(200, { version: current, full: false, ...data });
        return;
      }
      const entityMatch = path.match(
        /^(suppliers|invoices|daily-cash)(?:\/([a-zA-Z0-9_-]+))?$/,
      );
      if (entityMatch) {
        const [, entity, entityId] = entityMatch;
        const collection = entity === "daily-cash" ? "dailyCash" : entity;
        if (method === "GET" && !entityId) {
          const f = v.filters(url.searchParams);
          if (
            entity === "invoices" &&
            Object.keys(f).some((k) => !["after", "limit"].includes(k))
          ) {
            const all = await accounting.all("invoices");
            const suppliers = await accounting.all("suppliers");
            send(200, {
              items: v.filterInvoices(all, f, suppliers),
              complete: true,
            });
            return;
          }
          const items = await store.list(
            collection,
            f.after || "",
            Number(f.limit || 250),
          );
          send(200, {
            items,
            nextCursor:
              items.length === Number(f.limit || 250) ? items.at(-1).id : null,
          });
          return;
        }
        if (method === "GET" && entityId) {
          v.id(entityId);
          const record = await store.get(collection + "/" + entityId);
          if (!record) fail(404, "NOT_FOUND", "הרשומה לא נמצאה.");
          send(200, record);
          return;
        }
        if (method === "PUT" && entityId) {
          const body = await jsonBody(req);
          const result = await (entity === "suppliers"
            ? accounting.saveSupplier(entityId, body, user.uid)
            : entity === "invoices"
              ? accounting.saveInvoice(entityId, body, user.uid)
              : accounting.saveCash(entityId, body, user.uid));
          send(200, result);
          return;
        }
        if (method === "DELETE" && entity === "invoices" && entityId) {
          send(
            200,
            await accounting.actInvoice(
              entityId,
              "delete",
              await jsonBody(req),
              user.uid,
            ),
          );
          return;
        }
      }
      const action = path.match(
        /^invoices\/([a-zA-Z0-9_-]+)\/(pay|unpay|restore)$/,
      );
      if (action && method === "POST") {
        send(
          200,
          await accounting.actInvoice(
            action[1],
            action[2],
            await jsonBody(req),
            user.uid,
          ),
        );
        return;
      }
      if (path === "documents" && method === "POST") {
        if (uploadBusy)
          fail(429, "UPLOAD_BUSY", "כבר מתבצעת העלאת קובץ. נסה שוב בעוד רגע.");
        uploadBusy = true;
        try {
          const body = await jsonBody(req, MAX_BODY);
          v.object(body, ["files"]);
          send(200, {
            documents: await documents.upload(body.files, user.uid),
          });
        } finally {
          uploadBusy = false;
        }
        return;
      }
      const doc = path.match(/^documents\/([a-f0-9]{64})$/);
      if (doc && method === "GET") {
        const [f] = await documents.load([doc[1]]);
        res.statusCode = 200;
        res.setHeader("Content-Type", f.mime);
        res.setHeader(
          "Content-Disposition",
          'inline; filename="document.' +
            (f.mime === "application/pdf" ? "pdf" : f.mime.split("/")[1]) +
            '"',
        );
        res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
        res.end(f.bytes);
        return;
      }
      if (
        (path === "scan-invoice" || path === "scan-report") &&
        method === "POST"
      ) {
        const body = await jsonBody(req);
        v.object(body, ["jobId", "attachmentIds"]);
        const job = await scanner.scan(
          { ...body, purpose: path === "scan-invoice" ? "invoice" : "report" },
          user.uid,
        );
        send(200, job);
        return;
      }
      const jobMatch = path.match(/^scan-jobs\/([a-zA-Z0-9_-]+)$/);
      if (jobMatch && method === "GET") {
        v.id(jobMatch[1]);
        const job = await store.get("scanJobs/" + jobMatch[1]);
        if (!job) fail(404, "NOT_FOUND", "הסריקה לא נמצאה.");
        send(200, {
          ...job,
          status:
            job.status === "running" && job.expiresAt < Date.now()
              ? "failed"
              : job.status,
        });
        return;
      }
      if (path === "reports/summary" && method === "GET") {
        const f = v.filters(url.searchParams),
          suppliers = await accounting.all("suppliers");
        send(
          200,
          v.summarize(
            v.filterInvoices(await accounting.all("invoices"), f, suppliers),
          ),
        );
        return;
      }
      if (path === "reconcile" && method === "POST") {
        const body = await jsonBody(req);
        v.object(body, ["jobId", "from", "to"]);
        v.id(body.jobId);
        v.date(body.from);
        v.date(body.to);
        if (body.from > body.to)
          fail(400, "INVALID_DATE", "טווח התאריכים אינו תקין.");
        const job = await store.get("scanJobs/" + body.jobId);
        if (job?.purpose !== "report" || job.status !== "completed")
          fail(400, "REPORT_MISSING", "יש לסרוק דוח להשוואה תחילה.");
        const invoices = v.filterInvoices(
            await accounting.all("invoices"),
            body,
          ),
          suppliers = await accounting.all("suppliers");
        send(200, {
          ...reconcile(
            job.result.rows.filter(
              (r) =>
                !r.invoiceDate ||
                (r.invoiceDate >= body.from && r.invoiceDate <= body.to),
            ),
            invoices,
            suppliers,
          ),
          warnings: job.result.warnings,
          needsReview: job.result.needsReview,
        });
        return;
      }
      if (path === "backup" && method === "GET") {
        send(200, await accounting.backup());
        return;
      }
      fail(404, "NOT_FOUND", "הפעולה לא נמצאה.");
    } catch (error) {
      const known = error instanceof AppError;
      category = known ? error.code : "INTERNAL";
      diagnostic = known ? error.diagnostic : safeDiagnostic(error);
      if (!res.headersSent)
        send(known ? error.status : 500, {
          error: {
            code: category,
            message: known
              ? error.message
              : req.method === "GET"
                ? "הטעינה לא הושלמה בגלל תקלה בשירות. נסה שוב בעוד רגע."
                : "השמירה לא הושלמה. הנתונים שהזנת נשארו בטיוטה; נסה שוב.",
            requestId,
            ...(known && error.details ? { details: error.details } : {}),
          },
        });
      else res.end();
    } finally {
      log({
        requestId,
        endpoint: route,
        method: req.method,
        status: res.statusCode,
        durationMs: Date.now() - start,
        model: route.includes("scan") ? config.model : undefined,
        errorCategory: category,
        ...diagnostic,
      });
    }
  };
}
