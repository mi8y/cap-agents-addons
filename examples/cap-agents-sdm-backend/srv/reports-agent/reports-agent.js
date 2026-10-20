import cds from "@sap/cds";
import {
  createDeepAgent,
  StateBackend,
  CompositeBackend,
  createMemoryMiddleware,
  createSkillsMiddleware,
} from "deepagents";
import { SdmBackend } from "@mi8y/cap-agents-sdm-backend";

export default class ReportsAgent extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => {
      const tools = await this.send("buildTools");
      const model = await this.send("buildModel", { deepAgent: true, tools });
      const middleware = await this.send("buildMiddleware", { model, tools });
      const systemPrompt = await this.send("buildSystemPrompt");

      const repositoryId = cds.env.requires.sdm.settings.repositoryId;

      // Initialize SDM backends for instructions, skills, and reports
      const instructionBackend = new SdmBackend({
        repositoryId,
        virtualRootPath: "/",
      });
      const skillsBackend = new SdmBackend({
        repositoryId,
        virtualRootPath: "/skills",
      });
      const reportBackend = new SdmBackend({
        repositoryId,
        virtualRootPath: "/report",
      });

      // mount each backend under appropriate paths
      const additionalBackends = {};
      additionalBackends["/report/"] = additionalBackends["./report/"] =
        reportBackend;
      additionalBackends["/skills/"] = additionalBackends["./skills/"] =
        skillsBackend;

      // deepagents need middleware for AGENTS.md and Agent-Skills with correct backends
      const additionalMiddlewares = [
        // to load `AGENTS.md` file from SDM backend
        createMemoryMiddleware({
          backend: instructionBackend,
          sources: ["/AGENTS.md"],
        }),
        // to load agent-skills from SDM backend
        createSkillsMiddleware({
          backend: skillsBackend,
          sources: ["/skills/"],
        }),
      ];

      return createDeepAgent({
        model,
        tools,
        systemPrompt,
        middleware: [...middleware, ...additionalMiddlewares],
        backend: new CompositeBackend(new StateBackend(), additionalBackends),
      });
    });

    return super.init();
  }
}
