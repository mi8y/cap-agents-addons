import { AICoreVectorStore } from "@mi8y/cap-agents-aicore-vectorstore";

// First create a AI Core Document Grounding collection here - https://sap.github.io/ai-sdk/docs/js/ai-core/document-grounding#create-a-collection

export const vectorStore = new AICoreVectorStore({
  collectionId: "9a1728ed-fbfb-4d6f-8c48-6cc3627d37ea",
});
