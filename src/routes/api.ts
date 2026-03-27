import { Hono } from "hono";
import { createHmac, randomBytes } from "node:crypto";
import { config } from "../config.ts";
import {
  writeBlob,
  readMeta,
  blobExists,
  deleteBlob,
  listBlobs,
  listFolded,
  mpuCreate,
  mpuWritePart,
  mpuComplete,
} from "../store.ts";
import {
  pathnameFromUrl,
  metaToResult,
  metaToPutResult,
  blobUrl,
} from "../urls.ts";
import type { BlobMeta } from "../types.ts";

const api = new Hono();

// ---- Helpers ----

function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

function addSuffix(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  const slash = pathname.lastIndexOf("/");
  if (dot > slash) {
    return pathname.slice(0, dot) + "-" + randomSuffix() + pathname.slice(dot);
  }
  return pathname + "-" + randomSuffix();
}

function defaultCacheControl(maxAge?: string): string {
  const age = parseInt(maxAge ?? "0", 10) || 365 * 24 * 60 * 60;
  return `public, max-age=${age}`;
}

// Fire-and-forget callback after client upload
async function fireCallback(
  authorization: string | undefined,
  blobResult: object,
): Promise<void> {
  if (!authorization) return;
  try {
    // Client token format: vercel_blob_client_{storeId}_{base64("hexHmac.base64Payload")}
    // Matches getPayloadFromClientToken in @vercel/blob
    const token = authorization.replace(/^Bearer\s+/i, "");
    if (!token.startsWith("vercel_blob_client_")) return;
    const parts = token.split("_");
    if (parts.length < 5) return;
    const encodedToken = parts[parts.length - 1];
    const inner = Buffer.from(encodedToken, "base64").toString();
    const encodedPayload = inner.split(".")[1];
    if (!encodedPayload) return;
    const decodedPayload = Buffer.from(encodedPayload, "base64").toString();
    const payload = JSON.parse(decodedPayload) as {
      onUploadCompleted?: { callbackUrl?: string; tokenPayload?: string | null };
    };
    const { callbackUrl, tokenPayload } = payload.onUploadCompleted ?? {};
    if (!callbackUrl) return;

    const body = JSON.stringify({
      type: "blob.upload-completed",
      payload: { blob: blobResult, tokenPayload: tokenPayload ?? null },
    });

    // Sign the body with the rw token so handleUpload can verify it
    const signature = createHmac("sha256", config.readWriteToken)
      .update(body)
      .digest("hex");

    await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-signature": signature,
      },
      body,
    });
  } catch {
    // Silently ignore
  }
}

// ---- PUT /?pathname= ----
api.put("/", async (c) => {
  let pathname = c.req.query("pathname");
  if (!pathname) return c.json({ error: "pathname is required" }, 400);

  if (c.req.header("x-add-random-suffix") === "1") {
    pathname = addSuffix(pathname);
  }

  const allowOverwrite = c.req.header("x-allow-overwrite") === "1";
  if (!allowOverwrite && (await blobExists(pathname))) {
    return c.json({ error: "Blob already exists" }, 400);
  }

  const access =
    c.req.header("x-vercel-blob-access") === "private" ? "private" : "public";
  const contentType =
    c.req.header("x-content-type") ??
    c.req.header("content-type") ??
    "application/octet-stream";
  const cacheControl = defaultCacheControl(
    c.req.header("x-cache-control-max-age"),
  );

  const meta = await writeBlob(pathname, c.req.raw.body, {
    contentType,
    cacheControl,
    access,
    pathname,
  });

  console.log(`blob created: ${pathname} (${meta.size} bytes, ${contentType})`);
  const result = metaToPutResult(meta);
  fireCallback(c.req.header("authorization"), result);
  return c.json(result, 200);
});

