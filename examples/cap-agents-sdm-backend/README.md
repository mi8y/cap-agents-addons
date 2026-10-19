# CAP-Agents SDM Backend

## Get Started

- Update `cds.requires.llm.destinationName` to the right destination pointing to your AI Core instance
- Follow the steps [Onboarding Internal Repository](https://help.sap.com/docs/document-management-service/sap-document-management-service-f6e70dd4bffa4b65965b43feed4c9429/internal-repository) to onboard an internal repository
- Update the `repositoryId` and `objectId` under `'sap.ui5'.componentUsages.documentTable.settings` in [`manifest.json`](./app/reports/webapp/manifest.json),

- First do an initial deployment

````sh
cds up

- Then CDS bind to services

```sh
cds bind -2 ca-sdm-auth,ca-sdm-destination,ca-sdm-html5-rt,ca-sdm-sdm
````

- Start CAP server

```sh
cds watch --profile hybrid
```

- Start approuter

```sh
cds bind --exec -- npm start --prefix .deploy/app-router
```

- Open http://localhost:5001
