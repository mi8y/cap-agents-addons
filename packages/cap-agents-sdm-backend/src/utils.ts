import cds from "@sap/cds";
import type { FileData, FileInfo } from "deepagents";
import path from "node:path";
import { type CmisObject, CmisPropertyName } from "./types";
import {
  HttpDestination,
  jwtBearerToken,
  Service,
} from "@sap-cloud-sdk/connectivity";

const LOG = cds.log("cap-agents-sdm-backend");

/** Normalize an absolute path and reject traversal or invalid separators. */
export function normalizeAbsolutePath(filePath: string): string {
  if (!filePath || !filePath.startsWith("/")) {
    LOG.debug("Rejected a non-absolute CMIS path");
    throw new Error(`file path must be absolute - '${filePath}'`);
  }
  if (filePath.includes("\\") || filePath.includes("\0")) {
    LOG.debug("Rejected a CMIS path with an invalid character");
    throw new Error("file path contains an invalid character");
  }
  const segments = filePath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    LOG.debug("Rejected CMIS path traversal");
    throw new Error("path traversal is not allowed");
  }
  return segments.length ? `/${segments.join("/")}` : "/";
}

/** Resolve an agent-visible path beneath the configured repository root. */
export function resolvePaths(
  virtualRootPath: string,
  filePath: string,
): { virtualPath: string; repositoryPath: string } {
  const rootRepositoryPath = normalizeAbsolutePath(virtualRootPath);
  const virtualPath = normalizeAbsolutePath(filePath);
  const repositoryPath =
    virtualPath === "/"
      ? rootRepositoryPath
      : rootRepositoryPath === "/"
        ? virtualPath
        : `${rootRepositoryPath}${virtualPath}`;
  return { virtualPath, repositoryPath };
}

/** Join a CMIS child name to a virtual folder without allowing traversal. */
export function joinPath(parentVirtualPath: string, segment: string): string {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    /[/\\\0]/.test(segment)
  ) {
    LOG.warn("CMIS returned an unsafe child path segment");
    throw new Error("CMIS returned an unsafe path segment");
  }
  const parent = normalizeAbsolutePath(parentVirtualPath);
  return parent === "/" ? `/${segment}` : `${parent}/${segment}`;
}

/** Return a path relative to a search base, or the basename when it is the base. */
export function relativeVirtualPath(
  baseVirtualPath: string,
  childVirtualPath: string,
): string {
  const base = normalizeAbsolutePath(baseVirtualPath);
  const child = normalizeAbsolutePath(childVirtualPath);
  return path.posix.relative(base, child) || path.posix.basename(child);
}

/** Read a succinct CMIS property from an object, if present. */
export function getCmisProperty<T = unknown>(
  object: CmisObject,
  property: CmisPropertyName,
): T | undefined {
  return object.succinctProperties[property] as T | undefined;
}

/** Check whether a CMIS object is a folder. */
export function isCmisFolder(object: CmisObject): boolean {
  return (
    getCmisProperty(object, CmisPropertyName.BASE_TYPE_ID) === "cmis:folder"
  );
}

/** Check whether a CMIS object is a document. */
export function isCmisDocument(object: CmisObject): boolean {
  return (
    getCmisProperty(object, CmisPropertyName.BASE_TYPE_ID) === "cmis:document"
  );
}

/** Read a document's content length, treating missing or invalid sizes as zero. */
export function getContentStreamLength(object: CmisObject): number {
  const rawSize = getCmisProperty(
    object,
    CmisPropertyName.CONTENT_STREAM_LENGTH,
  );
  const size = rawSize === undefined || rawSize === null ? 0 : Number(rawSize);
  return Number.isFinite(size) ? size : 0;
}

/** Read the MIME type stored in a CMIS object's succinct properties. */
export function getContentStreamMimeType(
  object: CmisObject,
): string | undefined {
  return getCmisProperty<string>(
    object,
    CmisPropertyName.CONTENT_STREAM_MIME_TYPE,
  );
}

