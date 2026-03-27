import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobNotFoundError, del, head, list, put } from "@vercel/blob";
import {
  handleUpload,
  upload,
  type HandleUploadBody,
} from "@vercel/blob/client";

// Fixed port for the test server; must be stable so that config.baseUrl (frozen at
// import time) matches the actual listening address.
const STORE_ID = "teststore";
const PORT = 19876;
const BASE_URL = `http://localhost:${PORT}`;

let server: ReturnType<typeof Bun.serve>;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "blob-emulator-test-"));

  // Must be set BEFORE the emulator modules are dynamically imported, because
  // config.ts evaluates process.env at module-initialisation time.
  process.env.PORT = String(PORT);
  process.env.BLOB_STORE_ID = STORE_ID;
  process.env.DATA_DIR = dataDir;
  process.env.EMULATOR_BASE_URL = BASE_URL;

  // The @vercel/blob SDK reads these lazily (inside function bodies), so setting
  // them here (after static imports) is fine.
  process.env.VERCEL_BLOB_API_URL = `${BASE_URL}/api/blob`;
  process.env.BLOB_READ_WRITE_TOKEN = `vercel_blob_rw_${STORE_ID}_testtoken`;
  // Disable retries so test failures surface immediately.
  process.env.VERCEL_BLOB_RETRIES = "0";

  const { default: app } = await import("../src/index.ts");
  server = Bun.serve({ port: PORT, fetch: app.fetch });
});

