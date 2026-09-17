import cds from "@sap/cds";
import { tool, context } from "langchain";
import { z } from "zod";
import { vectorStore } from "./lib/vector-store.js";

const LOG = cds.log("agent-service");

const searchKnowledgeBase = tool(
  async ({ query, limit }) => {
    const documents = await vectorStore.similaritySearch(query, limit);

    LOG.info(`Found ${documents.length} documents for query: "${query}"`);

    return documents
      .map(
        (document) => context`
      ---
      src: ${document.metadata.source}
      ---
      ${document.pageContent}
      
      ###`,
      )
      .join("\n");
  },
  {
    name: "search_knowledge_base",
    description:
      "Search the text files ingested into the knowledge base for information relevant to a question.",
    schema: z.object({
      query: z.string().describe("search query"),
      limit: z.number().int().min(1).max(10).default(4),
    }),
  },
);

export class AgentService extends cds.ApplicationService {
  init() {
    this.on("buildTools", async (req, next) => {
      const tools = await next();
      return [...tools, searchKnowledgeBase];
    });

    return super.init();
  }
}
