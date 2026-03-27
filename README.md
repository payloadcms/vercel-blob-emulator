# Vercel Blob Emulator

> [!WARNING]
> **NOT FOR PRODUCTION USE.**
> This emulator has no authentication, no access control, and no data encryption.
> Any request can read, write, or delete any blob without credentials.
> Use [Vercel Blob](https://vercel.com/docs/vercel-blob) in production.

A local emulator for the [Vercel Blob](https://vercel.com/docs/vercel-blob) API,
compatible with the `@vercel/blob` SDK.

## Supported operations

- Server-side: `put`, `head`, `list`, `del`, `copy`
- Client-side uploads via `upload()` with `handleUpload` token flow
- Multipart uploads
- Blob serving with ETags, cache headers, and download mode
- Cursor-based pagination and folded listing
- `onUploadCompleted` callbacks signed with `x-vercel-signature`

## Installation

### Docker CLI

```bash
docker run -p 3100:3000 \
  -e EMULATOR_BASE_URL=http://localhost:3100 \
  -v vercel_blob_data:/data \
  ghcr.io/payloadcms/vercel-blob-emulator:latest
```

### Docker Compose

```yaml
services:
  vercel-blob:
    image: ghcr.io/payloadcms/vercel-blob-emulator:latest
    container_name: vercel-blob
    ports:
      - "3100:3000"
    environment:
      EMULATOR_BASE_URL: "http://localhost:3100"
    volumes:
      - vercel_blob_data:/data

volumes:
  vercel_blob_data:
```

## Environment variables

### In your app

```env
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_emulator_local  # any vercel_blob_rw_<id>_<anything> value works
VERCEL_BLOB_API_URL=http://localhost:3100/api/blob
NEXT_PUBLIC_VERCEL_BLOB_API_URL=http://localhost:3100/api/blob
STORAGE_VERCEL_BLOB_BASE_URL=http://localhost:3100    # Must be set if you use @payloadcms/vercel-blob
VERCEL_BLOB_RETRIES=0                                 # recommended for tests
VERCEL_BLOB_CALLBACK_URL=http://localhost:3000        # your app's base URL; omit if onUploadCompleted is unused
```

### In the emulator container

| Variable                | Default                 | Description                                                                                                                  |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `3000`                  | Port the emulator listens on.                                                                                                |
| `BLOB_STORE_ID`         | `emulator`              | Store identifier (used internally).                                                                                          |
| `DATA_DIR`              | `/data`                 | Directory where blobs and metadata are stored.                                                                               |
| `EMULATOR_BASE_URL`     | `http://localhost:3000` | Base URL the emulator uses when constructing blob URLs. Set this if the emulator is behind a proxy or on a non-default port. |
| `BLOB_READ_WRITE_TOKEN` | _(none)_                | Must match the token used by your app. Required for signing `onUploadCompleted` callbacks.                                   |
