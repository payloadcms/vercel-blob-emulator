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
LABEL org.opencontainers.image.version="1.0.0"
CMD ["bun", "run", "dist/index.js"]
