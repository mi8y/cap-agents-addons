# @mi8y/cap-agents-aicore-vectorstore

[![npm version](https://img.shields.io/npm/v/@mi8y/cap-agents-aicore-vectorstore)](https://www.npmjs.com/package/@mi8y/cap-agents-aicore-vectorstore)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A LangChain `VectorStore` for SAP CAP applications backed by the SAP AI Core Document Grounding service.

SAP AI Core owns document storage, embedding, and retrieval. The package therefore needs no CDS persistence model or client-side LangChain embeddings implementation.

## Installation

```sh
npm install @mi8y/cap-agents-aicore-vectorstore
```

Requires:

- `@sap/cds >= 10`
- `@langchain/core >= 1`
- An existing SAP AI Core Document Grounding collection
- SAP AI Core credentials through a service binding or a configured SAP Cloud SDK destination

## Configuration

`collectionId` is required and must be the Grounding collection ID, not its human-readable title.

```ts
import { AICoreVectorStore } from "@mi8y/cap-agents-aicore-vectorstore";

const vectorStore = new AICoreVectorStore({
  collectionId: "2b0f4d00-0000-0000-0000-000000000000",
  aiResourceGroup: "default",
  destination: {
    destinationName: "aicore",
    useCache: true,
  },
});
```

Options:

- `collectionId: string` — required Grounding collection ID.
- `aiResourceGroup?: string` — value of the `AI-Resource-Group` header; defaults to `default`.
- `destination?: object` — optional destination configuration. When omitted, the SAP AI SDK uses its default connection, such as an AI Core service binding.
  - `destinationName: string` — SAP Cloud SDK destination name.
  - `useCache?: boolean` — whether the SAP Cloud SDK destination cache should be used.

A CAP application can keep these values under `cds.requires`:

```json
{
  "cds": {
    "requires": {
      "cap-agents-aicore-vectorstore": {
        "collectionId": "2b0f4d00-0000-0000-0000-000000000000",
        "aiResourceGroup": "default",
        "destination": {
          "destinationName": "aicore",
          "useCache": true
        }
      }
    }
  }
}
```

And then you can use the configuration to instantiate the `AICoreVectorStore` as shown below:

```js
import cds from "@sap/cds";
import { AICoreVectorStore } from "@mi8y/cap-agents-aicore-vectorstore";

const config = cds.env.requires["cap-agents-aicore-vectorstore"];
export const vectorStore = new AICoreVectorStore(config);
```

## Add documents

LangChain and Document Grounding use different document models:

- A LangChain document corresponds to a Grounding chunk.
- Grounding chunks are grouped into Grounding documents.
- Grounding documents belong to a collection.

Each non-empty `addDocuments()` call creates one Grounding document with a random UUID v7. Every supplied LangChain document becomes a chunk in that parent document. If a LangChain `Document.id` is present, it is used as the Grounding chunk ID.

```ts
import { Document } from "@langchain/core/documents";

const groundingDocumentIds = await vectorStore.addDocuments([
  new Document({
    id: "cap-overview",
    pageContent: "SAP CAP is a framework for enterprise applications.",
    metadata: { source: "guide.md", topic: "cap" },
  }),
  new Document({
    id: "cap-services",
    pageContent: "CAP services are described using CDS.",
    metadata: { source: "guide.md", topic: "services" },
  }),
]);
```

Document metadata is stored on its corresponding chunk. Embeddings are generated server-side according to the collection configuration. The returned IDs are the Grounding document IDs reported by the update API, not the input chunk IDs. Passing an empty array returns an empty array without calling the API.

## Search and retrievers

```ts
const results = await vectorStore.similaritySearch("What is SAP CAP?", 4);

const scoredResults = await vectorStore.similaritySearchWithScore(
  "What is SAP CAP?",
  4,
);

const retriever = vectorStore.asRetriever({ k: 4 });
const documents = await retriever.invoke("What is SAP CAP?");
```

A retrieved Grounding chunk becomes one LangChain document. The LangChain document ID is the parent Grounding document ID. Grounding document metadata and chunk metadata are merged, and identifiers are added under `metadata.grounding`:

```ts
{
  collectionId: "2b0f4d00-0000-0000-0000-000000000000",
  collectionTitle: "CAP documentation",
  documentId: "0195f4c0-0000-7000-8000-000000000000",
  chunkId: "cap-overview",
}
```

When document and chunk metadata use the same key, chunk metadata takes precedence. The returned score uses `postProcessingScore`, then `aggregatedScore`, then `denseRetrievalScore`; it falls back to `0` when no score is available.

Queries must not be empty, and `k` must be a positive integer.

## Metadata filters

Filtering uses SAP AI Core's native retrieval filter structures rather than Mongo-style operators:

```ts
const documents = await vectorStore.similaritySearch("leave policy", 4, {
  documentMetadata: [
    {
      key: "country",
      value: ["US"],
    },
  ],
  chunkMetadata: [
    {
      key: "language",
      value: ["en"],
    },
  ],
});
```

The filter accepts the following SAP AI Core retrieval fields:

- `documentMetadata`
- `chunkMetadata`
- `dataRepositoryMetadata`
- `filter`
- `scoringConfiguration`

The adapter always enforces its configured collection ID, the `vector` repository type, the `langchain-search` filter ID, and `searchConfiguration.maxChunkCount` based on `k`. These fields cannot be overridden through the supplied filter.

## Metadata conversion

Grounding represents every metadata value as `string[]`. Ingestion converts values as follows:

- Strings remain strings.
- Numbers, booleans, and bigints use `String(value)`.
- Arrays are converted element by element.
- Objects and `null` use JSON serialization.
- `undefined` properties are omitted.

On retrieval, a single value becomes a string and multiple values remain an array. Values are not automatically converted back to numbers, booleans, or objects.

## Delete documents

Deletion requires one explicit parent Grounding document ID:

```ts
await vectorStore.delete({ documentId: groundingDocumentIds[0] });
```

Deleting a Grounding document removes all chunks associated with it. Individual chunks cannot be deleted through this adapter. Calling `delete()` without a `documentId` throws, preventing accidental collection-wide deletion. Collection lifecycle operations remain outside the LangChain vector-store adapter.

## Static helpers

The static helpers follow the conventional LangChain signatures:

```ts
const fromTexts = await AICoreVectorStore.fromTexts(
  texts,
  metadata,
  embeddings,
  config,
);

const fromDocuments = await AICoreVectorStore.fromDocuments(
  documents,
  embeddings,
  config,
);
```

The embeddings argument is required by the LangChain API but ignored by this implementation because Document Grounding generates embeddings server-side. Both helpers create a vector store and immediately add the supplied content.

## Vector operations

`addVectors(vectors, documents)` ignores the supplied vectors and delegates the documents to `addDocuments()` so that embeddings are generated server-side.

`similaritySearchVectorWithScore()` is unsupported because Document Grounding accepts text queries rather than caller-provided query vectors. Use `similaritySearch()`, `similaritySearchWithScore()`, or a LangChain retriever instead.

## License

[MIT License](./LICENSE)
