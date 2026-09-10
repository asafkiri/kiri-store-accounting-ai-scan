import { createServer } from "node:http";
import { configFromEnv } from "./config.js";
import { firebaseServices } from "./firebase.js";
import { createHandler } from "./http.js";
const config = configFromEnv();
const server = createServer(
  { requestTimeout: 55_000, headersTimeout: 15_000, maxHeaderSize: 16 * 1024 },
  createHandler({ ...firebaseServices(config), config }),
);
server.keepAliveTimeout = 5000;
server.listen(config.port, "0.0.0.0", () =>
  console.log(
    JSON.stringify({
      event: "listening",
      port: config.port,
      model: config.model,
      allowlistConfigured: Boolean(config.allowedPhone || config.allowedUid),
    }),
  ),
);
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
});
