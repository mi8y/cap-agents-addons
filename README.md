# SAP CAP Agent Plugins

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A collection of CAP CDS plugins for building production-ready AI agents with SAP CAP & `@cap-js/agents` plugin using LangChain/LangGraph/DeepAgents frameworks.

## Packages

| Description                                                                                                                                                                                      | Package                                                                               | Primary use case                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [**Memory Store**](https://docs.langchain.com/oss/javascript/langgraph/stores)/[Long-term Memory](https://docs.langchain.com/oss/javascript/langchain/long-term-memory)                          | [`@mi8y/cap-agents-memory`](./packages/cap-agents-memory/README.md)                   | Long-term, cross-thread memory for agent facts and user preferences. |
| [**Vector Store**](https://docs.langchain.com/oss/javascript/integrations/vectorstores/index) (CDS-based)                                                                                        | [`@mi8y/cap-agents-cds-vectorstore`](./packages/cap-agents-cds-vectorstore/README.md) | CDS-backed vector retrieval for RAG and semantic search.             |
| [**Vector Store**](https://docs.langchain.com/oss/javascript/integrations/vectorstores/index) (AI-Core Document-Grounding based)                                                                 | AI Core document-grounding vector store                                               | Managed document-grounding retrieval for RAG and semantic search.    |
| [**Backend** (Filesystem)](https://docs.langchain.com/oss/javascript/deepagents/backends)                                                                                                        | CMIS filesystem backend                                                               | CMIS-backed knowledge bases and agent skills.                        |
| (⚠️ Deprecated) [**Checkpointer**](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)/[Short-term Memory](https://docs.langchain.com/oss/javascript/langchain/short-term-memory) | [`@mi8y/cds-langgraph-persistence`](./packages/cds-langgraph-persistence/README.md)   | Short-term, thread-scoped LangGraph checkpoint persistence.          |

## Available Packages

### 1. Long-term memory

- **Package**: [`@mi8y/cap-agents-memory`](https://www.npmjs.com/package/@mi8y/cap-agents-memory)

- **Description**: CDS-backed [LangGraph Store](https://docs.langchain.com/oss/javascript/langgraph/stores) for durable, cross-thread memory. Use it to retain facts, preferences, and other context across sessions while preserving CAP database and tenant context.

```sh
cds add agent-memory
```

- **Examples**: [`examples/cap-agents-memory`](./examples/cap-agents-memory/README.md)

- **More Info**: [CAP Agents Memory README](./packages/cap-agents-memory/README.md)

![Demo of CAP Agents Memory](./docs/images/demo-cap-agent-memory.gif)

### 2. CDS vector store

- **Package**: [`@mi8y/cap-agents-cds-vectorstore`](https://www.npmjs.com/package/@mi8y/cap-agents-cds-vectorstore)

- **Description**: CDS-backed LangChain vector store for storing embeddings and documents in your CAP database, enabling RAG, semantic search, and retrieval.

```sh
cds add agent-cds-vectorstore
```

- **Examples**: [`examples/cap-agents-cds-vectorstore`](./examples/cap-agents-cds-vectorstore/README.md)

- **More Info**: [CAP Agents CDS Vector Store README](./packages/cap-agents-cds-vectorstore/README.md)

### 3. LangGraph checkpoint persistence

> [!WARNING]
>
> **Deprecated for new applications:** [`@cap-js/agents`](https://github.com/cap-js/agents) now includes checkpointer support. Prefer it for new CAP agent applications; this package remains available for existing implementations.

- **Package**: [`@mi8y/cds-langgraph-persistence`](https://www.npmjs.com/package/@mi8y/cds-langgraph-persistence)

- **Description**: CDS-backed checkpoint persistence for short-term, thread-scoped LangGraph state, including workflow resumption, conversation history, and time travel.

```sh
cds add langgraph-checkpointer
```

- **Examples**: [`examples/langchain-cds-persistence`](./examples/langchain-cds-persistence/README.md)

- **More Info**: [CAP LangGraph Persistence README](./packages/cds-langgraph-persistence/README.md)

## License

[MIT License](./LICENSE)
