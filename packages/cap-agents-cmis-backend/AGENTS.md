# CAP Agents CMIS Backend Plugin

This package provides a Deep Agents Backend (implementing `BackendProtocolV2`) backed by a CMIS Browser Binding endpoint. HTTP calls must use the SAP Cloud SDK HTTP client so CAP applications can use service bindings, IAS/XSUAA tokens, destinations, proxies, and request middleware.

## Structure

<root>
├── package.json
├── AGENTS.md
├── src
│   ├── index.ts
│   ├── cmis-backend.ts # contains `BackendProtocolV2` adapter
│   ├── client.ts       # contains CMIS Browser Binding transport
│   └── utils.ts        # contains helpers
├── tests
│   └── ...
└── cds-plugin.js

There is no CDS persistence model because the CMIS repository owns document storage.

## Commands

- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`

Keep normal filesystem failures represented as structured Deep Agents result errors. Never read, store, or log destination credentials in this package.
