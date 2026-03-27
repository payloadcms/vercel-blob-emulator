export const config = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  storeId: process.env.BLOB_STORE_ID ?? "emulator",
  dataDir: process.env.DATA_DIR ?? "/data",
  baseUrl: process.env.EMULATOR_BASE_URL ?? "http://localhost:3000",
  readWriteToken: process.env.BLOB_READ_WRITE_TOKEN ?? "",
} as const;
