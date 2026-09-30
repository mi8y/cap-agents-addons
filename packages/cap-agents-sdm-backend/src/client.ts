import {
  assertHttpDestination,
  getDestinationFromServiceBinding,
  getServiceBinding,
  retrieveJwt,
  type HttpDestinationOrFetchOptions,
} from "@sap-cloud-sdk/connectivity";
import {
  executeHttpRequest,
  type HttpRequestConfig,
  type HttpRequestOptions,
  type HttpResponse,
} from "@sap-cloud-sdk/http-client";
import cds from "@sap/cds";
import path from "node:path";
import {
  CmisPagingOptions,
  CmisPropertyName,
  type CmisObject,
  type CmisObjectInFolderContainer,
  type CmisObjectInFolderList,
  type CmisQueryResultList,
} from "./types";
import * as utils from "./utils";

const LOG = cds.log("cap-agents-sdm-backend");

export type CmisHttpRequestExecutor = (
  destination: HttpDestinationOrFetchOptions,
  requestConfig: HttpRequestConfig,
  options?: HttpRequestOptions,
) => Promise<HttpResponse>;

export type CmisHttpClientConfig = {
  /**
   * Destination for the CMIS repository. When omitted, use the CF SDM service
   * binding and exchange the current CAP request's bearer JWT for an SDM token.
   */
  destination?: HttpDestinationOrFetchOptions;
  /**
   * CMIS external repository ID. Pass static repository ID or a function that returns the repository ID (resolve repositoryID in case of multitenancy).
   * Falls back to cds.env.requires.sdm?.settings?.repositoryId if omitted.
   */
  repositoryId?: string | (() => Promise<string>);
  /** Browser Binding path on the destination's SDM API URL (leading slash optional).
   *
   * @default `/browser`
   */
  browserBindingPath?: string;
  /**
   * Injectable executor for tests and custom instrumentation.
   *
   * @default `executeHttpRequest`
   */
  requestExecutor?: CmisHttpRequestExecutor;
};

export type CmisResponse<T = unknown> = Omit<HttpResponse, "data"> & {
  data: T;
};

/** Thin CMIS Browser Binding transport built on the SAP Cloud SDK client. */
export class SapCloudSdkCmisClient {
  readonly #config: CmisHttpClientConfig;

  /** Set the destination and repository settings for CMIS requests. */
  constructor(config: CmisHttpClientConfig) {
    // resolve repository id
    if (!config.repositoryId && !cds.env.requires.sdm?.settings?.repositoryId) {
      throw new Error(
        "`repositoryId` must be specified in the configuration or in `cds.env.requires.sdm.settings`",
      );
    }

    this.#config = config;
  }

