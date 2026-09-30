# @mi8y/cap-agents-sdm-backend

A [Deep Agents](https://www.npmjs.com/package/deepagents) `BackendProtocolV2` filesystem backend for SAP Document Management Service (SDM) repositories via CMIS Browser Binding. HTTP requests use the SAP Cloud SDK. This package does not require `@cap-js/sdm` or manage repository provisioning.

## Setup

Install this package alongside `@sap/cds` (v10+) and `deepagents` (v1+). Give the application access to an existing CMIS repository. Either configure a Cloud SDK destination pointing to the **SDM API base URL** (not the UAA URL or `/browser`), or bind an SDM service in Cloud Foundry.

```ts
import { SdmBackend } from "@mi8y/cap-agents-sdm-backend";

const backend = new SdmBackend({
  repositoryId: "agent-files", // external CMIS repository ID
  destination: { destinationName: "SDM_API" }, // OPTIONAL: either provide a destination or rely on the SDM service binding
  virtualRootPath: "/agent-content", // OPTIONAL: existing folder in the repository
});

await backend.write("/notes/todo.md", "First task\n");
const result = await backend.read("/notes/todo.md");
```

When `destination` is omitted, the client uses the Cloud SDK to select the CF service binding labeled `sdm`. It exchanges the **current CAP HTTP request's Bearer JWT** using the binding's nested `credentials.uaa` and sends CMIS calls to `credentials.uri`. This is JWT-bearer-only: requests without a bearer JWT fail; there is no client-credentials or background-job fallback. For jobs or multiple SDM bindings, provide an explicit trusted destination. The host remains responsible for authenticated request context and tenant isolation; do not share a user-specific destination across tenants or put credentials in logs.

`repositoryId` may also be an async function returning an ID. If omitted, it is read from `cds.env.requires.sdm?.settings?.repositoryId`. The backend does not validate or provision a repository. The default Browser Binding path is `/browser` and can be changed with `browserBindingPath`.

## Filesystem behavior

The backend accepts **absolute virtual paths** (`virtualRootPath` defaults to `/`). With `virtualRootPath: "/agent-content"`, virtual `/notes/todo.md` corresponds to repository `/agent-content/notes/todo.md`. Results use virtual paths; `/` refers to the configured root. The root folder must already exist; writes can create missing folders _below_ it. Traversal paths are rejected, and `write` and `edit` cannot target `/`.

`ls`, `read`, `readRaw`, `write`, `edit`, `glob`, and literal `grep` return structured filesystem results, including errors. Reads are limited to 5 MiB by default (`maxFileSize`). Glob/grep scan at most 10,000 entries (`maxTraversalItems`) using pages of 100 (`pageSize`) when CMIS descendants are unavailable. Glob filters match paths relative to the search base using picomatch, including dotfiles. An update conflict may require checking in a CMIS working copy.

## Low-level client

`SapCloudSdkCmisClient` is also exported for direct Browser Binding operations, including listing, reading, creating, updating, checking out/in, querying, and explicit deletion. Unlike the backend, its path arguments are **repository paths**; it does not apply `virtualRootPath`. Only use delete operations on paths you own. The client uses either an explicit Cloud SDK destination or the request-scoped CF SDM binding fallback; it does not implement repository validation or provisioning.

## Development

From the monorepo root:

```sh
pnpm --filter @mi8y/cap-agents-sdm-backend build
pnpm --filter @mi8y/cap-agents-sdm-backend test
```

The local CMIS integration test is opt-in: set `CMIS_LIVE_DESTINATION` to a preconfigured, authenticated Cloud SDK destination and `CMIS_LIVE_REPOSITORY_ID` to a test repository. It creates and cleans up a unique test folder. The default test run skips it.

## License

[MIT](./LICENSE)