// ---- GET / — head or list ----
api.get("/", async (c) => {
  const url = c.req.query("url");

  // HEAD
  if (url) {
    const pathname = pathnameFromUrl(url);

    try {
      const meta = await readMeta(pathname);
      return c.json(metaToResult(meta), 200);
    } catch {
      return c.json(
        { error: { code: "not_found", message: "The requested blob does not exist" } },
        404,
      );
    }
  }

  // LIST
  const prefix = c.req.query("prefix");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "1000", 10), 1000);
  const cursor = c.req.query("cursor");
  const mode = c.req.query("mode");

  if (mode === "folded") {
    const {
      blobs,
      folders,
      hasMore,
      cursor: next,
    } = await listFolded(prefix, limit, cursor);
    return c.json(
      {
        blobs: blobs.map(metaToResult),
        folders,
        hasMore,
        ...(next ? { cursor: next } : {}),
      },
      200,
    );
  }

  const {
    blobs,
    hasMore,
    cursor: next,
  } = await listBlobs(prefix, limit, cursor);
  return c.json(
    {
      blobs: blobs.map(metaToResult),
      hasMore,
      ...(next ? { cursor: next } : {}),
    },
    200,
  );
});

// ---- DELETE /delete ----
api.delete("/delete", async (c) => {
  let urls: string[];
  try {
    const body = await c.req.json<{ urls: string | string[] }>();
    urls = Array.isArray(body.urls) ? body.urls : [body.urls];
  } catch {
    return c.json({ error: "Invalid body" }, 400);
  }

  const pathnames = urls.map(pathnameFromUrl);
  await Promise.all(pathnames.map((p) => deleteBlob(p)));
  console.log(`blob deleted: ${pathnames.join(", ")}`);
  return c.json({}, 200);
});

// ---- POST /delete (SDK compat) ----
api.post("/delete", async (c) => {
  let urls: string[];
  try {
    const body = await c.req.json<{ urls: string | string[] }>();
    urls = Array.isArray(body.urls) ? body.urls : [body.urls];
  } catch {
    return c.json({ error: "Invalid body" }, 400);
  }

  const pathnames = urls.map(pathnameFromUrl);
  await Promise.all(pathnames.map((p) => deleteBlob(p)));
  console.log(`blob deleted: ${pathnames.join(", ")}`);
  return c.json({}, 200);
});

// ---- POST /mpu?pathname= ---- multipart upload ----
api.post("/mpu", async (c) => {
  const action = c.req.header("x-mpu-action");

  if (action === "create") {
    const pathname = c.req.query("pathname");
    if (!pathname) return c.json({ error: "pathname is required" }, 400);
    const uploadId = randomBytes(16).toString("hex");
    await mpuCreate(uploadId);
    return c.json({ uploadId, key: pathname }, 200);
  }

  if (action === "upload") {
    const uploadId = c.req.header("x-mpu-upload-id");
    const partNumber = parseInt(c.req.header("x-mpu-part-number") ?? "0", 10);
    if (!uploadId || !partNumber) {
      return c.json({ error: "Missing uploadId or partNumber" }, 400);
    }
    if (!c.req.raw.body) return c.json({ error: "No body" }, 400);
    const etag = await mpuWritePart(uploadId, partNumber, c.req.raw.body);
    return c.json({ etag }, 200);
  }

  if (action === "complete") {
    const uploadId = c.req.header("x-mpu-upload-id");
    // The SDK encodes the key with encodeURIComponent so it is safe to use as an HTTP header.
    const rawKey = c.req.header("x-mpu-key");
    const key = rawKey ? decodeURIComponent(rawKey) : undefined;
    if (!uploadId || !key) {
      return c.json({ error: "Missing uploadId or key" }, 400);
    }
    const parts = await c.req.json<{ etag: string; partNumber: number }[]>();
    const access =
      c.req.header("x-vercel-blob-access") === "private" ? "private" : "public";
    const contentType =
      c.req.header("x-content-type") ??
      c.req.header("content-type") ??
      "application/octet-stream";
    const cacheControl = defaultCacheControl(
      c.req.header("x-cache-control-max-age"),
    );

    const meta = await mpuComplete(uploadId, key, parts, {
      contentType,
      cacheControl,
      access,
      pathname: key,
    });

    console.log(`blob created (mpu): ${key} (${meta.size} bytes, ${contentType})`);
    const result = metaToPutResult(meta);
    fireCallback(c.req.header("authorization"), result);
    return c.json(result, 200);
  }

  return c.json({ error: "Unknown x-mpu-action" }, 400);
});

export { api };
