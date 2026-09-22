import type { HttpDestinationOrFetchOptions } from "@sap-cloud-sdk/connectivity";
import {
  executeHttpRequest,
  type HttpRequestConfig,
  type HttpRequestOptions,
  type HttpResponse,
} from "@sap-cloud-sdk/http-client";
import path from "node:path";
import {
  type CmisObject,
  type CmisObjectInFolderContainer,
  type CmisObjectInFolderList,
  CmisPagingOptions,
  CmisPropertyName,
  type CmisQueryResultList,
} from "./types";

export type CmisHttpRequestExecutor = (
  destination: HttpDestinationOrFetchOptions,
  requestConfig: HttpRequestConfig,
  options?: HttpRequestOptions,
) => Promise<HttpResponse>;

export type CmisHttpClientConfig = {
  /** A resolved HTTP destination or SAP Cloud SDK destination lookup options. */
  destination: HttpDestinationOrFetchOptions;
  /** CMIS repository ID. */
  repositoryId: string;
  /** Browser Binding path relative to the destination URL.
   *
   * @default `/browser`
   */
  browserBindingPath?: string;
  /** Injectable executor for tests and custom instrumentation. */
  requestExecutor?: CmisHttpRequestExecutor;
};

export type CmisResponse<T = unknown> = Omit<HttpResponse, "data"> & {
  data: T;
};

/** Thin CMIS Browser Binding transport built on the SAP Cloud SDK client. */
export class SapCloudSdkCmisClient {
  readonly #destination: HttpDestinationOrFetchOptions;
  readonly #repositoryId: string;
  readonly #browserBindingPath: string;
  readonly #requestExecutor: CmisHttpRequestExecutor;

  constructor(config: CmisHttpClientConfig) {
    if (!config.repositoryId?.trim()) {
      throw new Error(`'repositoryId' is required`);
    }

    if (!path.posix.isAbsolute(config.browserBindingPath ?? "/browser")) {
      throw new Error(`'browserBindingPath' must be an absolute path`);
    }

    this.#destination = config.destination;
    const bindingPath = config.browserBindingPath ?? "/browser";
    this.#browserBindingPath = bindingPath;
    this.#repositoryId = config.repositoryId;
    this.#requestExecutor = config.requestExecutor ?? executeHttpRequest;
  }

