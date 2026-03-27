import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  rm,
  stat,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { config } from "./config.ts";
import type { BlobMeta } from "./types.ts";

function blobPath(pathname: string): string {
  return join(config.dataDir, pathname);
}

function metaPath(pathname: string): string {
  return join(config.dataDir, pathname + ".meta.json");
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function writeBlob(
  pathname: string,
  body: ReadableStream | null,
  meta: Omit<BlobMeta, "size" | "etag" | "uploadedAt">,
): Promise<BlobMeta> {
  const dest = blobPath(pathname);
  await ensureDir(dest);

  const hash = createHash("md5");
  let size = 0;

  if (body) {
    const writer = createWriteStream(dest);
    const reader = body.getReader();
    await new Promise<void>((resolve, reject) => {
      writer.on("error", reject);
      writer.on("finish", resolve);
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            hash.update(value);
            size += value.byteLength;
            writer.write(value);
          }
          writer.end();
        } catch (err) {
          writer.destroy(err as Error);
          reject(err);
        }
      })();
    });
  } else {
    await writeFile(dest, "");
  }

  const etag = `"${hash.digest("hex")}"`;
  const result: BlobMeta = {
    ...meta,
    size,
    etag,
    uploadedAt: new Date().toISOString(),
  };

  await ensureDir(metaPath(pathname));
  await writeFile(metaPath(pathname), JSON.stringify(result, null, 2));
  return result;
}

export async function readMeta(pathname: string): Promise<BlobMeta> {
  const data = await readFile(metaPath(pathname), "utf-8");
  return JSON.parse(data) as BlobMeta;
}

export function readBlobStream(pathname: string): ReadableStream<Uint8Array> {
  const path = blobPath(pathname);
  const nodeStream = createReadStream(path);
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) =>
        controller.enqueue(
          typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        ),
      );
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

export async function blobExists(pathname: string): Promise<boolean> {
  try {
    await stat(metaPath(pathname));
    return true;
  } catch {
    return false;
  }
}

export async function deleteBlob(pathname: string): Promise<void> {
  await Promise.allSettled([
    rm(blobPath(pathname), { force: true }),
    rm(metaPath(pathname), { force: true }),
  ]);
}

async function walkMeta(dir: string, base: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry === ".mpu") continue;
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      results.push(...(await walkMeta(full, rel)));
    } else if (entry.endsWith(".meta.json")) {
      results.push(rel.slice(0, -".meta.json".length));
    }
  }
  return results;
}

export async function listBlobs(
  prefix?: string,
  limit = 1000,
  cursor?: string,
): Promise<{ blobs: BlobMeta[]; hasMore: boolean; cursor?: string }> {
  const all = await walkMeta(config.dataDir, "");
  let filtered = prefix ? all.filter((p) => p.startsWith(prefix)) : all;

  // Load metas and sort by uploadedAt
  const metas = await Promise.all(
    filtered.map(async (p) => {
      try {
        return await readMeta(p);
      } catch {
        return null;
      }
    }),
  );
  const valid = metas.filter(Boolean) as BlobMeta[];
  valid.sort(
    (a, b) =>
      new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime(),
  );

  // Apply cursor
  let startIdx = 0;
  if (cursor) {
    const cursorPathname = Buffer.from(cursor, "base64").toString("utf-8");
    const idx = valid.findIndex((m) => m.pathname === cursorPathname);
    if (idx !== -1) startIdx = idx + 1;
  }

  const page = valid.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < valid.length;
  const nextCursor = hasMore
    ? Buffer.from(page[page.length - 1].pathname).toString("base64")
    : undefined;

  return { blobs: page, hasMore, cursor: nextCursor };
}

export async function listFolded(
  prefix?: string,
  limit = 1000,
  cursor?: string,
): Promise<{
  blobs: BlobMeta[];
  folders: string[];
  hasMore: boolean;
  cursor?: string;
}> {
  const {
    blobs,
    hasMore,
    cursor: nextCursor,
  } = await listBlobs(prefix, limit, cursor);

  const prefixLen = prefix ? prefix.length : 0;
  const folderSet = new Set<string>();
  const directBlobs: BlobMeta[] = [];

  for (const blob of blobs) {
    const rel = blob.pathname.slice(prefixLen);
    const slashIdx = rel.indexOf("/");
    if (slashIdx !== -1) {
      folderSet.add((prefix ?? "") + rel.slice(0, slashIdx + 1));
    } else {
      directBlobs.push(blob);
    }
  }

  return {
    blobs: directBlobs,
    folders: [...folderSet].sort(),
    hasMore,
    cursor: nextCursor,
  };
}

// ---------- MPU ----------

function mpuDir(uploadId: string): string {
  return join(config.dataDir, ".mpu", uploadId);
}

export async function mpuCreate(uploadId: string): Promise<void> {
  await mkdir(mpuDir(uploadId), { recursive: true });
}

export async function mpuWritePart(
  uploadId: string,
  partNumber: number,
  body: ReadableStream,
): Promise<string> {
  const partPath = join(mpuDir(uploadId), `part-${partNumber}`);
  const hash = createHash("md5");
  const writer = createWriteStream(partPath);

  const reader = body.getReader();
  await new Promise<void>((resolve, reject) => {
    writer.on("error", reject);
    writer.on("finish", resolve);
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          writer.write(value);
        }
        writer.end();
      } catch (err) {
        writer.destroy(err as Error);
        reject(err);
      }
    })();
  });

  return `"${hash.digest("hex")}"`;
}

export async function mpuComplete(
  uploadId: string,
  pathname: string,
  parts: { etag: string; partNumber: number }[],
  meta: Omit<BlobMeta, "size" | "etag" | "uploadedAt">,
): Promise<BlobMeta> {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const dest = blobPath(pathname);
  await ensureDir(dest);

  const hash = createHash("md5");
  let size = 0;
  const writer = createWriteStream(dest);

  await new Promise<void>((resolve, reject) => {
    writer.on("error", reject);
    writer.on("finish", resolve);
    (async () => {
      try {
        for (const part of sorted) {
          const partPath = join(mpuDir(uploadId), `part-${part.partNumber}`);
          const data = await readFile(partPath);
          hash.update(data);
          size += data.byteLength;
          writer.write(data);
        }
        writer.end();
      } catch (err) {
        writer.destroy(err as Error);
        reject(err);
      }
    })();
  });

  const etag = `"${hash.digest("hex")}"`;
  const result: BlobMeta = {
    ...meta,
    size,
    etag,
    uploadedAt: new Date().toISOString(),
  };

  await writeFile(metaPath(pathname), JSON.stringify(result, null, 2));
  await rm(mpuDir(uploadId), { recursive: true, force: true });
  return result;
}
