import { Document, type DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { VectorStore } from "@langchain/core/vectorstores";
import {
  RetrievalApi,
  VectorApi,
  type RetrievalPerFilterSearchResult,
  type RetrievalVectorSearchFilter,
} from "@sap-ai-sdk/document-grounding";
import {
  dummyEmbeddings,
  mapDocumentsToGrounding,
  mapMetadataFromGrounding,
} from "./utils";

type DestinationConfig = {
  /**
   * Destination name for the AI Core destination configuration.
   */
  destinationName: string;
  /**
   * Should the destination be cached
   *
   * @link https://sap.github.io/cloud-sdk/docs/js/features/connectivity/destination-cache#cache-expiration
   */
  useCache?: boolean;
};

export type AICoreVectorStoreConfig = {
  /** Grounding collection ID. Collection titles are not accepted here. */
  collectionId: string;
  /**
   * SAP AI Core resource group. Will be sent as `AI-Resource-Group` header.
   *
   * @default "default"
   */
  aiResourceGroup?: string;
  /**
   * Destination configuration if AI Core is configured via a destination instead of service-binding
   *
   * @link https://sap.github.io/ai-sdk/docs/js/connecting-to-ai-core#using-a-destination
   */
  destination?: DestinationConfig;
};

/**
 * Filter type for AI Core vector store searches.
 */
export type AICoreVectorStoreFilter = Pick<
  RetrievalVectorSearchFilter,
  | "documentMetadata"
  | "chunkMetadata"
  | "dataRepositoryMetadata"
  | "filter"
  | "scoringConfiguration"
>;

export type AICoreVectorStoreDeleteParams = {
  /**
   * Document ID of the document to be deleted. (Note: this is not the chunk ID)
   */
  documentId: string;
};

/**
 * Vector Store implementation for AI Core document grounding.
 *
 * **Concept**
 * - In AI Core Document Grounding, 'chunks' are grouped into 'documents' which itself are grouped into 'collections'.
 * - The LangChain Vector Store operates on the concept of 'documents' which are akin to 'chunks' in AI Core Document Grounding.
 *
 * **Note**
 * - During `addDocuments` operation, chunks are provided. Hence, for every call, a new AI-Core 'document' is created with LangChain 'document' created as  'chunks'.
 * - During `search*` operations, the results are returned at the chunk level, which corresponds to LangChain 'documents'.
 */
class AICoreDocumentGroundingVectorStore extends VectorStore {
  declare FilterType: AICoreVectorStoreFilter;

  readonly #collectionId: string;
  readonly #headers: {
    "AI-Resource-Group": string;
  };
  readonly #destinationConfig: DestinationConfig | undefined;

  constructor(config: AICoreVectorStoreConfig) {
    super(dummyEmbeddings, config);

    if (!config.collectionId?.trim()) {
      throw new Error("collectionId is required");
    }

    this.#collectionId = config.collectionId;
    this.#destinationConfig = config.destination;
    this.#headers = {
      "AI-Resource-Group": config.aiResourceGroup ?? "default",
    };
  }

  _vectorstoreType(): string {
    return "aicore-document-grounding";
  }

  async addDocuments(documents: DocumentInterface[]): Promise<string[]> {
    if (documents.length === 0) {
      return [];
    }

    const addDocsRes = await VectorApi.updateDocuments(
      this.#collectionId,
      {
        documents: mapDocumentsToGrounding(documents),
      },
      this.#headers,
    ).execute(this.#destinationConfig);
    return addDocsRes.documents.map((d) => d.id);
  }

  async addVectors(
    _: number[][],
    documents: DocumentInterface[],
  ): Promise<string[]> {
    // The addVectors method is not supported directly because embeddings are generated server-side.
    // Instead, we delegate to addDocuments which handles server-side embedding.
    return this.addDocuments(documents);
  }

  async similaritySearch(
    query: string,
    k = 4,
    filter?: this["FilterType"],
  ): Promise<DocumentInterface[]> {
    return (await this.similaritySearchWithScore(query, k, filter)).map(
      ([document]) => document,
    );
  }

  async similaritySearchWithScore(
    query: string,
    k = 4,
    filter?: this["FilterType"],
  ): Promise<[DocumentInterface, number][]> {
    if (!query.trim()) {
      throw new Error("query must not be empty");
    }
    if (!Number.isInteger(k) || k < 1) {
      throw new Error("k must be a positive integer");
    }

    const retrievalRes = await RetrievalApi.search(
      {
        query,
        filters: [
          {
            ...filter,
            id: "langchain-search",
            dataRepositoryType: "vector",
            dataRepositories: [this.#collectionId],
            searchConfiguration: { maxChunkCount: k },
          },
        ],
      },
      this.#headers,
    ).execute(this.#destinationConfig);

    // The retrieval results are at the chunk level, which are mapped to LangChain 'documents' with associated scores.
    return retrievalRes.results.flatMap((filterResult) => {
      if ("error" in filterResult && filterResult.error) {
        throw new Error(
          `SAP AI Core Document Grounding search failed for filter '${filterResult.filterId}': ${filterResult.error.message}`,
        );
      }

      const searchResult = filterResult as RetrievalPerFilterSearchResult;
      return (searchResult.results ?? []).flatMap(({ dataRepository }) =>
        dataRepository.documents.flatMap((document) => {
          const documentMetadata = mapMetadataFromGrounding(document.metadata);
          return document.chunks.map((chunk) => {
            const chunkMetadata = mapMetadataFromGrounding(chunk.metadata);
            const score =
              chunk.postProcessingScore?.value ??
              chunk.searchScores?.aggregatedScore.value ??
              chunk.searchScores?.denseRetrievalScore.value ??
              0;

            return [
              new Document({
                id: document.id,
                pageContent: chunk.content,
                metadata: {
                  ...documentMetadata,
                  ...chunkMetadata,
                  grounding: {
                    collectionId: dataRepository.id,
                    collectionTitle: dataRepository.title,
                    documentId: document.id,
                    chunkId: chunk.id,
                  },
                },
              }),
              score,
            ] as [DocumentInterface, number];
          });
        }),
      );
    });
  }

  async similaritySearchVectorWithScore(): Promise<never> {
    throw new Error(
      `'similaritySearchVectorWithScore' is unsupported. SAP AI Core Document Grounding creates embeddings server-side.`,
    );
  }

  async delete(params?: AICoreVectorStoreDeleteParams): Promise<void> {
    if (!params?.documentId) {
      throw new Error("`documentId` is required");
    }

    // IMPORTANT: Deleting a document by ID will remove all associated chunks in the AI Core Document Grounding system.
    // No individual chunks can be deleted independently; they are always tied to their parent document.
    await VectorApi.deleteDocumentById(
      this.#collectionId,
      params.documentId,
      this.#headers,
    ).execute(this.#destinationConfig);
  }

  static async fromTexts(
    texts: string[],
    metadatas: Record<string, unknown>[] | Record<string, unknown>,
    _: EmbeddingsInterface,
    config: AICoreVectorStoreConfig,
  ): Promise<AICoreDocumentGroundingVectorStore> {
    const documents = texts.map(
      (text, index) =>
        new Document({
          pageContent: text,
          metadata: Array.isArray(metadatas)
            ? (metadatas[index] ?? {})
            : metadatas,
        }),
    );

    return this.fromDocuments(documents, _, config);
  }

  static async fromDocuments(
    documents: DocumentInterface[],
    _: EmbeddingsInterface,
    config: AICoreVectorStoreConfig,
  ): Promise<AICoreDocumentGroundingVectorStore> {
    const vectorStore = new this(config);
    await vectorStore.addDocuments(documents);
    return vectorStore;
  }
}

export { AICoreDocumentGroundingVectorStore as AICoreVectorStore };
