import { Document } from "@langchain/core/documents";
import { SyntheticEmbeddings } from "@langchain/core/utils/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AICoreVectorStore } from "@/index";
import { dummyEmbeddings } from "@/utils";

const sdkMocks = vi.hoisted(() => ({
  updateDocuments: vi.fn(),
  updateExecute: vi.fn(),
  deleteDocumentById: vi.fn(),
  deleteExecute: vi.fn(),
  search: vi.fn(),
  searchExecute: vi.fn(),
}));

vi.mock("@sap-ai-sdk/document-grounding", () => ({
  VectorApi: {
    updateDocuments: sdkMocks.updateDocuments,
    deleteDocumentById: sdkMocks.deleteDocumentById,
  },
  RetrievalApi: {
    search: sdkMocks.search,
  },
}));

const COLLECTION_ID = "collection-123";
const UUID = "123e4567-e89b-42d3-a456-426614174000";

beforeEach(() => {
  vi.clearAllMocks();
  sdkMocks.updateDocuments.mockReturnValue({ execute: sdkMocks.updateExecute });
  sdkMocks.deleteDocumentById.mockReturnValue({
    execute: sdkMocks.deleteExecute,
  });
  sdkMocks.search.mockReturnValue({ execute: sdkMocks.searchExecute });
  sdkMocks.updateExecute.mockResolvedValue({ documents: [{ id: UUID }] });
  sdkMocks.deleteExecute.mockResolvedValue(undefined);
  sdkMocks.searchExecute.mockResolvedValue({ results: [] });
});

