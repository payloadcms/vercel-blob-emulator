import { config } from "./config.ts";
import type { BlobMeta, PutBlobResult, HeadBlobResult } from "./types.ts";

export function blobUrl(pathname: string, _access: "public" | "private"): string {
  return `${config.baseUrl}/${pathname}`;
}

export function downloadUrl(pathname: string, access: "public" | "private"): string {
  return `${blobUrl(pathname, access)}?download=1`;
}

export function pathnameFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a valid absolute URL — treat as a raw pathname already
    return url.split("?")[0].replace(/^\//, "");
  }

  return parsed.pathname.replace(/^\//, "");
}

export function contentDisposition(pathname: string, forDownload: boolean): string {
  const filename = pathname.split("/").pop() ?? pathname;
  const disposition = forDownload ? "attachment" : "inline";
  return `${disposition}; filename="${filename}"`;
}

export function metaToResult(meta: BlobMeta): HeadBlobResult {
  return {
    url: blobUrl(meta.pathname, meta.access),
    downloadUrl: downloadUrl(meta.pathname, meta.access),
    pathname: meta.pathname,
    contentType: meta.contentType,
    contentDisposition: contentDisposition(meta.pathname, false),
    etag: meta.etag,
    size: meta.size,
    uploadedAt: meta.uploadedAt,
    cacheControl: meta.cacheControl,
  };
}

export function metaToPutResult(meta: BlobMeta): PutBlobResult {
  return {
    url: blobUrl(meta.pathname, meta.access),
    downloadUrl: downloadUrl(meta.pathname, meta.access),
    pathname: meta.pathname,
    contentType: meta.contentType,
    contentDisposition: contentDisposition(meta.pathname, false),
    etag: meta.etag,
  };
}
