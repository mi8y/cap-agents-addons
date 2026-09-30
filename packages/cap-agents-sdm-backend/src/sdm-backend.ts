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
import picomatch from "picomatch";
import { SapCloudSdkCmisClient, type CmisHttpClientConfig } from "./client";
import {
  CmisPropertyName,
  type CmisObject,
  type CmisObjectInFolderContainer,
} from "./types";
import * as utils from "./utils";
import cds from "@sap/cds";

const LOG = cds.log("cap-agents-sdm-backend");

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_TRAVERSAL_ITEMS = 10_000;
const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

export type SdmBackendConfig = CmisHttpClientConfig & {
  /**
   * CMIS folder exposed as `/` to Deep Agents.
   *
   * @default `/`
   */
  virtualRootPath?: string;

  /**
   * Maximum file size that can be read.
   *
   * @default 5242880 // 5 MB
   */
  maxFileSize?: number;

  /**
   * Maximum number of descendants returned by glob/grep traversal.
   *
   * @default 10000
   */
  maxTraversalItems?: number;

  /**
   * Page size used by children requests.
   *
   * @default 100
   */
  pageSize?: number;
};

type WalkResult = {
  files: FileInfo[];
  truncated: boolean;
};

/** SDM-backed Deep Agents filesystem using CMIS Browser Binding. */
export class SdmBackend implements BackendProtocolV2 {
  readonly client: SapCloudSdkCmisClient;
  readonly virtualRootPath: string;
  readonly #maxTraversalItems: number;
  readonly #pageSize: number;
  readonly #maxFileSize: number;