  /** Resolve the repository ID from configuration or CAP settings. */
  async #getRepositoryId(): Promise<string> {
    if (typeof this.#config.repositoryId === "function") {
      return this.#config.repositoryId();
    }
    return (
      this.#config.repositoryId ?? cds.env.requires.sdm?.settings?.repositoryId
    );
  }

  /** Use an explicit destination or exchange the CAP request JWT via the SDM binding. */
  async #getConnectionInfo(): Promise<HttpDestinationOrFetchOptions> {
    if (this.#config.destination) return this.#config.destination;

    // retrieve the bearer JWT from the current CAP request
    const req = cds.context?.http?.req;
    const userJwt = req && retrieveJwt(req);
    if (!userJwt) {
      LOG.warn("SDM service binding requires a CAP request bearer JWT");
      throw new Error(
        "A bearer JWT in the current CAP request is required for the SDM service binding",
      );
    }

    // exchange the CAP request JWT for an HTTP destination using the SDM service binding
    try {
      const binding = getServiceBinding("sdm");
      if (!binding) throw new Error("SDM service binding is not configured");

      const destination = await getDestinationFromServiceBinding({
        service: binding,
        jwt: userJwt,
        useCache: true,
        serviceBindingTransformFn: async (service) => {
          return utils.transformServiceBindingToJwtBearerAssertionDestination(
            service,
            userJwt,
          );
        },
      });
      assertHttpDestination(destination);
      LOG.debug("Resolved SDM service binding with JWT bearer flow");
      return destination;
    } catch {
      throw new Error("SDM JWT bearer destination resolution failed");
    }
  }

  /** Return the Browser Binding base path on the destination. */
  get #browserBindingPath() {
    return path.posix.join("/", this.#config.browserBindingPath ?? "browser");
  }

  /** Return the injected HTTP executor or the Cloud SDK default. */
  get #requestExecutor() {
    return this.#config.requestExecutor ?? executeHttpRequest;
  }

  /** Return the CMIS service's Browser Binding URL path. */
  #getServiceUrl() {
    return this.#browserBindingPath;
  }

  /** Build the Browser Binding URL path for this repository. */
  async #getRepositoryUrl() {
    return path.posix.join(
      this.#getServiceUrl(),
      encodeURIComponent(await this.#getRepositoryId()),
    );
  }

  /** Encode an absolute repository path into a CMIS object URL. */
  async #getObjectUrl(repositoryPath: string): Promise<string> {
    const normalized = utils.normalizeAbsolutePath(repositoryPath);
    const encoded = normalized
      .split(path.posix.sep)
      .filter(Boolean)
      .map(encodeURIComponent);
    return path.posix.join(await this.#getRepositoryUrl(), "root", ...encoded);
  }

  /** Send a request without exposing SDK errors that may contain credentials. */
  async #send(
    destination: HttpDestinationOrFetchOptions,
    config: HttpRequestConfig,
  ): Promise<HttpResponse> {
    try {
      return await this.#requestExecutor(destination, config);
    } catch (error) {
      const candidate = error as
        { status?: number; response?: { status?: number } } | undefined;
      if (
        typeof (candidate?.response?.status ?? candidate?.status) === "number"
      )
        throw error;
      // Do not attach an SDK error that could contain an authorization header.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("SDM request failed");
    }
  }

  /** Execute a CMIS request against the configured destination. */
  async #execute<T = unknown>(
    config: HttpRequestConfig,
  ): Promise<CmisResponse<T>> {
    const connInfo = await this.#getConnectionInfo();
    return (await this.#send(connInfo, config)) as CmisResponse<T>;
  }

  /** Fetch the repository's CMIS metadata and capabilities. */
  async getRepositoryInfo(): Promise<CmisResponse<Record<string, unknown>>> {
    return this.#execute<Record<string, unknown>>({
      method: "GET",
      url: await this.#getRepositoryUrl(),
      params: { cmisselector: "repositoryInfo" },
    });
  }

  /** List one page of a repository folder's immediate children. */
  async getChildren(
    repositoryPath: string,
    options: CmisPagingOptions = {},
  ): Promise<CmisResponse<CmisObjectInFolderList>> {
    return this.#execute<CmisObjectInFolderList>({
      method: "GET",
      url: await this.#getObjectUrl(repositoryPath),
      params: {
        cmisselector: "children",
        includePathSegment: true,
        succinct: true,
        maxItems: options.maxItems,
        skipCount: options.skipCount,
      },
    });
  }

  /** Fetch nested folder and document entries under a repository folder. */
  async getDescendants(
    repositoryPath: string,
    depth = -1,
  ): Promise<CmisResponse<CmisObjectInFolderContainer[]>> {
    return this.#execute<CmisObjectInFolderContainer[]>({
      method: "GET",
      url: await this.#getObjectUrl(repositoryPath),
      params: {
        cmisselector: "descendants",
        includePathSegment: true,
        succinct: true,
        depth,
      },
    });
  }

  /** Fetch nested folders without their document entries. */
  async getFolderTree(
    repositoryPath: string,
    depth = -1,
  ): Promise<CmisResponse<CmisObjectInFolderContainer[]>> {
    return this.#execute<CmisObjectInFolderContainer[]>({
      method: "GET",
      url: await this.#getObjectUrl(repositoryPath),
      params: {
        cmisselector: "folderTree",
        includePathSegment: true,
        succinct: true,
        depth,
      },
    });
  }

  /** Fetch succinct CMIS properties for an object by repository path. */
  async getObject(repositoryPath: string): Promise<CmisResponse<CmisObject>> {
    return this.#execute<CmisObject>({
      method: "GET",
      url: await this.#getObjectUrl(repositoryPath),
      params: { cmisselector: "object", succinct: true },
    });
  }

  /** Upload a new document into the parent folder of a repository path. */
  async createDocument(
    repositoryPath: string,
    content: Blob,
  ): Promise<CmisResponse<CmisObject>> {
    const normalizedRepositoryPath =
      utils.normalizeAbsolutePath(repositoryPath);

    const fileName = path.posix.basename(normalizedRepositoryPath);
    if (normalizedRepositoryPath === "/")
      throw new Error(`cannot create a document at path - '${repositoryPath}'`);

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
      url: await this.#getObjectUrl(
        path.posix.dirname(normalizedRepositoryPath),
      ),
      data: formData,
    });
  }

  /** Create a repository folder inside its existing parent folder. */
  async createFolder(
    repositoryPath: string,
  ): Promise<CmisResponse<CmisObject>> {
    const normalizedRepositoryPath =
      utils.normalizeAbsolutePath(repositoryPath);

    const folderName = path.posix.basename(normalizedRepositoryPath);
    if (normalizedRepositoryPath === "/")
      throw new Error(`cannot create the folder at path - '${repositoryPath}'`);

    const formData = new FormData();
    formData.append("cmisaction", "createFolder");
    formData.append("succinct", "true");
    formData.append("propertyId[0]", CmisPropertyName.NAME);
    formData.append("propertyValue[0]", folderName);
    formData.append("propertyId[1]", CmisPropertyName.OBJECT_TYPE_ID);
    formData.append("propertyValue[1]", "cmis:folder");

    return this.#execute<CmisObject>({
      method: "POST",
      url: await this.#getObjectUrl(
        path.posix.dirname(normalizedRepositoryPath),
      ),
      data: formData,
    });
  }

  /** Download a document's complete content stream as bytes. */
  async getContentStream(
    repositoryPath: string,
  ): Promise<CmisResponse<ArrayBuffer>> {
    const normalizedRepositoryPath =
      utils.normalizeAbsolutePath(repositoryPath);

    return this.#execute<ArrayBuffer>({
      method: "GET",
      url: await this.#getObjectUrl(normalizedRepositoryPath),
      params: { cmisselector: "content", download: "inline" },
      responseType: "arraybuffer",
    });
  }

  /** Replace document content, using a change token when available. */
  async setContentStream(
    repositoryPath: string,
    content: Blob,
    changeToken?: string,
  ): Promise<CmisResponse<CmisObject>> {
    const normalizedRepositoryPath =
      utils.normalizeAbsolutePath(repositoryPath);

    const formData = new FormData();
    formData.append("cmisaction", "setContent");
    formData.append("succinct", "true");
    formData.append("overwriteFlag", "true");
    if (changeToken) formData.append("changeToken", changeToken);
    formData.append(
      "content",
      content,
      path.posix.basename(normalizedRepositoryPath),
    );

    return this.#execute<CmisObject>({
      method: "POST",
      url: await this.#getObjectUrl(normalizedRepositoryPath),
      data: formData,
    });
  }

  /** Check out a document to obtain a private working copy. */
  async checkOut(repositoryPath: string): Promise<CmisResponse<CmisObject>> {
    const normalizedRepositoryPath =
      utils.normalizeAbsolutePath(repositoryPath);

    const formData = new FormData();
    formData.append("cmisaction", "checkOut");
    formData.append("succinct", "true");

    return this.#execute<CmisObject>({
      method: "POST",
      url: await this.#getObjectUrl(normalizedRepositoryPath),
      data: formData,
    });
  }

  /** Check in new content for a private working copy by object ID. */
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
      url: await this.#getObjectUrl("/"),
      params: { objectId },
      data: formData,
    });
  }

  /** Discard a checkout by its working-copy object ID. */
  async cancelCheckOut(objectId: string): Promise<CmisResponse<void>> {
    const formData = new FormData();
    formData.append("cmisaction", "cancelCheckOut");

    return this.#execute<void>({
      method: "POST",
      url: await this.#getObjectUrl("/"),
      params: { objectId },
      data: formData,
    });
  }

  /** Remove all versions of a document by repository path. */
  async deleteObject(repositoryPath: string): Promise<CmisResponse<void>> {
    const data = new FormData();
    data.append("cmisaction", "delete");
    data.append("allVersions", "true");
    return this.#execute<void>({
      method: "POST",
      url: await this.#getObjectUrl(repositoryPath),
      data,
    });
  }

  /** Recursively remove a folder; use only on caller-owned paths. */
  async deleteTree(repositoryPath: string): Promise<CmisResponse<void>> {
    const data = new FormData();
    data.append("cmisaction", "deleteTree");
    data.append("allVersions", "true");
    return this.#execute<void>({
      method: "POST",
      url: await this.#getObjectUrl(repositoryPath),
      data,
    });
  }

  /** Run a paginated CMIS query against the repository. */
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
      url: await this.#getRepositoryUrl(),
      data: formData,
    });
  }
}