describe("AICoreVectorStore", () => {
  test("requires a collectionId", () => {
    expect(
      () =>
        new AICoreVectorStore({
          collectionId: "",
        }),
    ).toThrow("collectionId is required");
  });

  test("exports the vector store class", () => {
    expect(AICoreVectorStore).toBeTypeOf("function");
  });

  test("upserts documents as chunks in a generated Grounding document", async () => {
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
    });

    await expect(
      store.addDocuments([
        new Document({
          id: UUID,
          pageContent: "SAP CAP documentation",
          metadata: { source: "cap.md", page: 2 },
        }),
      ]),
    ).resolves.toEqual([UUID]);

    expect(sdkMocks.updateDocuments).toHaveBeenCalledWith(
      COLLECTION_ID,
      {
        documents: [
          {
            id: expect.any(String),
            metadata: [],
            chunks: [
              {
                id: UUID,
                content: "SAP CAP documentation",
                metadata: [
                  { key: "source", value: ["cap.md"] },
                  { key: "page", value: ["2"] },
                ],
              },
            ],
          },
        ],
      },
      { "AI-Resource-Group": "default" },
    );
    expect(sdkMocks.updateExecute).toHaveBeenCalledWith(undefined);
  });

  test("retains a non-UUID source ID as the Grounding chunk ID", async () => {
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
    });

    await expect(
      store.addDocuments([
        new Document({
          id: "chapter-one",
          pageContent: "Content",
          metadata: {},
        }),
      ]),
    ).resolves.toEqual([UUID]);

    expect(sdkMocks.updateDocuments.mock.calls[0][1]).toEqual({
      documents: [
        {
          id: expect.any(String),
          metadata: [],
          chunks: [{ id: "chapter-one", content: "Content", metadata: [] }],
        },
      ],
    });
  });

  test("does not call the API for an empty document list", async () => {
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
    });

    await expect(store.addDocuments([])).resolves.toEqual([]);
    expect(sdkMocks.updateDocuments).not.toHaveBeenCalled();
  });

  test("passes resource group and destination configuration", async () => {
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
      aiResourceGroup: "grounding-rg",
      destination: {
        destinationName: "custom-aicore",
        useCache: false,
      },
    });

    await store.addDocuments([
      new Document({ pageContent: "Content", metadata: {} }),
    ]);

    expect(sdkMocks.updateDocuments.mock.calls[0][2]).toEqual({
      "AI-Resource-Group": "grounding-rg",
    });
    expect(sdkMocks.updateExecute).toHaveBeenCalledWith({
      destinationName: "custom-aicore",
      useCache: false,
    });
  });

  test("maps nested retrieval results and score precedence", async () => {
    sdkMocks.searchExecute.mockResolvedValue({
      results: [
        {
          filterId: "langchain-search",
          results: [
            {
              dataRepository: {
                id: COLLECTION_ID,
                title: "Knowledge Base",
                documents: [
                  {
                    id: UUID,
                    metadata: [{ key: "source", value: ["cap.md"] }],
                    chunks: [
                      {
                        id: "chunk-1",
                        content: "CAP is an application framework.",
                        metadata: [{ key: "section", value: ["intro"] }],
                        searchScores: {
                          aggregatedScore: { value: 0.8 },
                          denseRetrievalScore: { value: 0.7 },
                        },
                        postProcessingScore: { value: 0.95 },
                      },
                      {
                        id: "chunk-2",
                        content: "Second chunk",
                        metadata: [],
                        searchScores: {
                          aggregatedScore: { value: 0.6 },
                          denseRetrievalScore: { value: 0.5 },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
    });
    const results = await store.similaritySearchWithScore("What is CAP?", 2);

    expect(results).toHaveLength(2);
    expect(results[0][0]).toMatchObject({
      id: UUID,
      pageContent: "CAP is an application framework.",
      metadata: {
        source: "cap.md",
        section: "intro",
        grounding: {
          collectionId: COLLECTION_ID,
          collectionTitle: "Knowledge Base",
          documentId: UUID,
          chunkId: "chunk-1",
        },
      },
    });
    expect(results.map(([, score]) => score)).toEqual([0.95, 0.6]);
  });

  test("builds a collection-scoped retrieval filter", async () => {
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
      destination: { destinationName: "aicore" },
    });
    const filter = {
      documentMetadata: [{ key: "country", value: ["US"] }],
      id: "attempted-override",
      dataRepositories: ["another-collection"],
      searchConfiguration: { maxChunkCount: 100 },
    } as never;

    await store.similaritySearch("leave policy", 3, filter);

    expect(sdkMocks.search).toHaveBeenCalledWith(
      {
        query: "leave policy",
        filters: [
          {
            id: "langchain-search",
            dataRepositoryType: "vector",
            dataRepositories: [COLLECTION_ID],
            searchConfiguration: { maxChunkCount: 3 },
            documentMetadata: [{ key: "country", value: ["US"] }],
          },
        ],
      },
      { "AI-Resource-Group": "default" },
    );
    expect(sdkMocks.searchExecute).toHaveBeenCalledWith({
      destinationName: "aicore",
    });
  });

  test("reports per-filter retrieval errors", async () => {
    sdkMocks.searchExecute.mockResolvedValue({
      results: [
        {
          filterId: "langchain-search",
          error: { message: "Collection is unavailable" },
        },
      ],
    });
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
    });

    await expect(store.similaritySearch("query")).rejects.toThrow(
      "Collection is unavailable",
    );
  });

  test("validates query and result count", async () => {
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
    });

    await expect(store.similaritySearch("  ")).rejects.toThrow(
      "query must not be empty",
    );
    await expect(store.similaritySearch("query", 0)).rejects.toThrow(
      "k must be a positive integer",
    );
  });

  test("deletes explicitly selected documents", async () => {
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
    });

    await store.delete({ documentId: UUID });
    await store.delete({ documentId: "another-document" });

    expect(sdkMocks.deleteDocumentById).toHaveBeenNthCalledWith(
      1,
      COLLECTION_ID,
      UUID,
      { "AI-Resource-Group": "default" },
    );
    expect(sdkMocks.deleteDocumentById).toHaveBeenNthCalledWith(
      2,
      COLLECTION_ID,
      "another-document",
      { "AI-Resource-Group": "default" },
    );
    expect(sdkMocks.deleteExecute).toHaveBeenCalledTimes(2);
  });

  test("does not allow implicit collection-wide deletion", async () => {
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
    });

    await expect(store.delete()).rejects.toThrow("`documentId` is required");
  });

  test("delegates supplied documents to server-side vector generation", async () => {
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
    });

    await expect(
      store.addVectors(
        [[0.1, 0.2]],
        [new Document({ pageContent: "Content", metadata: {} })],
      ),
    ).resolves.toEqual([UUID]);
    expect(sdkMocks.updateDocuments).toHaveBeenCalledOnce();
    await expect(store.similaritySearchVectorWithScore()).rejects.toThrow(
      "'similaritySearchVectorWithScore' is unsupported",
    );
    expect(store._vectorstoreType()).toBe("aicore-document-grounding");
  });

  test("supports static construction helpers", async () => {
    const fromTexts = await AICoreVectorStore.fromTexts(
      ["First", "Second"],
      [{ order: 1 }, { order: 2 }],
      dummyEmbeddings,
      { collectionId: COLLECTION_ID },
    );
    expect(fromTexts).toBeInstanceOf(AICoreVectorStore);

    const fromDocuments = await AICoreVectorStore.fromDocuments(
      [new Document({ pageContent: "Third", metadata: {} })],
      dummyEmbeddings,
      { collectionId: COLLECTION_ID },
    );
    expect(fromDocuments).toBeInstanceOf(AICoreVectorStore);
  });

  test("supports the standard LangChain retriever", async () => {
    sdkMocks.searchExecute.mockResolvedValue({
      results: [
        {
          filterId: "langchain-search",
          results: [
            {
              dataRepository: {
                id: COLLECTION_ID,
                title: "Knowledge Base",
                documents: [
                  {
                    id: UUID,
                    metadata: [],
                    chunks: [
                      {
                        id: "chunk-1",
                        content: "Retrieved content",
                        metadata: [],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const store = new AICoreVectorStore({
      collectionId: COLLECTION_ID,
    });

    const documents = await store.asRetriever({ k: 1 }).invoke("question");

    expect(documents[0].pageContent).toBe("Retrieved content");
  });

  test("accepts the conventional LangChain static signature", async () => {
    const embeddings = new SyntheticEmbeddings({ vectorSize: 3 });

    const store = await AICoreVectorStore.fromDocuments(
      [new Document({ pageContent: "Content", metadata: {} })],
      embeddings,
      { collectionId: COLLECTION_ID },
    );

    expect(store).toBeInstanceOf(AICoreVectorStore);
  });
});
