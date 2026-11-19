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
import {
  checkClientToken,
  checkSize,
  parseClientToken,
  toErrorBody,
  type ClientTokenError,
} from "../clientToken.ts";

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

function getContentLength(value: string | undefined): number | undefined {
  const length = value === undefined ? NaN : parseInt(value, 10);
  return Number.isNaN(length) ? undefined : length;
}

function getContentType(header: (name: string) => string | undefined): string {
  return header("x-content-type") ?? header("content-type") ?? "application/octet-stream";
}

/**
 * Upload options a client token signs. Vercel Blob takes them from the token, and the SDK refuses
 * to send them from the browser, so they replace the request headers for client-token requests.
 */
function getUploadOptions(
  authorization: string | undefined,
  header: (name: string) => string | undefined,
): { addRandomSuffix: boolean; allowOverwrite: boolean; cacheControlMaxAge?: string } {
  const token = parseClientToken(authorization)?.payload;

  if (token) {
    return {
      addRandomSuffix: token.addRandomSuffix === true,
      allowOverwrite: token.allowOverwrite === true,
      cacheControlMaxAge: token.cacheControlMaxAge?.toString(),
    };
  }

  return {
    addRandomSuffix: header("x-add-random-suffix") === "1",
    allowOverwrite: header("x-allow-overwrite") === "1",
    cacheControlMaxAge: header("x-cache-control-max-age"),
  };
}

function rejectClientToken(
  c: { json: (body: object, status: 400 | 403) => Response },
  error: ClientTokenError,
): Response {
  return c.json(toErrorBody(error), error.status);
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
  const requestedPathname = c.req.query("pathname");
  if (!requestedPathname) return c.json({ error: "pathname is required" }, 400);

  const header = (name: string) => c.req.header(name);
  const authorization = c.req.header("authorization");
  const contentType = getContentType(header);

  const tokenError = checkClientToken({
    authorization,
    contentType,
    pathname: requestedPathname,
    size: getContentLength(c.req.header("content-length")),
  });
  if (tokenError) return rejectClientToken(c, tokenError);

  const options = getUploadOptions(authorization, header);
  const pathname = options.addRandomSuffix
    ? addSuffix(requestedPathname)
    : requestedPathname;

  if (!options.allowOverwrite && (await blobExists(pathname))) {
    return c.json({ error: "Blob already exists" }, 400);
  }

  const access =
    c.req.header("x-vercel-blob-access") === "private" ? "private" : "public";
  const cacheControl = defaultCacheControl(options.cacheControlMaxAge);

  const meta = await writeBlob(pathname, c.req.raw.body, {
    contentType,
    cacheControl,
    access,
    pathname,
  });

  // A streamed body has no declared length, so its size is only known once it is written.
  const token = parseClientToken(authorization);
  const sizeError = token && checkSize({ payload: token.payload, size: meta.size });
  if (sizeError) {
    await deleteBlob(pathname);
    return rejectClientToken(c, sizeError);
  }

  console.log(`blob created: ${pathname} (${meta.size} bytes, ${contentType})`);
  const result = metaToPutResult(meta);
  fireCallback(authorization, result);
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
  const header = (name: string) => c.req.header(name);
  const authorization = c.req.header("authorization");
  // The SDK sends the pathname on every multipart request, so each one is checked against the token.
  const requestedPathname = c.req.query("pathname");

  if (requestedPathname) {
    const tokenError = checkClientToken({
      authorization,
      // Multipart requests only name the blob's type in `x-content-type`; `content-type` is the body's.
      contentType: action === "upload" ? undefined : c.req.header("x-content-type"),
      pathname: requestedPathname,
      size:
        action === "upload"
          ? getContentLength(c.req.header("content-length"))
          : undefined,
    });
    if (tokenError) return rejectClientToken(c, tokenError);
  } else if (parseClientToken(authorization)) {
    return c.json({ error: "pathname is required" }, 400);
  }

  if (action === "create") {
    const pathname = requestedPathname;
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
    if (requestedPathname && key !== requestedPathname) {
      return c.json({ error: "key does not match pathname" }, 400);
    }

    const options = getUploadOptions(authorization, header);
    if (!options.allowOverwrite && (await blobExists(key))) {
      return c.json({ error: "Blob already exists" }, 400);
    }

    const parts = await c.req.json<{ etag: string; partNumber: number }[]>();
    const access =
      c.req.header("x-vercel-blob-access") === "private" ? "private" : "public";
    // The complete request sends JSON, so only `x-content-type` names the blob's type.
    const contentType = c.req.header("x-content-type") ?? "application/octet-stream";
    const cacheControl = defaultCacheControl(options.cacheControlMaxAge);

    const meta = await mpuComplete(uploadId, key, parts, {
      contentType,
      cacheControl,
      access,
      pathname: key,
    });

    const token = parseClientToken(authorization);
    const sizeError = token && checkSize({ payload: token.payload, size: meta.size });
    if (sizeError) {
      await deleteBlob(key);
      return rejectClientToken(c, sizeError);
    }

    console.log(`blob created (mpu): ${key} (${meta.size} bytes, ${contentType})`);
    const result = metaToPutResult(meta);
    fireCallback(authorization, result);
    return c.json(result, 200);
  }

  return c.json({ error: "Unknown x-mpu-action" }, 400);
});

export { api };
