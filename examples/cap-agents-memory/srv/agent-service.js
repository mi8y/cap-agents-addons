import cds from "@sap/cds";
import { createAgent, tool } from "langchain";
import { CdsMemoryStore } from "@mi8y/cap-agents-memory";
import { z } from "zod";

const LOG = cds.log("agent-service");

export class AgentService extends cds.ApplicationService {
  init() {
    const saveUserPreferences = tool(
      async ({ text }, config) => {
        const userId = cds.context.user.id;
        await config.store.put(["users", "preferences"], userId, {
          pref: text,
        });
        LOG.info(`Saved preferences for userId: ${userId}`);
        return `Preferences for user ${userId} saved successfully.`;
      },
      {
        name: "save_user_prefs",
        description: "Save user preferences",
        schema: z.object({
          text: z.string().describe("User preferences to save"),
        }),
      },
    );

    const getUserPreferences = tool(
      async (_, config) => {
        const userId = cds.context.user.id;
        const preferences = await config.store.get(
          ["users", "preferences"],
          userId,
        );
        LOG.info(
          `Retrieved preferences for userId: ${userId}: ${JSON.stringify(preferences?.value)}`,
        );
        return preferences
          ? `Preferences for user ${userId}: ${preferences.value.pref}`
          : `No preferences found for user ${userId}.`;
      },
      {
        name: "get_user_prefs",
        description: "Get user preferences",
        schema: z.object({}),
      },
    );

    this.on("buildGraph", async () => {
      // CDS event-based agent initialization
      const tools = await this.send("buildTools");
      const model = await this.send("buildModel", { tools });
      const systemPrompt = await this.send("buildSystemPrompt");
      const middleware = await this.send("buildMiddleware", { tools, model });
      const memory = new CdsMemoryStore({
        name: "user_preferences_memory",
      });

      const agent = createAgent({
        model,
        tools: [...tools, saveUserPreferences, getUserPreferences],
        systemPrompt,
        middleware,
        store: memory,
      });

      return agent.graph;
    });

    return super.init();
  }
}
