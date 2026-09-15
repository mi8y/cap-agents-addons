import { CDSVectorStore } from "@mi8y/cap-agents-cds-vectorstore";
import { AzureOpenAiEmbeddingClient } from "@sap-ai-sdk/langchain";

const embeddings = new AzureOpenAiEmbeddingClient({
  modelName: "text-embedding-3-large",
});

export const vectorStore = new CDSVectorStore(embeddings, {
  name: "knowledge-base",
  threshold: 0,
});
