import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.ts";
import { api } from "./routes/api.ts";
import { serve } from "./routes/serve.ts";

const app = new Hono();

// Permissive CORS for browser client uploads
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "PUT", "POST", "DELETE", "OPTIONS"],
  }),
);

// Hono v4 does not match /api/blob/ (trailing slash) to a subrouter mounted at
// /api/blob.  The @vercel/blob SDK's put() sends "PUT /?pathname=…" which
// produces path /api/blob/.  Intercept that exact case and re-dispatch without
// the trailing slash so the subrouter can match it.
app.use("/api/blob/", async (c, next) => {
  if (c.req.path === "/api/blob/") {
    const url = new URL(c.req.url);
    url.pathname = "/api/blob";
    return app.fetch(new Request(url, c.req.raw));
  }
  return next();
});

// Management API
app.route("/api/blob", api);

// Blob serving
app.route("/", serve);

console.log(
  `Vercel Blob Emulator listening on port ${config.port} — base URL: ${config.baseUrl}`,
);

export default {
  port: config.port,
  fetch: app.fetch,
};
