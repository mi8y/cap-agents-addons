# @mi8y/cap-agents-sdm-backend

[![npm version](https://img.shields.io/npm/v/@mi8y/cap-agents-sdm-backend)](https://www.npmjs.com/package/@mi8y/cap-agents-sdm-backend)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Deep Agents](https://www.npmjs.com/package/deepagents) `BackendProtocolV2` filesystem for SAP Document Management Service (SDM) repositories via CMIS Browser Binding. HTTP requests use the SAP Cloud SDK. SDM owns document storage; this package does not require `@cap-js/sdm`, define a CDS persistence model, or provision repositories.

## Installation

```sh
npm install @mi8y/cap-agents-sdm-backend
```

Requires:

- `@sap/cds >= 10`
- `deepagents >= 1`
- An existing SDM CMIS repository and either a Cloud SDK destination pointing to the **SDM API base URL** (not the UAA URL or `/browser`) or an SDM service binding in Cloud Foundry

There is no `cds add` step.

## Configuration

Pass the repository ID and, when using a named Cloud SDK destination, its name to `SdmBackend`:

```ts
import { SdmBackend } from "@mi8y/cap-agents-sdm-backend";

const backend = new SdmBackend({
  repositoryId: "agent-files",
  destination: { destinationName: "SDM_API" },
  virtualRootPath: "/agent-content",
});
```

When `destination` is omitted, the client selects the CF service binding labeled `sdm` and exchanges the **current CAP HTTP request's Bearer JWT** using the binding's nested `credentials.uaa`. It sends CMIS calls to `credentials.uri`. This is JWT-bearer-only: requests without a bearer JWT fail; there is no client-credentials or background-job fallback. For jobs or multiple SDM bindings, provide an explicit trusted destination.

`repositoryId` may also be an async function returning an ID. If omitted, the client reads `cds.env.requires.sdm?.settings?.repositoryId`. The repository and `virtualRootPath` folder must already exist; the backend does not validate or provision them. The default Browser Binding path is `/browser` and can be changed with `browserBindingPath`.

## Usage

```ts
await backend.write("/notes/todo.md", "First task\n");
const result = await backend.read("/notes/todo.md");
```

`virtualRootPath` defaults to `/`. With `virtualRootPath: "/agent-content"`, virtual `/notes/todo.md` corresponds to repository `/agent-content/notes/todo.md`. Backend results use virtual paths; `/` refers to the configured root. Writes can create missing folders _below_ that root. Traversal paths are rejected, and `write` and `edit` cannot target `/`.

## API

### `new SdmBackend(config)`

| Option               | Type                                | Description                                                                               |
| -------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `repositoryId`       | `string \| (() => Promise<string>)` | CMIS repository ID; defaults to `cds.env.requires.sdm?.settings?.repositoryId`.           |
| `destination`        | Cloud SDK destination options       | Optional; without one, uses the request-scoped SDM service binding and bearer JWT.        |
| `virtualRootPath`    | `string`                            | Existing CMIS folder exposed as `/`; defaults to `/`.                                     |
| `browserBindingPath` | `string`                            | Browser Binding path on the SDM API base URL; defaults to `/browser`.                     |
| `maxFileSize`        | `number`                            | Maximum bytes per read; defaults to 5 MiB.                                                |
| `maxTraversalItems`  | `number`                            | Maximum entries scanned by glob/grep; defaults to 10,000.                                 |
| `pageSize`           | `number`                            | Page size for children requests; defaults to 100.                                         |
| `requestExecutor`    | `CmisHttpRequestExecutor`           | Optional HTTP request executor for testing or instrumentation; defaults to the Cloud SDK. |

The backend implements `ls`, `read`, `readRaw`, `write`, `edit`, `glob`, and literal `grep`. These return structured filesystem results, including errors. Glob filters match paths relative to the search base using picomatch, including dotfiles. Glob/grep use paged traversal when CMIS descendants are unavailable. An update conflict may require checking in a CMIS working copy.

### `new SapCloudSdkCmisClient(config)`

`SapCloudSdkCmisClient` is exported for direct Browser Binding operations, including listing, reading, creating, updating, checking out/in, querying, and explicit deletion. It accepts the CMIS transport options above (`repositoryId`, `destination`, `browserBindingPath`, and `requestExecutor`). Unlike `SdmBackend`, its path arguments are **repository paths**, not virtual paths. Only use delete operations on paths you own. The client does not validate or provision repositories.

## CAP notes

- The host is responsible for authenticated request context and tenant isolation. Do not share user-specific destinations across tenants or put credentials in logs.
- The SDM service binding fallback requires a bearer JWT in the current CAP HTTP request. Use an explicit trusted destination for background work.
- CMIS in client and wire-level names refers to the Browser Binding protocol; SDM is the backing service.

## Development

From the monorepo root:

```sh
pnpm --filter @mi8y/cap-agents-sdm-backend build
pnpm --filter @mi8y/cap-agents-sdm-backend test
```

The local CMIS integration test is opt-in: set `CMIS_LIVE_DESTINATION` to a preconfigured, authenticated Cloud SDK destination and `CMIS_LIVE_REPOSITORY_ID` to a test repository. It creates and cleans up a unique test folder. The default test run skips it.

## License

[MIT License](./LICENSE)
