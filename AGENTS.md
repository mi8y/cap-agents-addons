# CAP CDS Plugin for building LangGraph/LangChain/Deep Agents within CAP framework

This is a turbo-based monorepo containing CDS plugins for building production-ready LangGraph/LangChain/Deep Agents within SAP CAP framework. The plugins here serves as a addon for [`@cap-js/agents`](https://github.com/cap-js/agents) plugin and extend its capabilities with additional features like memory, vector stores, additional backends etc.

## Project Structure

<root>
├── AGENTS.md <- You are here
├── package.json
├── packages
│   ├── integration-tests
│   │   ├── AGENTS.md <- Read this for integration test setup
│   │   └── ...
│   ├── cds-langgraph-persistence
│   │   ├── AGENTS.md <- Read this for persistence plugin (checkpoint) setup
│   │   └── ...
│   ├── cap-agents-memory
│   │   ├── AGENTS.md <- Read this for memory plugin setup
│   │   └── ...
│   ├── cap-agents-cds-vectorstore
│   │   ├── AGENTS.md <- Read this for CDS-based vectorstore plugin setup
│   │   └── ...
│   ├── cap-agents-aicore-vectorstore
│   │   ├── AGENTS.md <- Read this for AICore Document Grounding based vectorstore plugin setup
│   │   └── ...
│   ├── cap-agents-sdm-backend
│   │   ├── AGENTS.md <- Read this for SDM filesystem backend setup
│   │   └── ...
│   ├── cap-agents-utils
│   │   ├── AGENTS.md <- Read this for common utils
│   │   └── ...
│   └── integration-tests
│     ├── AGENTS.md <- Read this for integration test setup
│     └── ...
├── examples
│   └── ...
└── cds-plugin.js

## Development

- **`pnpm`** package manager. `npm install -g pnpm` if not already installed.
- Install - `pnpm install`
- Build - `pnpm build`
- Format - `pnpm format`
- Lint - `pnpm lint`
- Clean - `pnpm clean`

## Testing

- Uses Vitest framework and follows `*.test.ts` naming convention.
- Unit Test - `pnpm test:unit`
- Integration Test - `pnpm test:integration`
- Do not run `pnpm test` as it is meant for CI workflow

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md)
