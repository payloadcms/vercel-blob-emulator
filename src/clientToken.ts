const CLIENT_TOKEN_PREFIX = "vercel_blob_client_";

/** The options `generateClientTokenFromReadWriteToken` signs into a client token. */
export type ClientTokenPayload = {
  addRandomSuffix?: boolean;
  allowedContentTypes?: string[];
  allowOverwrite?: boolean;
  cacheControlMaxAge?: number;
  maximumSizeInBytes?: number;
  onUploadCompleted?: { callbackUrl?: string; tokenPayload?: string | null };
  pathname?: string;
  validUntil?: number;
};

/**
 * A rejected client-token request. `code` and `message` match what Vercel Blob returns, so the
 * `@vercel/blob` SDK raises the same error classes it raises against the real API.
 */
export type ClientTokenError = {
  code: string;
  message: string;
  status: 400 | 403;
};

function getBearerToken(authorization: string | undefined): string | undefined {
  return authorization?.replace(/^Bearer\s+/i, "");
}

export function isClientToken(authorization: string | undefined): boolean {
  return getBearerToken(authorization)?.startsWith(CLIENT_TOKEN_PREFIX) ?? false;
}

/**
 * The payload of the client token in an `authorization` header, or `null` for a read-write token
 * or a malformed client token.
 *
 * Format: `vercel_blob_client_{storeId}_{base64("hexHmac.base64Payload")}`, matching
 * `getPayloadFromClientToken` in `@vercel/blob`.
 */
export function parseClientToken(authorization: string | undefined): {
  payload: ClientTokenPayload;
} | null {
  const token = getBearerToken(authorization);
  if (!token?.startsWith(CLIENT_TOKEN_PREFIX)) return null;

  const encodedToken = token.split("_")[4];
  if (!encodedToken) return null;

  const encodedPayload = Buffer.from(encodedToken, "base64").toString().split(".")[1];
  if (!encodedPayload) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64").toString(),
    ) as ClientTokenPayload;
    return { payload };
  } catch {
    return null;
  }
}

/**
 * Checks a request against the restrictions signed into its client token. Returns the error to
 * send, or `null` when the request is allowed. Requests with a read-write token are always
 * allowed, as before. The signature is not verified: like the rest of the emulator, this is not
 * access control, only the same upload rules Vercel Blob applies.
 */
export function checkClientToken({
  authorization,
  contentType,
  pathname,
  size,
}: {
  authorization: string | undefined;
  contentType?: string;
  pathname: string;
  /** The body size, when the request declares it. */
  size?: number;
}): ClientTokenError | null {
  if (!isClientToken(authorization)) return null;

  const token = parseClientToken(authorization);
  if (!token) return forbidden();

  const { payload } = token;

  if (payload.validUntil !== undefined && Date.now() > payload.validUntil) {
    return { code: "client_token_expired", message: "Token expired", status: 403 };
  }

  if (payload.pathname !== undefined && payload.pathname !== pathname) {
    return {
      code: "client_token_pathname_mismatch",
      message: `The "pathname" "${pathname}" does not match the token payload "${payload.pathname}".`,
      status: 400,
    };
  }

  if (
    contentType !== undefined &&
    payload.allowedContentTypes?.length &&
    !payload.allowedContentTypes.some((allowed) =>
      isContentTypeAllowed({ allowed, contentType }),
    )
  ) {
    return {
      code: "content_type_not_allowed",
      message: `The contentType "${contentType}" is not allowed.`,
      status: 400,
    };
  }

  return size === undefined ? null : checkSize({ payload, size });
}

/** Rejects a body larger than the token's `maximumSizeInBytes`. */
export function checkSize({
  payload,
  size,
}: {
  payload: ClientTokenPayload;
  size: number;
}): ClientTokenError | null {
  if (payload.maximumSizeInBytes !== undefined && size > payload.maximumSizeInBytes) {
    return {
      code: "file_too_large",
      message: `File is too large, the file length cannot be greater than ${payload.maximumSizeInBytes} bytes.`,
      status: 400,
    };
  }

  return null;
}

/** Sends a client-token error in the shape the SDK's `getBlobError` reads. */
export function toErrorBody(error: ClientTokenError) {
  return { error: { code: error.code, message: error.message } };
}

function forbidden(): ClientTokenError {
  return {
    code: "forbidden",
    message: "Access denied, please provide a valid token for this resource.",
    status: 403,
  };
}

/** Supports exact types and `type/*` wildcards, as `allowedContentTypes` does. */
function isContentTypeAllowed({
  allowed,
  contentType,
}: {
  allowed: string;
  contentType: string;
}): boolean {
  const mimeType = contentType.split(";")[0]!.trim().toLowerCase();
  const allowedType = allowed.trim().toLowerCase();

  return allowedType.endsWith("/*")
    ? mimeType.startsWith(allowedType.slice(0, -1))
    : mimeType === allowedType;
}
