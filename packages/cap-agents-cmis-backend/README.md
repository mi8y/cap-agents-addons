# @mi8y/cap-agents-cmis-backend

A [Deep Agents](https://www.npmjs.com/package/deepagents) `BackendProtocolV2` filesystem backed by an SAP Document Management Service (SDM) CMIS Browser Binding repository. HTTP requests use the SAP Cloud SDK. This package does not require `@cap-js/sdm` or manage repository provisioning.

## Setup

Install this package alongside `@sap/cds` (v10+) and `deepagents` (v1+). Configure a Cloud SDK destination pointing to the **SDM API base URL**, not the UAA URL or `/browser`, and give it access to an existing CMIS repository.

```ts
import { CmisBackend } from "@mi8y/cap-agents-cmis-backend";

const backend = new CmisBackend({
  destination: { destinationName: "SDM_API" }, // configured by your application
  repositoryId: "agent-files", // external CMIS repository ID
  virtualRootPath: "/agent-content", // existing folder in the repository
});

await backend.write("/notes/todo.md", "First task\n");
const result = await backend.read("/notes/todo.md");
```

`repositoryId` may also be an async function returning an ID. If omitted, it is read from `cds.env.requires.sdm?.settings?.repositoryId`. The backend does not validate or provision a repository. The host application owns destination authentication and tenant isolation: configure a trusted destination for the relevant request or tenant rather than sharing a user-specific destination across tenants. Do not put credentials in package files or logs. The default Browser Binding path is `/browser` and can be changed with `browserBindingPath`.

## Filesystem behavior

The backend accepts **absolute virtual paths** (`virtualRootPath` defaults to `/`). With `virtualRootPath: "/agent-content"`, virtual `/notes/todo.md` corresponds to repository `/agent-content/notes/todo.md`. Results use virtual paths; `/` refers to the configured root. The root folder must already exist; writes can create missing folders _below_ it. Traversal paths are rejected, and `write` and `edit` cannot target `/`.

`ls`, `read`, `readRaw`, `write`, `edit`, `glob`, and literal `grep` return structured filesystem results, including errors. Reads are limited to 5 MiB by default (`maxFileSize`). Glob/grep scan at most 10,000 entries (`maxTraversalItems`) using pages of 100 (`pageSize`) when CMIS descendants are unavailable. Glob filters match paths relative to the search base using picomatch, including dotfiles. An update conflict may require checking in a CMIS working copy.

## Low-level client

`SapCloudSdkCmisClient` is also exported for direct Browser Binding operations, including listing, reading, creating, updating, checking out/in, querying, and explicit deletion. Unlike the backend, its path arguments are **repository paths**; it does not apply `virtualRootPath`. Only use delete operations on paths you own. The client uses a host-supplied Cloud SDK destination and does not implement repository validation or connection/tenant management.

## Development

From the monorepo root:

```sh
pnpm --filter @mi8y/cap-agents-cmis-backend build
pnpm --filter @mi8y/cap-agents-cmis-backend test
```

The local CMIS integration test is opt-in: set `CMIS_LIVE_DESTINATION` to a preconfigured, authenticated Cloud SDK destination and `CMIS_LIVE_REPOSITORY_ID` to a test repository. It creates and cleans up a unique test folder. The default test run skips it.

## License

[MIT](./LICENSE)
