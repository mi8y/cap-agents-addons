import {
  CdsCheckpointSaver,
  DEFAULT_FQN_ENTITY_CHECKPOINT_WRITES,
  DEFAULT_FQN_ENTITY_CHECKPOINTS,
} from "@/checkpoint/cds-checkpointer";
import {
  CheckpointSaverTestInitializer,
  validate,
} from "@langchain/langgraph-checkpoint-validation";
import cds from "@sap/cds";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { fileURLToPath } from "url";

export const cdsCheckpointSaverTestInitializer: CheckpointSaverTestInitializer<CdsCheckpointSaver> =
  {
    checkpointerName: "@mi8y/cds-langgraph-persistence",

    async beforeAll() {
      // since tests are run from the root of the monorepo, we need to set the cds.root to the path of the package
      cds.root = fileURLToPath(
        import.meta.resolve("@mi8y/cds-langgraph-persistence"),
      );

      // cds file from @mi8y/langgraph-cds-model package
      const cdsFilePath = fileURLToPath(
        import.meta.resolve("./model.cds", import.meta.url),
      );
      const csn = await cds.load(cdsFilePath).then(cds.minify);
      cds.model = cds.compile.for.nodejs(csn);

      cds.requires.db = {
        kind: "sqlite",
        impl: "@cap-js/sqlite",
        credentials: { url: ":memory:" },
      };

      cds.db = await cds.connect.to("db");

      // @ts-ignore
      await cds.deploy(cdsFilePath, {}).to(cds.db);
    },

    async afterAll() {
      // @ts-ignore
      await cds.db.disconnect?.();
    },

    async createCheckpointer() {
      return new CdsCheckpointSaver({ name: "test" });
    },

    async destroyCheckpointer() {
      await DELETE.from(DEFAULT_FQN_ENTITY_CHECKPOINT_WRITES);
      await DELETE.from(DEFAULT_FQN_ENTITY_CHECKPOINTS);
    },
  };

validate(cdsCheckpointSaverTestInitializer);

describe("pending writes from older schemas", () => {
  beforeAll(() => cdsCheckpointSaverTestInitializer.beforeAll?.());
  afterAll(() => cdsCheckpointSaverTestInitializer.afterAll?.());
  afterEach(async () => {
    await DELETE.from(DEFAULT_FQN_ENTITY_CHECKPOINT_WRITES);
    await DELETE.from(DEFAULT_FQN_ENTITY_CHECKPOINTS);
  });

  it.each(["getTuple", "list"] as const)(
    "%s sorts null task paths as empty paths",
    async (method) => {
      const saver = new CdsCheckpointSaver({ name: "legacy-writes" });
      const config = await saver.put(
        { configurable: { thread_id: "legacy-thread" } },
        emptyCheckpoint(),
        { source: "loop", step: 0, parents: {} },
        {},
      );
      await saver.putWrites(config, [["ch", "task"]], "a", "~pull, 01");
      await saver.putWrites(config, [["ch", "legacy"]], "z");
      // An additive schema migration leaves existing taskPath values null.
      await UPDATE(DEFAULT_FQN_ENTITY_CHECKPOINT_WRITES)
        .set({ taskPath: null })
        .where({ taskId: "z" });

      const tuple =
        method === "getTuple"
          ? await saver.getTuple(config)
          : (await saver.list(config).next()).value;
      expect(tuple?.pendingWrites?.map((write) => write[2])).toEqual([
        "legacy",
        "task",
      ]);
    },
  );
});