/** Convert a CMIS content response to bytes for file decoding. */
export async function toUint8Array(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (typeof value === "string") return new TextEncoder().encode(value);
  LOG.warn("CMIS content stream returned an unsupported data type");
  throw new Error("CMIS content stream returned an unsupported data type");
}

/** Format a CMIS millisecond timestamp as an ISO date. */
export function epochTimeToISO(value: number): string {
  return new Date(value).toISOString();
}

/** Map CMIS object metadata to an agent-visible file or folder entry. */
export function mapCmisObjectToFileInfo(
  object: CmisObject,
  virtualPath: string,
): FileInfo {
  const isDir = isCmisFolder(object);
  const size = getContentStreamLength(object);
  const modifiedAt =
    getCmisProperty<number>(object, CmisPropertyName.LAST_MODIFICATION_DATE) ??
    0;

  const normalizedVirtualPath = normalizeAbsolutePath(virtualPath);
  return {
    path:
      isDir && normalizedVirtualPath !== "/"
        ? `${normalizedVirtualPath}/`
        : normalizedVirtualPath,
    is_dir: isDir,
    size,
    modified_at: new Date(modifiedAt).toISOString(),
  };
}

/** Map document bytes and metadata to text or binary file data. */
export function mapCmisObjectToFileData(
  object: CmisObject,
  content: Uint8Array,
  headers: unknown,
): FileData {
  const createdAt = epochTimeToISO(
    getCmisProperty<number>(object, CmisPropertyName.CREATION_DATE) ?? 0,
  );
  const modifiedAt = epochTimeToISO(
    getCmisProperty<number>(object, CmisPropertyName.LAST_MODIFICATION_DATE) ??
      0,
  );

  const mimeType = getCmisProperty<string>(
    object,
    CmisPropertyName.CONTENT_STREAM_MIME_TYPE,
  );
  const headerMimeType = getHeader(headers, "content-type");

  const resolvedMimeType =
    mimeType ?? headerMimeType ?? "application/octet-stream";
  return {
    content: isTextMimeType(resolvedMimeType)
      ? new TextDecoder().decode(content)
      : content,
    mimeType: resolvedMimeType,
    created_at: createdAt,
    modified_at: modifiedAt,
  };
}

/** Read a named response header without assuming a headers implementation. */
export function getHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

/** Guess the MIME type of a new document from its filename extension. */
export function inferMimeType(filePath: string): string {
  const extension = path.posix.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    ".css": "text/css",
    ".csv": "text/csv",
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
    ".jsx": "text/jsx",
    ".md": "text/markdown",
    ".mjs": "text/javascript",
    ".toml": "application/toml",
    ".ts": "text/typescript",
    ".tsx": "text/tsx",
    ".txt": "text/plain",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  };
  return known[extension] ?? "text/plain";
}

/** Decide whether a MIME type should be decoded and searched as text. */
export function isTextMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(";", 1)[0].trim().toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/javascript" ||
    normalized === "application/toml" ||
    normalized === "application/xml" ||
    normalized === "application/yaml" ||
    normalized.endsWith("+json") ||
    normalized.endsWith("+xml")
  );
}

/**
 * Transform an SDM service binding into an HTTP destination using a JWT bearer assertion.
 * @param service The service binding object for the SDM service.
 * @param userJwt The bearer JWT from the current CAP request.
 * @returns A promise that resolves to an HTTP destination configured with a JWT bearer assertion.
 */
export async function transformServiceBindingToJwtBearerAssertionDestination(
  service: Service,
  userJwt: string,
): Promise<HttpDestination> {
  const token = await jwtBearerToken(userJwt, {
    ...service,
    credentials: service.credentials.uaa,
  });
  return {
    url: service.credentials.uri,
    authentication: "OAuth2JWTBearer",
    authTokens: [
      {
        type: "bearer",
        value: token,
        http_header: { key: "Authorization", value: `Bearer ${token}` },
        error: null,
      },
    ],
  };
}
