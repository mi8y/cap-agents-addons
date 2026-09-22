import type {
  BackendProtocolV2,
  EditResult,
  FileData,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "deepagents";
import { applyGrepMaxCount, normalizeReadPagination } from "deepagents";
import path from "node:path";
import { SapCloudSdkCmisClient, type CmisHttpClientConfig } from "./client";
import {
  type CmisObject,
  type CmisObjectInFolderContainer,
  CmisPropertyName,
} from "./types";
import {
  epochTimeToISO,
  getCmisProperty,
  getFileNameFromPath,
  getParentPath,
  globToRegExp,
  inferMimeType,
  isCmisFolder,
  isTextMimeType,
  mapCmisObjectToFileInfo,
  normalizeVirtualPath,
  resolveCmisPath,
  toUint8Array,
} from "./utils";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_TRAVERSAL_ITEMS = 10_000;

export type CmisBackendConfig = CmisHttpClientConfig & {
  /** CMIS folder exposed as `/` to Deep Agents. @default `/` */
  virtualRootPath?: string;
  /** @deprecated Use virtualRootPath. */
  rootPath?: string;
  /** Maximum number of descendants returned by glob/grep traversal. */
  maxTraversalItems?: number;
  /** Page size used by children requests. @default 100 */
  pageSize?: number;
};

type DocumentContent = {
  object: CmisObject;
  bytes: Uint8Array;
  mimeType: string;
};

type WalkResult = {
  files: FileInfo[];
  truncated: boolean;
};

/** CMIS-backed Deep Agents filesystem. */
export class CmisBackend implements BackendProtocolV2 {
  readonly client: SapCloudSdkCmisClient;
  readonly virtualRootPath: string;
  readonly #maxTraversalItems: number;
  readonly #pageSize: number;

  constructor(config: CmisBackendConfig) {
    const configuredRoot = config.virtualRootPath ?? config.rootPath ?? "/";
    this.virtualRootPath = normalizeVirtualPath(configuredRoot);
    this.#maxTraversalItems =
      config.maxTraversalItems ?? DEFAULT_MAX_TRAVERSAL_ITEMS;
    this.#pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;

    if (
      !Number.isInteger(this.#maxTraversalItems) ||
      this.#maxTraversalItems < 1
    ) {
      throw new Error("'maxTraversalItems' must be a positive integer");
    }
    if (!Number.isInteger(this.#pageSize) || this.#pageSize < 1) {
      throw new Error("'pageSize' must be a positive integer");
    }

    this.client = new SapCloudSdkCmisClient(config);
  }

  async ls(filePath: string): Promise<LsResult> {
    try {
      const virtualPath = normalizeVirtualPath(filePath);
      const repositoryPath = this.#resolve(virtualPath);
      const files: FileInfo[] = [];
      let skipCount = 0;
      let hasMoreItems = true;

      while (hasMoreItems) {
        const response = await this.client.getChildren(repositoryPath, {
          maxItems: this.#pageSize,
          skipCount,
        });
        for (const entry of response.data.objects) {
          const childPath = this.#joinVirtualPath(
            virtualPath,
            entry.pathSegment,
          );
          files.push(mapCmisObjectToFileInfo(entry.object, childPath));
        }
        skipCount += response.data.objects.length;
        hasMoreItems =
          response.data.hasMoreItems === true &&
          response.data.objects.length > 0;
      }

      return { files };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    try {
      const raw = await this.readRaw(filePath);
      if (raw.error || !raw.data) {
        return { error: raw.error ?? `File '${filePath}' not found` };
      }
      const data = raw.data;
      const content = Array.isArray(data.content)
        ? data.content.join("\n")
        : data.content;
      const mimeType = "mimeType" in data ? data.mimeType : "text/plain";

      if (content instanceof Uint8Array || !isTextMimeType(mimeType)) {
        return { content, mimeType };
      }

      const pagination = normalizeReadPagination(offset, limit);
      const lines = content.split("\n");
      const totalLines = lines.at(-1) === "" ? lines.length - 1 : lines.length;
      const selected = lines.slice(
        pagination.offset,
        pagination.offset + pagination.limit,
      );
      if (
        selected.length === 0 ||
        pagination.offset >= totalLines ||
        pagination.limit === 0
      ) {
        return { content: selected.join("\n"), mimeType };
      }
      const endOffset = Math.min(
        pagination.offset + selected.length,
        totalLines,
      );
      return {
        content: selected.join("\n"),
        mimeType,
        totalLines,
        startLine: pagination.offset + 1,
        endLine: endOffset,
        nextOffset: endOffset < totalLines ? endOffset : undefined,
      };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    try {
      const virtualPath = normalizeVirtualPath(filePath);
      const document = await this.#getDocument(this.#resolve(virtualPath));
      const createdAt = epochTimeToISO(
        getCmisProperty(document.object, CmisPropertyName.CREATION_DATE),
      );
      const modifiedAt = epochTimeToISO(
        getCmisProperty(
          document.object,
          CmisPropertyName.LAST_MODIFICATION_DATE,
        ),
      );
      const content = isTextMimeType(document.mimeType)
        ? new TextDecoder().decode(document.bytes)
        : document.bytes;
      const data: FileData = {
        content,
        mimeType: document.mimeType,
        created_at: createdAt,
        modified_at: modifiedAt,
      };
      return { data };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const virtualPath = normalizeVirtualPath(filePath);
      if (virtualPath === "/") {
        return { error: "cannot write a document at the root path" };
      }
      const repositoryPath = this.#resolve(virtualPath);
      await this.#ensureFolder(getParentPath(repositoryPath));
      const mimeType = inferMimeType(virtualPath);
      const blob = new Blob([content], { type: mimeType });

      try {
        const existing = (await this.client.getObject(repositoryPath)).data;
        if (isCmisFolder(existing)) {
          return { error: `Cannot overwrite directory '${filePath}'` };
        }
        await this.#replaceContent(repositoryPath, existing, blob);
      } catch (error) {
        if (!this.#isNotFound(error)) throw error;
        await this.client.createDocument(repositoryPath, blob);
      }

      return { path: virtualPath, filesUpdate: null };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<EditResult> {
    try {
      const virtualPath = normalizeVirtualPath(filePath);
      const repositoryPath = this.#resolve(virtualPath);
      const document = await this.#getDocument(repositoryPath);
      if (!isTextMimeType(document.mimeType)) {
        return { error: `Cannot edit binary file '${filePath}'` };
      }
      const text = new TextDecoder().decode(document.bytes);
      const replacement = this.#replaceString(
        text,
        oldString,
        newString,
        replaceAll,
        virtualPath,
      );
      if ("error" in replacement) return replacement;

      if (replacement.content !== text) {
        await this.#replaceContent(
          repositoryPath,
          document.object,
          new Blob([replacement.content], { type: document.mimeType }),
        );
      }
      return {
        path: virtualPath,
        filesUpdate: null,
        occurrences: replacement.occurrences,
      };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  async grep(
    pattern: string,
    filePath = "/",
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    try {
      const basePath = normalizeVirtualPath(filePath ?? "/");
      const walked = await this.#walk(basePath);
      const globRegex = glob ? globToRegExp(glob) : undefined;
      const matches: GrepMatch[] = [];

      for (const info of walked.files) {
        if (info.is_dir) continue;
        const relativePath = this.#relativePath(basePath, info.path);
        if (globRegex && !globRegex.test(relativePath)) continue;
        const result = await this.readRaw(info.path);
        if (result.error || !result.data) {
          return { error: result.error ?? `Failed to read '${info.path}'` };
        }
        const data = result.data;
        const mimeType = "mimeType" in data ? data.mimeType : "text/plain";
        if (!isTextMimeType(mimeType)) continue;
        const content = Array.isArray(data.content)
          ? data.content.join("\n")
          : data.content;
        if (typeof content !== "string") continue;
        content.split("\n").forEach((line, index) => {
          if (line.includes(pattern)) {
            matches.push({ path: info.path, line: index + 1, text: line });
          }
        });
      }

      const limited = applyGrepMaxCount({ result: { matches }, maxCount });
      return {
        ...limited,
        truncated: walked.truncated || limited.truncated || undefined,
      };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  async glob(pattern: string, filePath = "/"): Promise<GlobResult> {
    try {
      const basePath = normalizeVirtualPath(filePath);
      const regex = globToRegExp(pattern);
      const walked = await this.#walk(basePath);
      return {
        files: walked.files.filter((info) =>
          regex.test(this.#relativePath(basePath, info.path)),
        ),
        truncated: walked.truncated || undefined,
      };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  #resolve(virtualPath: string): string {
    return resolveCmisPath(this.virtualRootPath, virtualPath);
  }

  #joinVirtualPath(parent: string, segment: string): string {
    const normalizedParent = normalizeVirtualPath(parent);
    return normalizeVirtualPath(path.posix.join(normalizedParent, segment));
  }

  #relativePath(basePath: string, childPath: string): string {
    const normalizedChild = normalizeVirtualPath(childPath.replace(/\/$/, ""));
    const relative = path.posix.relative(basePath, normalizedChild);
    return relative || getFileNameFromPath(normalizedChild);
  }

  async #getDocument(repositoryPath: string): Promise<DocumentContent> {
    const object = (await this.client.getObject(repositoryPath)).data;
    if (isCmisFolder(object)) {
      throw new Error(`'${repositoryPath}' is a directory`);
    }
    const response = await this.client.getContentStream(repositoryPath);
    const bytes = await toUint8Array(response.data);
    const propertyMimeType = getCmisProperty<string>(
      object,
      CmisPropertyName.CONTENT_STREAM_MIME_TYPE,
    );
    const responseMimeType = this.#header(response.headers, "content-type");
    return {
      object,
      bytes,
      mimeType:
        propertyMimeType ?? responseMimeType ?? "application/octet-stream",
    };
  }

  async #replaceContent(
    repositoryPath: string,
    object: CmisObject,
    content: Blob,
  ): Promise<void> {
    const changeToken = getCmisProperty<string>(
      object,
      CmisPropertyName.CHANGE_TOKEN,
    );
    try {
      await this.client.setContentStream(repositoryPath, content, changeToken);
      return;
    } catch (error) {
      if (!this.#isUpdateConflict(error)) throw error;
    }

    const checkedOut = (await this.client.checkOut(repositoryPath)).data;
    const objectId = getCmisProperty<string>(
      checkedOut,
      CmisPropertyName.OBJECT_ID,
    );
    if (!objectId) throw new Error("CMIS checkout response has no object ID");
    try {
      await this.client.checkIn(
        objectId,
        getFileNameFromPath(repositoryPath),
        content,
      );
    } catch (error) {
      try {
        await this.client.cancelCheckOut(objectId);
      } catch {
        // Preserve the check-in error. A repository administrator may need to
        // clear the private working copy if cancellation also failed.
      }
      throw error;
    }
  }

  async #ensureFolder(repositoryPath: string): Promise<void> {
    const normalized = normalizeVirtualPath(repositoryPath);
    if (normalized === "/") return;
    let current = "/";
    for (const segment of normalized.split("/").filter(Boolean)) {
      current = path.posix.join(current, segment);
      try {
        const object = (await this.client.getObject(current)).data;
        if (!isCmisFolder(object)) {
          throw new Error(`'${current}' is not a folder`);
        }
      } catch (error) {
        if (!this.#isNotFound(error)) throw error;
        try {
          await this.client.createFolder(current);
        } catch (createError) {
          if (!this.#isConflict(createError)) throw createError;
          const object = (await this.client.getObject(current)).data;
          if (!isCmisFolder(object)) throw createError;
        }
      }
    }
  }

  async #walk(basePath: string): Promise<WalkResult> {
    const repositoryPath = this.#resolve(basePath);
    const baseObject = (await this.client.getObject(repositoryPath)).data;
    if (!isCmisFolder(baseObject)) {
      return {
        files: [mapCmisObjectToFileInfo(baseObject, basePath)],
        truncated: false,
      };
    }

    try {
      const descendants = (await this.client.getDescendants(repositoryPath))
        .data;
      return this.#flattenDescendants(descendants, basePath);
    } catch (error) {
      if (!this.#isNotSupported(error)) throw error;
      return this.#walkWithChildren(repositoryPath, basePath);
    }
  }

  #flattenDescendants(
    descendants: CmisObjectInFolderContainer[],
    basePath: string,
  ): WalkResult {
    const files: FileInfo[] = [];
    let truncated = false;
    const visit = (
      entries: CmisObjectInFolderContainer[],
      parentPath: string,
    ): void => {
      for (const entry of entries) {
        if (files.length >= this.#maxTraversalItems) {
          truncated = true;
          return;
        }
        const childPath = this.#joinVirtualPath(
          parentPath,
          entry.object.pathSegment,
        );
        files.push(mapCmisObjectToFileInfo(entry.object.object, childPath));
        if (entry.children) visit(entry.children, childPath);
        if (truncated) return;
      }
    };
    visit(descendants, basePath);
    return { files, truncated };
  }

  async #walkWithChildren(
    rootRepositoryPath: string,
    rootVirtualPath: string,
  ): Promise<WalkResult> {
    const files: FileInfo[] = [];
    const queue = [
      { repositoryPath: rootRepositoryPath, path: rootVirtualPath },
    ];
    let truncated = false;
    while (queue.length > 0) {
      const folder = queue.shift();
      if (!folder) break;
      let skipCount = 0;
      let hasMoreItems = true;
      while (hasMoreItems) {
        const response = await this.client.getChildren(folder.repositoryPath, {
          maxItems: this.#pageSize,
          skipCount,
        });
        for (const entry of response.data.objects) {
          if (files.length >= this.#maxTraversalItems) {
            truncated = true;
            return { files, truncated };
          }
          const childPath = this.#joinVirtualPath(
            folder.path,
            entry.pathSegment,
          );
          files.push(mapCmisObjectToFileInfo(entry.object, childPath));
          if (isCmisFolder(entry.object)) {
            queue.push({
              repositoryPath: path.posix.join(
                folder.repositoryPath,
                entry.pathSegment,
              ),
              path: childPath,
            });
          }
        }
        skipCount += response.data.objects.length;
        hasMoreItems =
          response.data.hasMoreItems === true &&
          response.data.objects.length > 0;
      }
    }
    return { files, truncated };
  }

  #replaceString(
    content: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    filePath: string,
  ): { content: string; occurrences: number } | { error: string } {
    if (oldString.length === 0) {
      if (content.length !== 0) {
        return {
          error: "oldString must not be empty unless the file is empty",
        };
      }
      return { content: newString, occurrences: newString ? 1 : 0 };
    }

    let occurrences = 0;
    let position = 0;
    while (position <= content.length) {
      const found = content.indexOf(oldString, position);
      if (found === -1) break;
      occurrences += 1;
      position = found + oldString.length;
    }
    if (occurrences === 0) {
      return { error: `String not found in file '${filePath}'` };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        error: `Multiple occurrences found in '${filePath}'. Use replaceAll=true to replace all.`,
      };
    }
    if (oldString === newString) {
      return { content, occurrences: replaceAll ? occurrences : 1 };
    }
    return {
      content: replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString),
      occurrences: replaceAll ? occurrences : 1,
    };
  }

  #header(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== "object") return undefined;
    const record = headers as Record<string, unknown>;
    const value = record[name] ?? record[name.toLowerCase()];
    return typeof value === "string" ? value : undefined;
  }

  #isNotFound(error: unknown): boolean {
    return (
      this.#status(error) === 404 || this.#exception(error) === "objectNotFound"
    );
  }

  #isConflict(error: unknown): boolean {
    return this.#status(error) === 409;
  }

  #isUpdateConflict(error: unknown): boolean {
    return (
      this.#status(error) === 409 || this.#exception(error) === "updateConflict"
    );
  }

  #isNotSupported(error: unknown): boolean {
    return (
      this.#status(error) === 405 || this.#exception(error) === "notSupported"
    );
  }

  #status(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as {
      status?: unknown;
      response?: { status?: unknown };
    };
    const status = candidate.response?.status ?? candidate.status;
    return typeof status === "number" ? status : undefined;
  }

  #exception(error: unknown): string | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as {
      exception?: unknown;
      response?: { data?: { exception?: unknown } };
    };
    const exception =
      candidate.response?.data?.exception ?? candidate.exception;
    return typeof exception === "string" ? exception : undefined;
  }

  #errorMessage(error: unknown): string {
    if (error && typeof error === "object") {
      const candidate = error as {
        message?: unknown;
        response?: { data?: { message?: unknown } };
      };
      const responseMessage = candidate.response?.data?.message;
      if (typeof responseMessage === "string") return responseMessage;
      if (typeof candidate.message === "string") return candidate.message;
    }
    return String(error);
  }
}
