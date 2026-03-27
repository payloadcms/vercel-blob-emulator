import { Hono } from "hono";
import { readMeta, readBlobStream } from "../store.ts";
import { contentDisposition } from "../urls.ts";

const serve = new Hono();

// GET /{...pathname}
// Note: c.req.param("*") is not populated in Hono 4.x; use a named regex capture instead.
serve.get("/:pathname{.+}", async (c) => {
  const pathname = c.req.param("pathname");

  if (!pathname) return c.json({ error: "Not Found" }, 404);

  let meta;
  try {
    meta = await readMeta(pathname);
  } catch {
    return c.json({ error: "Not Found" }, 404);
  }

  const etag = meta.etag;
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  const forDownload = c.req.query("download") === "1";
  const stream = readBlobStream(pathname);

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": meta.contentType,
      "Content-Disposition": contentDisposition(pathname, forDownload),
      "Cache-Control": meta.cacheControl,
      ETag: meta.etag,
      "Content-Length": String(meta.size),
    },
  });
});

export { serve };