afterAll(async () => {
  server?.stop(true);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// put
// ---------------------------------------------------------------------------

describe("put", () => {
  test("uploads text content and returns the expected result shape", async () => {
    const result = await put("put/hello.txt", "Hello, World!", {
      access: "public",
      contentType: "text/plain",
    });

    expect(result.url).toBe(`${BASE_URL}/put/hello.txt`);
    expect(result.url).toContain("hello.txt");
    expect(result.pathname).toBe("put/hello.txt");
    expect(result.contentType).toBe("text/plain");
    expect(result.etag).toBeTruthy();
    expect(result.downloadUrl).toContain("download=1");
    expect(result.contentDisposition).toContain("hello.txt");
  });

  test("appends a random hex suffix when addRandomSuffix is true", async () => {
    const result = await put(
      "put/img.png",
      new Uint8Array([137, 80, 78, 71]) as unknown as ReadableStream,
      {
        access: "public",
        addRandomSuffix: true,
      },
    );

    expect(result.pathname).toMatch(/^put\/img-[0-9a-f]+\.png$/);
    expect(result.url).toContain(result.pathname);
  });

  test("rejects a duplicate pathname without allowOverwrite", async () => {
    await put("put/unique.txt", "first", { access: "public" });

    await expect(
      put("put/unique.txt", "second", { access: "public" }),
    ).rejects.toThrow();
  });

  test("overwrites an existing blob when allowOverwrite is true", async () => {
    await put("put/overwrite.txt", "v1", {
      access: "public",
      allowOverwrite: true,
    });

    const result = await put("put/overwrite.txt", "v2", {
      access: "public",
      allowOverwrite: true,
    });

    expect(result.pathname).toBe("put/overwrite.txt");
  });
});

// ---------------------------------------------------------------------------
// head
// ---------------------------------------------------------------------------

describe("head", () => {
  test("returns metadata for an existing blob", async () => {
    const content = "metadata test";
    const uploaded = await put("head/meta.txt", content, {
      access: "public",
      contentType: "text/plain",
    });

    const meta = await head(uploaded.url);

    expect(meta.pathname).toBe("head/meta.txt");
    expect(meta.contentType).toBe("text/plain");
    expect(meta.size).toBe(Buffer.byteLength(content));
    expect(meta.url).toBe(uploaded.url);
    expect(meta.etag).toBe(uploaded.etag);
    expect(meta.uploadedAt).toBeInstanceOf(Date);
    expect(meta.cacheControl).toMatch(/public, max-age=/);
  });

  test("throws BlobNotFoundError for a nonexistent blob", async () => {
    await expect(head(`${BASE_URL}/does-not-exist.txt`)).rejects.toThrow(BlobNotFoundError);
  });

  test("resolves metadata when given a production-format blob URL", async () => {
    // Upload via the emulator so the file exists on disk.
    const content = "external url test";
    await put("head/extern.txt", content, {
      access: "public",
      contentType: "text/plain",
    });

    // Simulate the URL a real Vercel Blob store would return:
    // https://{storeId}.public.blob.vercel-storage.com/{pathname}
    const productionUrl = `https://${STORE_ID}.public.blob.vercel-storage.com/head/extern.txt`;

    // The emulator receives GET /api/blob?url=<productionUrl> and must strip
    // the host to recover the pathname "head/extern.txt".
    const res = await fetch(
      `${BASE_URL}/api/blob?url=${encodeURIComponent(productionUrl)}`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { pathname: string; size: number };
    expect(body.pathname).toBe("head/extern.txt");
    expect(body.size).toBe(Buffer.byteLength(content));
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  test("returns blobs that match the given prefix", async () => {
    await put("list/a.txt", "a", { access: "public" });
    await put("list/b.txt", "b", { access: "public" });

    const result = await list({ prefix: "list/" });
    const pathnames = result.blobs.map((b) => b.pathname);

    expect(pathnames).toContain("list/a.txt");
    expect(pathnames).toContain("list/b.txt");
    expect(result.hasMore).toBe(false);
  });

  test("paginates results with limit and cursor", async () => {
    // list/a.txt and list/b.txt were created by the previous test.
    const first = await list({ prefix: "list/", limit: 1 });
    expect(first.blobs).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBeTruthy();

    const second = await list({
      prefix: "list/",
      limit: 1,
      cursor: first.cursor,
    });
    expect(second.blobs).toHaveLength(1);
    expect(second.blobs[0].pathname).not.toBe(first.blobs[0].pathname);
  });

  test("groups nested paths into virtual folders in folded mode", async () => {
    await put("folded/dir/file.txt", "x", { access: "public" });
    await put("folded/root.txt", "y", { access: "public" });

    const result = await list({ prefix: "folded/", mode: "folded" });
    const blobPaths = result.blobs.map((b) => b.pathname);

    expect(blobPaths).toContain("folded/root.txt");
    expect((result as { folders: string[] }).folders).toContain("folded/dir/");
  });
});

// ---------------------------------------------------------------------------
// del
// ---------------------------------------------------------------------------

describe("del", () => {
  test("removes a single blob", async () => {
    const r = await put("del/single.txt", "bye", { access: "public" });

    await del(r.url);

    await expect(head(r.url)).rejects.toThrow();
  });

  test("removes multiple blobs at once", async () => {
    const [a, b] = await Promise.all([
      put("del/multi-a.txt", "a", { access: "public" }),
      put("del/multi-b.txt", "b", { access: "public" }),
    ]);

    await del([a.url, b.url]);

    await Promise.all([
      expect(head(a.url)).rejects.toThrow(),
      expect(head(b.url)).rejects.toThrow(),
    ]);
  });
});

// ---------------------------------------------------------------------------
// serve  (direct HTTP, exercising the serve route)
// ---------------------------------------------------------------------------

describe("serve", () => {
  test("responds with the blob body and correct headers", async () => {
    const content = "Hello, serve!";
    const r = await put("serve/text.txt", content, {
      access: "public",
      contentType: "text/plain",
    });

    const res = await fetch(r.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(content);
  });

  test("returns 304 when If-None-Match matches the stored ETag", async () => {
    const r = await put("serve/etag.txt", "etag content", {
      access: "public",
    });
    const meta = await head(r.url);

    const res = await fetch(r.url, {
      headers: { "if-none-match": meta.etag },
    });
    expect(res.status).toBe(304);
  });

  test("serves the blob as an attachment when ?download=1 is present", async () => {
    const r = await put("serve/download.txt", "download me", {
      access: "public",
    });

    const res = await fetch(r.downloadUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  test("returns 404 with not_found error body for an unknown blob URL", async () => {
    const res = await fetch(`${BASE_URL}/no-such-file.txt`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// subfolders
// ---------------------------------------------------------------------------

describe("subfolders", () => {
  test("put creates intermediate directories (a/b/c/image.png)", async () => {
    const result = await put("a/b/c/image.png", "nested content", {
      access: "public",
      contentType: "image/png",
    });

    expect(result.pathname).toBe("a/b/c/image.png");
    expect(result.url).toBe(`${BASE_URL}/a/b/c/image.png`);
  });

  test("serve retrieves a deeply nested blob", async () => {
    const content = "deep content";
    const r = await put("x/y/z/deep.txt", content, {
      access: "public",
      contentType: "text/plain",
    });

    const res = await fetch(r.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
  });

  test("head returns correct metadata for a deeply nested blob", async () => {
    const content = "meta deep";
    const r = await put("deep/meta/file.txt", content, {
      access: "public",
      contentType: "text/plain",
    });

    const meta = await head(r.url);
    expect(meta.pathname).toBe("deep/meta/file.txt");
    expect(meta.size).toBe(Buffer.byteLength(content));
  });

  test("list returns deeply nested blobs with prefix filter", async () => {
    await put("nested/a/b/one.txt", "1", { access: "public" });
    await put("nested/a/b/two.txt", "2", { access: "public" });

    const result = await list({ prefix: "nested/a/b/" });
    const pathnames = result.blobs.map((b) => b.pathname);
    expect(pathnames).toContain("nested/a/b/one.txt");
    expect(pathnames).toContain("nested/a/b/two.txt");
  });

  test("folded mode exposes only the immediate virtual folder for deep paths", async () => {
    await put("folded-deep/a/b/c/file.txt", "x", { access: "public" });

    const result = await list({ prefix: "folded-deep/", mode: "folded" });
    expect((result as { folders: string[] }).folders).toContain("folded-deep/a/");
    // The file should not appear as a direct blob (it's inside a subfolder)
    const directPathnames = result.blobs.map((b) => b.pathname);
    expect(directPathnames).not.toContain("folded-deep/a/b/c/file.txt");
  });

  test("del removes a deeply nested blob", async () => {
    const r = await put("del/deep/nested/file.txt", "bye", {
      access: "public",
    });

    await del(r.url);

    await expect(head(r.url)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// multipart upload  (put with multipart:true drives the /mpu endpoints)
// ---------------------------------------------------------------------------

describe("multipart upload", () => {
  test("assembles content that was uploaded in multiple parts", async () => {
    const content = "chunk".repeat(1024); // ~5 KB — split into SDK-managed parts
    const r = await put("mpu/chunked.txt", content, {
      access: "public",
      contentType: "text/plain",
      multipart: true,
    });

    expect(r.pathname).toBe("mpu/chunked.txt");
    expect(r.url).toBe(`${BASE_URL}/mpu/chunked.txt`);

    const meta = await head(r.url);
    expect(meta.size).toBe(content.length);

    const res = await fetch(r.url);
    expect(await res.text()).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// client upload  (upload() from @vercel/blob/client)
// ---------------------------------------------------------------------------
//
// The upload() flow:
//   1. SDK POSTs to handleUploadUrl with { type: 'blob.generate-client-token', payload: { pathname, ... } }
//   2. handleUploadUrl server calls generateClientTokenFromReadWriteToken and returns the token
//   3. SDK PUTs the blob to VERCEL_BLOB_API_URL (the emulator) using that client token
//
// We spin up a tiny Bun server on a separate port to act as the handleUploadUrl endpoint.

describe("client upload (upload())", () => {
  const TOKEN_SERVER_PORT = 19877;
  const TOKEN_SERVER_URL = `http://localhost:${TOKEN_SERVER_PORT}`;
  let tokenServer: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    tokenServer = Bun.serve({
      port: TOKEN_SERVER_PORT,
      async fetch(req) {
        const body = (await req.json()) as HandleUploadBody;
        const result = await handleUpload({
          request: req,
          body,
          onBeforeGenerateToken: async () => ({}),
        });
        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json" },
        });
      },
    });
  });

  afterAll(() => {
    tokenServer?.stop(true);
  });

  test("fetches a client token then uploads text content to the emulator", async () => {
    const content = "Hello from the client!";
    const result = await upload("client-upload/hello.txt", content, {
      access: "public",
      handleUploadUrl: TOKEN_SERVER_URL,
      contentType: "text/plain",
    });

    expect(result.url).toBe(`${BASE_URL}/client-upload/hello.txt`);
    expect(result.url).toContain("hello.txt");
    expect(result.pathname).toBe("client-upload/hello.txt");
    expect(result.contentType).toContain("text/plain");
    expect(result.etag).toBeTruthy();
    expect(result.downloadUrl).toContain("download=1");

    // Verify the blob is actually retrievable
    const meta = await head(result.url);
    expect(meta.pathname).toBe("client-upload/hello.txt");
    expect(meta.size).toBe(Buffer.byteLength(content));
  });

  test("forwards clientPayload to onBeforeGenerateToken and uploads successfully", async () => {
    let capturedPayload: string | null = null;

    const customTokenServer = Bun.serve({
      port: TOKEN_SERVER_PORT + 1,
      async fetch(req) {
        const body = (await req.json()) as HandleUploadBody;
        const result = await handleUpload({
          request: req,
          body,
          onBeforeGenerateToken: async (_pathname, clientPayload) => {
            capturedPayload = clientPayload;
            return {};
          },
        });
        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    try {
      await upload("client-upload/payload.txt", "payload test", {
        access: "public",
        handleUploadUrl: `http://localhost:${TOKEN_SERVER_PORT + 1}`,
        clientPayload: "my-custom-payload",
      });

      // @ts-expect-error
      expect(capturedPayload).toBe("my-custom-payload");
    } finally {
      customTokenServer.stop(true);
    }
  });

  test("uploads binary content and serves it back correctly", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

    const result = await upload(
      "client-upload/image.png",
      bytes as unknown as ReadableStream,
      {
        access: "public",
        handleUploadUrl: TOKEN_SERVER_URL,
        contentType: "image/png",
      },
    );

    expect(result.pathname).toBe("client-upload/image.png");
    expect(result.contentType).toContain("image/png");

    const res = await fetch(result.url);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(bytes);
  });

  test("fires the onUploadCompleted callback with a valid x-vercel-signature", async () => {
    const CALLBACK_PORT = TOKEN_SERVER_PORT + 2;
    const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}`;

    let receivedBodyText: string | null = null;
    let receivedSignature: string | null = null;

    const callbackServer = Bun.serve({
      port: CALLBACK_PORT,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/token") {
          const body = (await req.json()) as HandleUploadBody;
          const result = await handleUpload({
            request: req,
            body,
            onBeforeGenerateToken: async () => ({
              callbackUrl: `${CALLBACK_URL}/callback`,
            }),
            onUploadCompleted: async () => {},
          });
          return new Response(JSON.stringify(result), {
            headers: { "content-type": "application/json" },
          });
        }

        if (url.pathname === "/callback") {
          receivedSignature = req.headers.get("x-vercel-signature");
          receivedBodyText = await req.text();
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      await upload("client-upload/callback.txt", "callback test", {
        access: "public",
        handleUploadUrl: `${CALLBACK_URL}/token`,
      });

      // fireCallback is fire-and-forget; wait for it to land
      await Bun.sleep(200);

      expect(receivedBodyText).not.toBeNull();
      expect(receivedSignature).not.toBeNull();

      // Verify HMAC-SHA256(body, rwToken) matches
      const expectedSig = createHmac(
        "sha256",
        process.env.BLOB_READ_WRITE_TOKEN!,
      )
        .update(receivedBodyText!)
        .digest("hex");
      // @ts-expect-error
      expect(receivedSignature).toBe(expectedSig);

      const parsed = JSON.parse(receivedBodyText!) as {
        type: string;
        payload: { blob: { pathname: string }; tokenPayload: null };
      };
      expect(parsed.type).toBe("blob.upload-completed");
      expect(parsed.payload.blob.pathname).toBe("client-upload/callback.txt");
    } finally {
      callbackServer.stop(true);
    }
  });
});
