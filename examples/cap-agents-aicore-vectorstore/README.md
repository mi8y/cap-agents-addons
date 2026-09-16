# AI Core Document Grounding vector store for CAP agents

This example shows how to give an [`@cap-js/agents`](https://www.npmjs.com/package/@cap-js/agents) agent a knowledge base backed by [`@mi8y/cap-agents-aicore-vectorstore`](https://www.npmjs.com/package/@mi8y/cap-agents-aicore-vectorstore).

It uploads plain-text files through a CAP media entity, splits them into chunks, and sends the chunks to SAP AI Core Document Grounding for storage and server-side embedding. The agent searches those chunks before answering questions and cites their source files.

## What you will build

The example adds an ingestion service and a retrieval tool to a standard CAP agent:

| Component               | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `TextFiles`             | Stores uploaded plain-text files as CAP media.                 |
| `TextFiles.ingest`      | Splits a file into chunks and adds them to Document Grounding. |
| `search_knowledge_base` | Finds chunks relevant to the agent's question.                 |

The vector store connects to an existing Document Grounding collection. The collection ID determines which knowledge base receives ingested chunks and is searched by the agent.

## Before you start

You need:

- A CAP Node.js project with an agent service
- SAP AI Core credentials for `@cap-js/agents` and Document Grounding
- An existing SAP AI Core Document Grounding collection

Document Grounding creates embeddings server-side according to the collection configuration. This example does not require a client-side LangChain embeddings implementation or a CDS persistence model for vectors.

## Set up a project

1. Copy `.env.example` to `.env` and update it with your AI Core service credentials.

2. Create a CAP application and add the Node.js runtime if you do not already have one:

```sh
cds init my-knowledge-agent
cd my-knowledge-agent
cds add nodejs
```

3. Install the agent runtime, vector-store plugin, LangChain packages, and SAP AI SDK integration:

```sh
npm install @cap-js/agents @mi8y/cap-agents-aicore-vectorstore \
  @sap-ai-sdk/langchain @langchain/core @langchain/textsplitters langchain zod
```

4. [Create a Document Grounding collection](https://sap.github.io/ai-sdk/docs/js/ai-core/document-grounding#create-a-collection), then configure its ID in `srv/lib/vector-store.js`:

```js
import { AICoreVectorStore } from "@mi8y/cap-agents-aicore-vectorstore";

export const vectorStore = new AICoreVectorStore({
  collectionId: "<document-grounding-collection-id>",
});
```

The SAP AI SDK uses the available AI Core service binding by default. If your application connects through a destination or uses a different resource group, pass those options as well:

```js
export const vectorStore = new AICoreVectorStore({
  collectionId: "<document-grounding-collection-id>",
  aiResourceGroup: "default",
  destination: {
    destinationName: "aicore",
    useCache: true,
  },
});
```

## Create the services

1. Create an agent service:

```cds
/**
 * You are a Knowledge Agent. Use the 'search_knowledge_base' tool to answer
 * user queries. You must cite the sources next to the relevant information.
 */
@agent
service AgentService {}
```

2. Create an ingestion service with a media entity and a bound action:

```cds
service IngestService {
  type IngestionResult {
    fileId     : UUID;
    chunkCount : Integer;
  }

  entity TextFiles : cuid, managed {
    @Core.MediaType: mediaType
    @Core.ContentDisposition.Filename: fileName
    @Core.ContentDisposition.Type: 'inline'
    content   : LargeBinary;
    fileName  : String(255);
    mediaType : String(100) default 'text/plain';
  } actions {
    action ingest() returns IngestionResult;
  };
}
```

The complete CDS definitions are in [`srv/agent-service.cds`](srv/agent-service.cds) and [`srv/ingest-service.cds`](srv/ingest-service.cds).

## Ingest text files

The ingestion handler uses `RecursiveCharacterTextSplitter` to divide an uploaded file into overlapping chunks. It creates LangChain `Document` objects with the source file ID, filename, and chunk number as metadata, then calls `AICoreVectorStore.addDocuments()`.

Each ingestion call creates one parent Grounding document whose chunks correspond to the LangChain documents. Document Grounding stores the content and generates its embeddings server-side.

CAP media uploads use two requests. First, create a file record:

```sh
curl -X POST http://localhost:4004/odata/v4/ingest/TextFiles \
  -H 'Content-Type: application/json' \
  -d '{"fileName":"cat-facts.txt","mediaType":"text/plain"}'
```

Copy the returned `ID`, then upload the file content:

```sh
curl -X PUT 'http://localhost:4004/odata/v4/ingest/TextFiles/<ID>/content' \
  -H 'Content-Type: text/plain' \
  --data-binary @files/cat-facts.txt
```

Finally, split the file and add its chunks to Document Grounding:

```sh
curl -X POST \
  'http://localhost:4004/odata/v4/ingest/TextFiles/<ID>/IngestService.ingest' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

See the complete handler in [`srv/ingest-service.js`](srv/ingest-service.js). Ready-to-run requests are also available in [`test/http/IngestService.http`](test/http/IngestService.http).

## Search the knowledge base

`AgentService` adds a `search_knowledge_base` tool with the standard LangChain `similaritySearch` API:

```js
const documents = await vectorStore.similaritySearch(query, limit);
```

Document Grounding performs retrieval in the configured collection and returns matching chunks as LangChain documents. The tool passes their content and source metadata to the agent. The agent's system prompt instructs it to use this tool for questions and cite the source in its response.

The complete implementation is in [`srv/agent-service.js`](srv/agent-service.js).

## Run the example

From this example directory, start CAP in watch mode:

```sh
cds watch
```

Upload a text file as described above, then open [the agent preview](http://localhost:4004/a2a/agent/preview/) and ask a question about it. For example, after uploading `cat-facts.txt`, ask: “What does the knowledge base say about cats?”

## Configure the vector store

The vector store requires a Document Grounding collection ID. It also supports an AI Core resource group and SAP Cloud SDK destination configuration. Storage, embedding, retrieval scoring, and collection lifecycle are managed by SAP AI Core Document Grounding rather than CAP persistence.

See the [AI Core vector-store plugin documentation](../../packages/cap-agents-aicore-vectorstore/README.md) for configuration options, ingestion behavior, metadata conversion, filtering, retrieval methods, and deletion behavior.
