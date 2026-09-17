const cds = require("@sap/cds");

const LOG = cds.log("cap-agents-aicore-vectorstore");

cds.on("bootstrap", () => {
  const config = cds.env.requires?.["cap-agents-aicore-vectorstore"];

  if (!config?.collectionId) {
    LOG.warn(
      "Detected '@mi8y/cap-agents-aicore-vectorstore' without a collectionId. " +
        "Configure cds.requires.cap-agents-aicore-vectorstore.collectionId before creating the vector store.",
    );
  }
});
