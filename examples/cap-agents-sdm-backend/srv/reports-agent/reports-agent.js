import cds from "@sap/cds";
import {
  createDeepAgent,
  StateBackend,
  CompositeBackend,
  createMemoryMiddleware,
  createSkillsMiddleware,
  FilesystemBackend,
} from "deepagents";
import { SdmBackend } from "@mi8y/cap-agents-sdm-backend";

const LOG = cds.log("reports-agent");
const { fs, path } = cds.utils;

export default class ReportsAgent extends cds.ApplicationService {
  init() {
    this.on("buildGraph", async () => {
      const agentDir = path.dirname(
        path.join(cds.root, this.definition?.$location?.file),
      );
      LOG.info(`Agent initialising from directory: ${agentDir}`);

      const tools = await this.send("buildTools");
      const model = await this.send("buildModel", { deepAgent: true, tools });
      const middleware = await this.send("buildMiddleware", { model, tools });
      const systemPrompt = await this.send("buildSystemPrompt");

      const additionalBackends = {};
      const agentDirMiddleware = [];

      const agentFsBackend = new FilesystemBackend({
        rootDir: agentDir,
        virtualMode: true,
      });
      if (fs.existsSync(path.join(agentDir, "AGENTS.md"))) {
        agentDirMiddleware.push(
          createMemoryMiddleware({
            backend: agentFsBackend,
            sources: ["./AGENTS.md"],
          }),
        );
      }

      if (fs.existsSync(path.join(agentDir, "skills"))) {
        additionalBackends["./skills/"] = additionalBackends["/skills/"] =
          new FilesystemBackend({
            rootDir: path.join(agentDir, "skills"),
            virtualMode: true,
          });
        agentDirMiddleware.push(
          createSkillsMiddleware({
            backend: agentFsBackend,
            sources: ["./skills"],
          }),
        );
      }

      additionalBackends["./reports/"] = additionalBackends["/reports/"] =
        new SdmBackend({ repositoryId: "MI8Y_DOCS", virtualRootPath: "/" });

      return createDeepAgent({
        model,
        tools,
        systemPrompt: systemPrompt,
        middleware: [...middleware, ...agentDirMiddleware],
        backend: new CompositeBackend(new StateBackend(), additionalBackends),
      });
    });

    return super.init();
  }
}