  #getServiceUrl() {
    return this.#browserBindingPath;
  }

  #getRepositoryUrl() {
    return path.posix.join(
      this.#getServiceUrl(),
      encodeURIComponent(this.#repositoryId),
    );
  }

  #getObjectUrl(filePath: string): string {
    const normalized = path.posix.normalize(filePath);
    const encoded = normalized
      .split(path.posix.sep)
      .filter(Boolean)
      .map(encodeURIComponent);
    return path.posix.join(this.#getRepositoryUrl(), "root", ...encoded);
  }

  async #execute<T = unknown>(
    config: HttpRequestConfig,
  ): Promise<CmisResponse<T>> {
    return (await this.#requestExecutor(
      this.#destination,
      config,
    )) as CmisResponse<T>;
  }

  async getChildren(
    filePath: string,
    options: CmisPagingOptions = {},
  ): Promise<CmisResponse<CmisObjectInFolderList>> {
    return this.#execute<CmisObjectInFolderList>({
      method: "GET",
      url: this.#getObjectUrl(filePath),
      params: {
        cmisselector: "children",
        includePathSegment: true,
        succinct: true,
        maxItems: options.maxItems,
        skipCount: options.skipCount,
      },
    });
  }

  async getDescendants(
    filePath: string,
    depth = -1,
  ): Promise<CmisResponse<CmisObjectInFolderContainer[]>> {
    return this.#execute<CmisObjectInFolderContainer[]>({
      method: "GET",
      url: this.#getObjectUrl(filePath),
      params: {
        cmisselector: "descendants",
        includePathSegment: true,
        succinct: true,
        depth,
      },
    });
  }

  async getFolderTree(
    filePath: string,
    depth = -1,
  ): Promise<CmisResponse<CmisObjectInFolderContainer[]>> {
    return this.#execute<CmisObjectInFolderContainer[]>({
      method: "GET",
      url: this.#getObjectUrl(filePath),
      params: {
        cmisselector: "folderTree",
        includePathSegment: true,
        succinct: true,
        depth,
      },
    });
  }

  async getObject(filePath: string): Promise<CmisResponse<CmisObject>> {
    return this.#execute<CmisObject>({
      method: "GET",
      url: this.#getObjectUrl(filePath),
      params: { cmisselector: "object", succinct: true },
    });
  }

  async createDocument(
    filePath: string,
    content: Blob,
  ): Promise<CmisResponse<CmisObject>> {
    const normalized = path.posix.normalize(filePath);

    const fileName = path.posix.basename(normalized);
    if (!fileName)
      throw new Error(`cannot create a document at path -'${filePath}'`);

    const formData = new FormData();
    formData.append("cmisaction", "createDocument");
    formData.append("succinct", "true");
    formData.append("propertyId[0]", CmisPropertyName.NAME);
    formData.append("propertyValue[0]", fileName);
    formData.append("propertyId[1]", CmisPropertyName.OBJECT_TYPE_ID);
    formData.append("propertyValue[1]", "cmis:document");
    formData.append("content", content, fileName);

    return this.#execute<CmisObject>({
      method: "POST",
      url: this.#getObjectUrl(path.posix.dirname(normalized)),
      data: formData,
    });
  }

  async createFolder(filePath: string): Promise<CmisResponse<CmisObject>> {
    const normalized = path.posix.normalize(filePath);

    const folderName = path.posix.basename(normalized);
    if (!folderName)
      throw new Error(`cannot create the folder at path - '${filePath}'`);

    const formData = new FormData();
    formData.append("cmisaction", "createFolder");
    formData.append("succinct", "true");
    formData.append("propertyId[0]", CmisPropertyName.NAME);
    formData.append("propertyValue[0]", folderName);
    formData.append("propertyId[1]", CmisPropertyName.OBJECT_TYPE_ID);
    formData.append("propertyValue[1]", "cmis:folder");

    return this.#execute<CmisObject>({
      method: "POST",
      url: this.#getObjectUrl(path.posix.dirname(normalized)),
      data: formData,
    });
  }

  async getContentStream(filePath: string): Promise<CmisResponse<ArrayBuffer>> {
    return this.#execute<ArrayBuffer>({
      method: "GET",
      url: this.#getObjectUrl(filePath),
      params: { cmisselector: "content", download: "inline" },
      responseType: "arraybuffer",
    });
  }

  async setContentStream(
    filePath: string,
    content: Blob,
    changeToken?: string,
  ): Promise<CmisResponse<CmisObject>> {
    const normalized = path.posix.normalize(filePath);
    const formData = new FormData();
    formData.append("cmisaction", "setContent");
    formData.append("succinct", "true");
    formData.append("overwriteFlag", "true");
    if (changeToken) formData.append("changeToken", changeToken);
    formData.append("content", content, path.posix.basename(normalized));

    return this.#execute<CmisObject>({
      method: "POST",
      url: this.#getObjectUrl(normalized),
      data: formData,
    });
  }

  async checkOut(filePath: string): Promise<CmisResponse<CmisObject>> {
    const formData = new FormData();
    formData.append("cmisaction", "checkOut");
    formData.append("succinct", "true");
    return this.#execute<CmisObject>({
      method: "POST",
      url: this.#getObjectUrl(filePath),
      data: formData,
    });
  }

  async checkIn(
    objectId: string,
    fileName: string,
    content: Blob,
  ): Promise<CmisResponse<CmisObject>> {
    const formData = new FormData();
    formData.append("cmisaction", "checkIn");
    formData.append("succinct", "true");
    formData.append("major", "true");
    formData.append("content", content, fileName);
    return this.#execute<CmisObject>({
      method: "POST",
      url: this.#getObjectUrl("/"),
      params: { objectId },
      data: formData,
    });
  }

  async cancelCheckOut(objectId: string): Promise<CmisResponse<void>> {
    const formData = new FormData();
    formData.append("cmisaction", "cancelCheckOut");
    return this.#execute<void>({
      method: "POST",
      url: this.#getObjectUrl("/"),
      params: { objectId },
      data: formData,
    });
  }

  async query(
    statement: string,
    options: CmisPagingOptions = {},
  ): Promise<CmisResponse<CmisQueryResultList>> {
    const formData = new FormData();
    formData.append("cmisaction", "query");
    formData.append("succinct", "true");
    formData.append("statement", statement);
    if (options.maxItems !== undefined) {
      formData.append("maxItems", String(options.maxItems));
    }
    if (options.skipCount !== undefined) {
      formData.append("skipCount", String(options.skipCount));
    }

    return this.#execute<CmisQueryResultList>({
      method: "POST",
      url: this.#getRepositoryUrl(),
      data: formData,
    });
  }
}
