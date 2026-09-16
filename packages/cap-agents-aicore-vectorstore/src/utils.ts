import { DocumentInterface } from "@langchain/core/documents";
import { EmbeddingsInterface } from "@langchain/core/embeddings";
import type {
  DocumentInput,
  RetrievalDocumentKeyValueListPair,
  RetrievalKeyValueListPair,
  VectorDocumentKeyValueListPair,
} from "@sap-ai-sdk/document-grounding";
import { randomUUIDv7 } from "node:crypto";

export const ORIGINAL_DOCUMENT_ID_METADATA_KEY =
  "__langchain_original_document_id";

export const dummyEmbeddings: EmbeddingsInterface = {
  async embedDocuments(): Promise<number[][]> {
    throw new Error(
      "SAP AI Core Document Grounding creates embeddings server-side.",
    );
  },
  async embedQuery(): Promise<number[]> {
    throw new Error(
      "SAP AI Core Document Grounding creates embeddings server-side.",
    );
  },
};

export function mapDocumentsToGrounding(
  documents: DocumentInterface[],
): DocumentInput[] {
  return [
    {
      id: randomUUIDv7(),
      metadata: [],
      chunks: documents.map((document) => {
        return {
          id: document.id ?? undefined,
          metadata: mapMetadataToGrounding(document.metadata ?? {}),
          content: document.pageContent,
        };
      }),
    },
  ];
}

export function mapMetadataToGrounding(
  metadata: Record<string, unknown>,
): VectorDocumentKeyValueListPair[] {
  return Object.entries(metadata).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }

    const values = Array.isArray(value)
      ? value.map(serializeMetadataValue)
      : [serializeMetadataValue(value)];

    return [{ key, value: values }];
  });
}

export function mapMetadataFromGrounding(
  metadata:
    | RetrievalDocumentKeyValueListPair[]
    | RetrievalKeyValueListPair[]
    | undefined,
): Record<string, string | string[]> {
  return Object.fromEntries(
    (metadata ?? []).map(({ key, value }) => [
      key,
      value.length === 1 ? value[0] : value,
    ]),
  );
}

function serializeMetadataValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  return JSON.stringify(value) ?? String(value);
}
