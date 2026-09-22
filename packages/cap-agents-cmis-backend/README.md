# @mi8y/cap-agents-cmis-backend

[![npm version](https://img.shields.io/npm/v/@mi8y/cap-agents-cmis-backend)](https://www.npmjs.com/package/@mi8y/cap-agents-cmis-backend)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A CMIS 1.1 Browser Binding filesystem backend for Deep Agents running in SAP CAP applications.

The backend implements `BackendProtocolV2` operations for listing, reading, writing, editing, globbing, and literal text search. HTTP requests use the SAP Cloud SDK so applications can resolve authentication and connectivity through service bindings or destinations.

## Installation

```sh
npm install @mi8y/cap-agents-cmis-backend
```

Requires:

- `deepagents >= 1`
- A CMIS 1.1 Browser Binding repository
- A Node.js runtime with `Blob` and `FormData`

## Create a backend

```ts
import { CmisBackend } from "@mi8y/cap-agents-cmis-backend";

const backend = new CmisBackend({
  destination: { destinationName: "CMIS" },
  repositoryId: "knowledge",
  virtualRootPath: "/agent-content",
});
```

`virtualRootPath` exposes one CMIS folder as `/` to the agent. The deprecated `rootPath` option remains available as an alias.

A fetched JWT can be passed through SAP Cloud SDK destination lookup options when user or subscriber context is required:

```ts
const backend = new CmisBackend({
  destination: { destinationName: "CMIS", jwt },
  repositoryId: "knowledge",
});
```

No network request is made by the constructor or CAP bootstrap hook. Credentials are resolved by the SAP Cloud SDK and are not stored by this package.

## CAP configuration

```json
{
  "cds": {
    "requires": {
      "cap-agents-cmis-backend": {
        "destinationName": "CMIS",
        "repositoryId": "knowledge",
        "virtualRootPath": "/agent-content"
      }
    }
  }
}
```

```ts
import cds from "@sap/cds";
import { CmisBackend } from "@mi8y/cap-agents-cmis-backend";

const config = cds.env.requires["cap-agents-cmis-backend"];
const backend = new CmisBackend({
  destination: { destinationName: config.destinationName },
  repositoryId: config.repositoryId,
  virtualRootPath: config.virtualRootPath,
});
```

## Filesystem behavior

- `ls` uses paginated CMIS `getChildren` requests.
- `read` and `readRaw` retrieve CMIS metadata and the content stream. Text is decoded and can be paginated by line; binary content is returned as `Uint8Array`.
- `write` creates missing parent folders, creates new documents, or replaces existing content.
- `edit` performs Deep Agents-compatible text replacement and rejects binary content.
- `glob` and `grep` use CMIS `getDescendants`. If a repository does not support it, the backend falls back to paginated recursive `getChildren` requests.
- `grep` performs literal, line-based matching and skips binary MIME types.

Writes to checked-in versionable documents first try `setContent`. Repositories such as OpenCMIS that require a private working copy are handled with `checkOut` followed by `checkIn`; a failed check-in triggers a best-effort `cancelCheckOut`.

All paths visible to the agent are absolute virtual paths. Traversal segments, backslashes, and null bytes are rejected before a CMIS request is made. Ordinary filesystem and CMIS failures are returned as structured Deep Agents errors.

Traversal is bounded by `maxTraversalItems`, which defaults to 10,000. Child request pages default to 100 entries:

```ts
const backend = new CmisBackend({
  destination: { destinationName: "CMIS" },
  repositoryId: "knowledge",
  maxTraversalItems: 5_000,
  pageSize: 200,
});
```

## Low-level client

The Browser Binding client is exported for direct CMIS operations:

```ts
import { SapCloudSdkCmisClient } from "@mi8y/cap-agents-cmis-backend";

const client = new SapCloudSdkCmisClient({
  destination: { destinationName: "CMIS" },
  repositoryId: "knowledge",
  browserBindingPath: "/browser",
});

const children = await client.getChildren("/documents", {
  maxItems: 100,
  skipCount: 0,
});
const descendants = await client.getDescendants("/documents");
const results = await client.query("SELECT * FROM cmis:document");
```

The client also exposes object metadata, folder tree, content stream, create, update, checkout, check-in, and cancel-checkout operations.

## License

[MIT License](./LICENSE)
