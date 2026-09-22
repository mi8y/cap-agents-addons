import type { FileInfo } from "deepagents";
import path from "node:path";
import { CmisObject, CmisPropertyName } from "./types";

/** Normalize an absolute path in the virtual filesystem exposed to an agent. */
export function normalizeVirtualPath(filePath: string): string {
  if (!filePath || !filePath.startsWith("/")) {
    throw new Error(`file path must be absolute - '${filePath}'`);
  }

  if (filePath.includes("\\")) {
    throw new Error(`file path contains an invalid character - '\\'`);
  }

  if (filePath.includes("\0")) {
    throw new Error(`file path contains an invalid character - '\\0'`);
  }

  const segments = filePath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("path traversal is not allowed");
  }

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function resolveCmisPath(
  virtualRootPath: string,
  virtualPath: string,
): string {
  const root = normalizeVirtualPath(virtualRootPath);
  const requested = normalizeVirtualPath(virtualPath);
  if (root === "/") return requested;
  if (requested === "/") return root;
  return `${root}${requested}`;
}

export function getFileNameFromPath(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);
  return segments.length === 0 ? "" : segments[segments.length - 1];
}

export function getParentPath(filePath: string): string {
  const normalized = normalizeVirtualPath(filePath);
  return normalized === "/" ? "/" : path.posix.dirname(normalized);
}

export function getCmisProperty<T = unknown>(
  object: CmisObject,
  property: CmisPropertyName,
): T | undefined {
  return object.succinctProperties[property] as T | undefined;
}

export function isCmisFolder(object: CmisObject): boolean {
  return (
    getCmisProperty(object, CmisPropertyName.BASE_TYPE_ID) === "cmis:folder"
  );
}

export function epochTimeToISO(value: number): string {
  return new Date(value).toISOString();
}

export function mapCmisObjectToFileInfo(
  object: CmisObject,
  filePath: string,
): FileInfo {
  const isDir = isCmisFolder(object);
  const rawSize = getCmisProperty(
    object,
    CmisPropertyName.CONTENT_STREAM_LENGTH,
  );
  const size = rawSize === undefined || rawSize === null ? 0 : Number(rawSize);
  const modifiedAt = epochTimeToISO(
    getCmisProperty<number>(object, CmisPropertyName.LAST_MODIFICATION_DATE),
  );
  const normalized = normalizeVirtualPath(filePath);

  return {
    path: isDir && normalized !== "/" ? `${normalized}/` : normalized,
    is_dir: isDir,
    size: Number.isFinite(size) ? size : 0,
    modified_at: modifiedAt,
  };
}

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

export async function toUint8Array(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error("CMIS content stream returned an unsupported data type");
}

/** Compile a portable subset of glob syntax used by BackendProtocolV2. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        let characterClass = pattern.slice(index + 1, end);
        if (characterClass.startsWith("!")) {
          characterClass = `^${characterClass.slice(1)}`;
        }
        source += `[${characterClass}]`;
        index = end;
      }
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}
