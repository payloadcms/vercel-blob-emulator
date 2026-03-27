export interface BlobMeta {
  contentType: string;
  size: number;
  uploadedAt: string; // ISO 8601
  etag: string;       // "\"hex\""
  cacheControl: string;
  access: "public" | "private";
  pathname: string;
}

export interface PutBlobResult {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentType: string;
  contentDisposition: string;
  etag: string;
}

export interface HeadBlobResult extends PutBlobResult {
  size: number;
  uploadedAt: string;
  cacheControl: string;
}

export interface BlobListEntry extends HeadBlobResult {}

export interface ListBlobResult {
  blobs: BlobListEntry[];
  hasMore: boolean;
  cursor?: string;
  folders?: string[];
}

export interface MpuCreateResult {
  uploadId: string;
  key: string;
}

export interface MpuUploadResult {
  etag: string;
}
