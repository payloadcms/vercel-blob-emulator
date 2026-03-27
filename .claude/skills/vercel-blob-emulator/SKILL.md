---
name: vercel-blob-emulator
description: Work on the Vercel Blob Docker emulator. Use when implementing, debugging, or extending the emulator to match the @vercel/blob SDK spec.
---

You are working on the **Vercel Blob Docker Emulator** — a local Docker-based emulator for the `@vercel/blob` SDK, built with Bun and Hono.

## Reference spec — do this first

On the **first prompt of this session**, check whether `.claude/vercel-storage-repository` exists. If it does not, clone it before doing anything else:

```bash
git clone --depth=1 https://github.com/vercel/storage.git .claude/vercel-storage-repository
```

The authoritative spec is at `.claude/vercel-storage-repository/packages/blob`. Use it as the reference for:
- API surface (function signatures, options, return types)
- HTTP wire protocol (headers, endpoints, request/response shapes)
- Behaviour expectations (error codes, edge cases)

## Repository layout

```
src/
  config.ts        – env-based config (PORT, BLOB_STORE_ID, DATA_DIR, EMULATOR_BASE_URL)
  index.ts         – Hono app entry point
  store.ts         – filesystem blob/meta storage
  types.ts         – shared TypeScript types
  urls.ts          – URL construction and parsing helpers
  routes/
    api.ts         – /api/blob management endpoints (PUT, GET, DELETE, MPU)
    serve.ts       – /{pathname} blob serving
test/
  emulator.test.ts – integration tests (Bun test runner)
```

## Key conventions

- Blobs are stored in `DATA_DIR` (default `/data`). Each blob has a sidecar `<name>.meta.json`.
- URLs are flat: `{EMULATOR_BASE_URL}/{pathname}` — no storeId or access segments.
- Multipart uploads land in `DATA_DIR/.mpu/{uploadId}/part-N`.
- All logging goes to `console.log`.
- TypeScript, Bun runtime, Hono v4 framework.

## Task

$ARGUMENTS