  /** Configure the virtual root, traversal limits, and CMIS transport. */
  constructor(config: SdmBackendConfig) {
    const configuredRoot = config.virtualRootPath ?? "/";
    this.virtualRootPath = utils.normalizeAbsolutePath(configuredRoot);
    this.#maxTraversalItems =
      config.maxTraversalItems ?? DEFAULT_MAX_TRAVERSAL_ITEMS;
    this.#pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.#maxFileSize = config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

    if (
      !Number.isInteger(this.#maxTraversalItems) ||
      this.#maxTraversalItems < 1
    ) {
      throw new Error("'maxTraversalItems' must be a positive integer");
    }
    if (!Number.isInteger(this.#pageSize) || this.#pageSize < 1) {
      throw new Error("'pageSize' must be a positive integer");
    }
    if (!Number.isInteger(this.#maxFileSize) || this.#maxFileSize < 1) {
      throw new Error("'maxFileSize' must be a positive integer");
    }

    this.client = new SapCloudSdkCmisClient(config);
    LOG.debug("Initialized SDM filesystem backend");
  }

  /** Translate one agent-visible path into a repository path. */
  #resolvePaths(filePath: string) {
    return utils.resolvePaths(this.virtualRootPath, filePath);
  }

  /** List all direct children of a virtual folder, across CMIS pages. */
  async ls(filePath: string): Promise<LsResult> {
    try {
      const { virtualPath, repositoryPath } = this.#resolvePaths(filePath);
      const files: FileInfo[] = [];
      let skipCount = 0;
      let hasMoreObjects = true;
      while (hasMoreObjects) {
        const {
          data: { objects, hasMoreItems },
        } = await this.client.getChildren(repositoryPath, {
          maxItems: this.#pageSize,
          skipCount,
        });
        for (const entry of objects) {
          const childVirtualPath = utils.joinPath(
            virtualPath,
            entry.pathSegment,
          );
          files.push(
            utils.mapCmisObjectToFileInfo(entry.object, childVirtualPath),
          );
        }
        skipCount += objects.length;
        hasMoreObjects = hasMoreItems === true && objects.length > 0;
      }
      LOG.debug(`Listed ${files.length} CMIS folder entries`);
      return { files };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  /** Read a virtual file, optionally selecting a range of text lines. */
  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    try {
      const raw = await this.readRaw(filePath);
      if (raw.error || !raw.data) {
        return { error: raw.error ?? `File '${filePath}' not found` };
      }

      const content = Array.isArray(raw.data.content)
        ? raw.data.content.join("\n")
        : raw.data.content;
      const mimeType =
        "mimeType" in raw.data ? raw.data.mimeType : "text/plain";

      // if the content is binary or the MIME type is not text, return it as is
      if (content instanceof Uint8Array || !utils.isTextMimeType(mimeType)) {
        return { content, mimeType };
      }

      // try to read the requested portion of the text content
      const { offset: start, limit: count } = normalizeReadPagination(
        offset,
        limit,
      );
      const lines = content.split("\n");
      const totalLines = lines.at(-1) === "" ? lines.length - 1 : lines.length;
      const selected = lines.slice(start, start + count);
      if (!selected.length || start >= totalLines || count === 0) {
        return { content: selected.join("\n"), mimeType };
      }
      const endOffset = Math.min(start + selected.length, totalLines);

      return {
        content: selected.join("\n"),
        mimeType,
        totalLines,
        startLine: start + 1,
        endLine: endOffset,
        nextOffset: endOffset < totalLines ? endOffset : undefined,
      };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  /** Read the complete file, preserving binary content and MIME metadata. */
  async readRaw(filePath: string): Promise<ReadRawResult> {
    try {
      return { data: await this.#readFile(this.#resolvePaths(filePath)) };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  /** Create or replace a document below the configured virtual root. */
  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const { virtualPath, repositoryPath } = this.#resolvePaths(filePath);
      if (virtualPath === "/")
        return { error: "cannot write a document at the root path" };

      // create a new blob with content-type
      const mimeType = utils.inferMimeType(virtualPath);
      const blob = new Blob([content], { type: mimeType });

      // if the parent folders do not exist, create them
      await this.#ensureParentFolders(virtualPath);

      // if the object already exists, overwrite it; otherwise, create a new document
      try {
        const existing = (await this.client.getObject(repositoryPath)).data;

        // if the existing object is a folder, we cannot overwrite it
        if (utils.isCmisFolder(existing)) {
          return { error: `Cannot overwrite directory '${virtualPath}'` };
        }

        await this.#replaceContent(repositoryPath, existing, blob);
        LOG.debug("Updated an existing CMIS document");
      } catch (error) {
        if (!this.#isNotFound(error)) throw error;

        // if the object does not exist, create a new document
        await this.client.createDocument(repositoryPath, blob);
        LOG.debug("Created a CMIS document");
      }

      return { path: virtualPath, filesUpdate: null };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  /** Replace literal text in a virtual file, rejecting ambiguous edits. */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<EditResult> {
    try {
      const { virtualPath, repositoryPath } = this.#resolvePaths(filePath);
      if (virtualPath === "/")
        return { error: "cannot edit a document at the root path" };

      const data = await this.#readFile({ virtualPath, repositoryPath });
      const content = Array.isArray(data.content)
        ? data.content.join("\n")
        : data.content;
      const mimeType = "mimeType" in data ? data.mimeType : "text/plain";

      // if it is not a text file, we cannot edit it
      if (typeof content !== "string" || !utils.isTextMimeType(mimeType)) {
        return { error: `Cannot edit binary file '${filePath}'` };
      }

      const replacement = this.#replaceString(
        content,
        oldString,
        newString,
        replaceAll,
        virtualPath,
      );
      if ("error" in replacement) return replacement;

      // if the content has changed, update the document
      if (replacement.content !== content) {
        const object = (await this.client.getObject(repositoryPath)).data;
        await this.#replaceContent(
          repositoryPath,
          object,
          new Blob([replacement.content], { type: mimeType }),
        );
      }

      LOG.debug(`Edited ${replacement.occurrences} CMIS text occurrence(s)`);
      return {
        path: virtualPath,
        filesUpdate: null,
        occurrences: replacement.occurrences,
      };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  /** Search text files for a literal string, with an optional relative glob filter. */
  async grep(
    pattern: string,
    filePath = "/",
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    try {
      const { virtualPath: baseVirtualPath, repositoryPath } =
        this.#resolvePaths(filePath);
      const globMatcher = glob ? picomatch(glob, { dot: true }) : undefined;
      const matches: GrepMatch[] = [];
      const walked = await this.#walk(baseVirtualPath, repositoryPath);

      for (const info of walked.files) {
        if (info.is_dir) continue;

        const relativePath = utils.relativeVirtualPath(
          baseVirtualPath,
          info.path,
        );
        if (globMatcher && !globMatcher(relativePath)) continue;

        const result = await this.readRaw(info.path);
        if (result.error || !result.data) {
          return { error: result.error ?? `Failed to read '${info.path}'` };
        }
        const mimeType =
          "mimeType" in result.data ? result.data.mimeType : "text/plain";

        // if not a text file, skip it
        if (!utils.isTextMimeType(mimeType)) continue;

        const content = Array.isArray(result.data.content)
          ? result.data.content.join("\n")
          : result.data.content;

        // if the content is not a string, skip it
        if (typeof content !== "string") continue;

        // split the content into lines and search for the pattern
        content.split("\n").forEach((line, index) => {
          if (line.includes(pattern)) {
            matches.push({ path: info.path, line: index + 1, text: line });
          }
        });
      }

      const limited = applyGrepMaxCount({ result: { matches }, maxCount });
      LOG.debug(
        `Searched CMIS files: ${limited.matches?.length ?? 0} match(es)`,
      );
      return {
        ...limited,
        truncated: walked.truncated || limited.truncated || undefined,
      };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  /** Find entries whose paths match a glob relative to the search base. */
  async glob(pattern: string, filePath = "/"): Promise<GlobResult> {
    try {
      const { virtualPath: baseVirtualPath, repositoryPath } =
        this.#resolvePaths(filePath);
      const matcher = picomatch(pattern, { dot: true });
      const walked = await this.#walk(baseVirtualPath, repositoryPath);
      const filtered = walked.files.filter((info) =>
        matcher(utils.relativeVirtualPath(baseVirtualPath, info.path)),
      );
      LOG.debug(`Matched ${filtered.length} CMIS entries by glob`);
      return {
        files: filtered,
        truncated: walked.truncated || undefined,
      };
    } catch (error) {
      return { error: this.#errorMessage(error) };
    }
  }

  /** Fetch a document's bytes and metadata, enforcing the read-size limit. */
  async #readFile({
    virtualPath,
    repositoryPath,
  }: ReturnType<typeof utils.resolvePaths>): Promise<FileData> {
    const { data: object } = await this.client.getObject(repositoryPath);
    if (utils.isCmisFolder(object)) {
      throw new Error(`'${virtualPath}' is a directory`);
    }

    if (utils.getContentStreamLength(object) > this.#maxFileSize) {
      throw new Error(
        `file cannot be read. file at '${virtualPath}' exceeds the maximum allowed size of ${this.#maxFileSize} bytes`,
      );
    }

    const { data: content, headers } =
      await this.client.getContentStream(repositoryPath);
    const bytes = await utils.toUint8Array(content);
    if (bytes.byteLength > this.#maxFileSize) {
      throw new Error(
        `file cannot be read. file at '${virtualPath}' exceeds the maximum allowed size of ${this.#maxFileSize} bytes`,
      );
    }
    LOG.debug(`Read CMIS document (${bytes.byteLength} bytes)`);
    return utils.mapCmisObjectToFileData(object, bytes, headers);
  }

  /** Update content directly, falling back to a CMIS working copy on conflict. */
  async #replaceContent(
    repositoryPath: string,
    object: CmisObject,
    content: Blob,
  ): Promise<void> {
    const changeToken = utils.getCmisProperty<string>(
      object,
      CmisPropertyName.CHANGE_TOKEN,
    );
    try {
      await this.client.setContentStream(repositoryPath, content, changeToken);
      LOG.debug("Updated CMIS content stream directly");
      return;
    } catch (error) {
      if (!this.#isUpdateConflict(error)) throw error;
      LOG.debug("CMIS content update conflicted; using a working copy");
      // else it might be a versioned repository rejecting the content update without checkout
    }

    // Refresh checkout status after the conflict; only cancel a checkout we created.
    const current = (await this.client.getObject(repositoryPath)).data;
    LOG.debug("Refreshed CMIS checkout status after content conflict");
    const isWorkingCopy =
      utils.getCmisProperty<boolean>(
        current,
        CmisPropertyName.IS_PRIVATE_WORKING_COPY,
      ) === true;
    const isCheckedOut =
      utils.getCmisProperty<boolean>(
        current,
        CmisPropertyName.IS_VERSION_SERIES_CHECKED_OUT,
      ) === true;

    // Determine the object ID of the working copy or create a new checkout if necessary.
    let createdCheckout = false;
    let objectId: string | undefined;
    if (isWorkingCopy) {
      LOG.debug("Reusing the current CMIS private working copy");
      objectId = utils.getCmisProperty<string>(
        current,
        CmisPropertyName.OBJECT_ID,
      );
    } else if (isCheckedOut) {
      LOG.debug("Reusing an existing CMIS checkout");
      objectId = utils.getCmisProperty<string>(
        current,
        CmisPropertyName.VERSION_SERIES_CHECKED_OUT_ID,
      );
    } else {
      const checkedOut = (await this.client.checkOut(repositoryPath)).data;
      createdCheckout = true;
      LOG.debug("Created a CMIS checkout for content update");
      objectId = utils.getCmisProperty<string>(
        checkedOut,
        CmisPropertyName.OBJECT_ID,
      );
    }

    if (!objectId) {
      throw new Error(
        createdCheckout
          ? "CMIS checkout response has no object ID"
          : "CMIS checked-out document has no visible working copy ID",
      );
    }

    try {
      // Attempt to check in the working copy with the provided content.
      await this.client.checkIn(
        objectId,
        path.posix.basename(repositoryPath),
        content,
      );
      LOG.debug("Checked in CMIS document content");
    } catch (error) {
      if (createdCheckout) {
        try {
          await this.client.cancelCheckOut(objectId);
          LOG.debug("Cancelled checkout after failed CMIS check-in");
        } catch {
          LOG.warn("Failed to cancel checkout after CMIS check-in failure");
          // Preserve the check-in error. A repository administrator may need to
          // clear the private working copy if cancellation also failed.
        }
      }
      throw error;
    }
  }

  /** Confirm the configured root exists, then create missing parent folders below it. */
  async #ensureParentFolders(virtualPath: string): Promise<void> {
    // never create the configured root or any of its ancestors.
    if (this.virtualRootPath !== "/") {
      try {
        const root = (await this.client.getObject(this.virtualRootPath)).data;
        if (!utils.isCmisFolder(root)) {
          throw new Error("virtual root is not a folder");
        }
      } catch (error) {
        if (this.#isNotFound(error)) {
          throw new Error("virtual root folder does not exist", {
            cause: error,
          });
        }
        throw error;
      }
    }

    // start to ensure each parent folder exists, from the top level
    const parentFolderPath = path.posix.dirname(virtualPath);
    const pathSegments = parentFolderPath.split("/").filter(Boolean);
    let parentVirtualPath = "";
    for (const segment of pathSegments) {
      parentVirtualPath += `/${segment}`;
      const { repositoryPath } = this.#resolvePaths(parentVirtualPath);

      try {
        const object = (await this.client.getObject(repositoryPath)).data;
        if (!utils.isCmisFolder(object)) {
          throw new Error(`'${parentVirtualPath}' is not a folder`);
        }
      } catch (error) {
        if (!this.#isNotFound(error)) throw error;

        // folder does not exist, create it
        await this.client.createFolder(repositoryPath);
        LOG.debug("Created a missing CMIS parent folder");
      }
    }
  }

  /** Collect a document or folder descendants for glob and grep. */
  async #walk(
    virtualPath: string,
    repositoryPath: string,
  ): Promise<WalkResult> {
    // if object is a document, return it as a single file
    const baseObject = (await this.client.getObject(repositoryPath)).data;
    if (utils.isCmisDocument(baseObject)) {
      return {
        files: [utils.mapCmisObjectToFileInfo(baseObject, virtualPath)],
        truncated: false,
      };
    }

    // else the object is a folder, attempt to get its descendants
    try {
      const descendants = (await this.client.getDescendants(repositoryPath))
        .data;
      return this.#flattenDescendants(descendants, virtualPath);
    } catch (error) {
      if (!this.#isNotSupported(error)) throw error;

      LOG.debug("CMIS descendants unsupported; traversing paginated children");
      // if getting descendants is not supported, fall back to walking with children (recursive)
      return this.#walkWithChildren(repositoryPath, virtualPath);
    }
  }

  /** Traverse a folder breadth-first when the descendants selector is unavailable. */
  async #walkWithChildren(
    rootRepositoryPath: string,
    rootVirtualPath: string,
  ): Promise<WalkResult> {
    const files: FileInfo[] = [];
    let truncated = false;

    // do a breadth-first traversal of the folder hierarchy
    const queue = [
      { repositoryPath: rootRepositoryPath, virtualPath: rootVirtualPath },
    ];
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
          // check if the maximum traversal items limit has been reached
          if (files.length >= this.#maxTraversalItems) {
            truncated = true;
            return { files, truncated };
          }

          const childVirtualPath = utils.joinPath(
            folder.virtualPath,
            entry.pathSegment,
          );
          files.push(
            utils.mapCmisObjectToFileInfo(entry.object, childVirtualPath),
          );
          if (utils.isCmisFolder(entry.object)) {
            queue.push({
              repositoryPath:
                this.#resolvePaths(childVirtualPath).repositoryPath,
              virtualPath: childVirtualPath,
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

  /** Flatten nested CMIS descendants into virtual entries within the item limit. */
  #flattenDescendants(
    descendants: CmisObjectInFolderContainer[],
    baseVirtualPath: string,
  ): WalkResult {
    const files: FileInfo[] = [];
    let truncated = false;

    // recursively flatten the descendants into a list of files
    const visit = (
      entries: CmisObjectInFolderContainer[],
      parentVirtualPath: string,
    ): void => {
      for (const entry of entries) {
        if (files.length >= this.#maxTraversalItems) {
          truncated = true;
          return;
        }
        const childVirtualPath = utils.joinPath(
          parentVirtualPath,
          entry.object.pathSegment,
        );
        files.push(
          utils.mapCmisObjectToFileInfo(entry.object.object, childVirtualPath),
        );

        // recursively visit the children if they exist
        if (entry.children) visit(entry.children, childVirtualPath);

        // stop processing if the traversal has been truncated
        if (truncated) return;
      }
    };

    // start from the base virtual path
    visit(descendants, baseVirtualPath);

    return { files, truncated };
  }

  /** Count and replace literal occurrences according to the edit options. */
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

    // count the occurrences of oldString in the content
    let occurrences = 0;
    let position = 0;
    while (position <= content.length) {
      const found = content.indexOf(oldString, position);
      if (found === -1) break;

      occurrences += 1;
      position = found + oldString.length;
    }

    // if no occurrences are found, return an error
    if (occurrences === 0) {
      return { error: `String not found in file '${filePath}'` };
    }

    // if there are multiple occurrences and replaceAll is not set, return an error
    if (occurrences > 1 && !replaceAll) {
      return {
        error: `Multiple occurrences found in '${filePath}'. Use replaceAll=true to replace all.`,
      };
    }

    // if oldString and newString are the same, return the content as is
    if (oldString === newString) {
      return { content, occurrences: replaceAll ? occurrences : 1 };
    }

    // perform the replacement based on the replaceAll flag
    return {
      content: replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString),
      occurrences: replaceAll ? occurrences : 1,
    };
  }

  /** Identify a CMIS missing-object response. */
  #isNotFound(error: unknown): boolean {
    return (
      this.#status(error) === 404 || this.#exception(error) === "objectNotFound"
    );
  }

  /** Identify a CMIS content-update conflict. */
  #isUpdateConflict(error: unknown): boolean {
    return (
      this.#status(error) === 409 || this.#exception(error) === "updateConflict"
    );
  }

  /** Identify a CMIS selector unsupported by the repository. */
  #isNotSupported(error: unknown): boolean {
    return (
      this.#status(error) === 405 || this.#exception(error) === "notSupported"
    );
  }

  /** Read an HTTP status from a Cloud SDK or CMIS error, if available. */
  #status(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as {
      status?: unknown;
      response?: { status?: unknown };
    };
    const status = candidate.response?.status ?? candidate.status;
    return typeof status === "number" ? status : undefined;
  }

  /** Read the CMIS exception identifier carried by an error. */
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

  /** Convert a failed operation into a filesystem-friendly error message. */
  #errorMessage(error: unknown): string {
    const status = this.#status(error);
    LOG.debug(
      status === undefined
        ? "SDM backend operation failed"
        : `SDM backend operation failed (HTTP ${status})`,
    );
    if (status === 401) return "SDM authentication required (HTTP 401)";
    if (status === 403) return "SDM access denied (HTTP 403)";
    if (status === 404) return "CMIS object not found (HTTP 404)";
    if (status === 409) return "CMIS conflict (HTTP 409)";
    if (status !== undefined) return `SDM request failed (HTTP ${status})`;
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
