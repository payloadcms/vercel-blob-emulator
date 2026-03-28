FROM oven/bun:alpine AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun build src/index.ts --outdir dist --target bun

FROM oven/bun:alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
VOLUME ["/data"]
EXPOSE 3000
LABEL org.opencontainers.image.title="vercel-blob-emulator" \
      org.opencontainers.image.description="A local emulator for the Vercel Blob API, compatible with the @vercel/blob SDK" \
      org.opencontainers.image.vendor="Payload" \
      org.opencontainers.image.authors="Payload <dev@payloadcms.com>" \
      org.opencontainers.image.version="1.0.1" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://github.com/payloadcms/vercel-blob-emulator" \
      org.opencontainers.image.source="https://github.com/payloadcms/vercel-blob-emulator"
CMD ["bun", "run", "dist/index.js"]
