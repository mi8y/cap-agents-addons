# CAP Agents Plugin for SAP AI Core Document Grounding

This package provides a LangChain `VectorStore` implementation backed by SAP AI Core Document Grounding for SAP CAP applications.

## Project Structure

<root>
├── package.json
├── AGENTS.md
├── src
│   ├── index.ts
│   ├── aicore-vectorstore.ts
│   ├── client.ts
│   └── metadata.ts
├── tests
│   └── ...
└── cds-plugin.js

There is no CDS persistence model: SAP AI Core owns document storage, embedding, and retrieval.

## Commands

- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`

## Contributing

Read [CONTRIBUTING.md](../../CONTRIBUTING.md).
