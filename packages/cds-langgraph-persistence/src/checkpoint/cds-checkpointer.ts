import {
  Checkpoint as TCheckpoint,
  CheckpointWrite as TCheckpointWrite,
} from "#cds-models/index";
import { type RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
  compareWritesSortKeys,
  copyCheckpoint,
  maxChannelVersion,
  PendingWrite,
  SerializerProtocol,
  TASKS,
  WRITES_IDX_MAP,
  writesSortKey,
} from "@langchain/langgraph-checkpoint";
import { readParentsWithChildren } from "@mi8y/cap-agents-utils";
import cds from "@sap/cds";

export const DEFAULT_FQN_ENTITY_CHECKPOINTS =
  "plugin.langgraph.persistence.Checkpoints";
export const DEFAULT_FQN_ENTITY_CHECKPOINT_WRITES =
  "plugin.langgraph.persistence.CheckpointWrites";

// Maps Checkpoints -> their related CheckpointWrites rows (mirrors the
// association declared in lib/add.js), enabling parents+children reads in
// just two DB calls via `readParentsWithChildren`.
const CHECKPOINT_WRITES_MATCH = [
  { parent: "graphName", child: "checkpoint_graphName" },
  { parent: "namespace", child: "checkpoint_namespace" },
  { parent: "threadId", child: "checkpoint_threadId" },
  { parent: "id", child: "checkpoint_id" },
];

/**
 * Configuration for {@link CdsCheckpointSaver}.
 *
 * Every instance must be scoped to a unique `name` so that checkpoints and
 * pending writes belonging to different graphs/agents never collide when they
 * are stored in the same database.
 */
export type CdsCheckpointSaverConfig = {
  /**
   * A **required** identifier matching the graph/agent this saver belongs to.
   *
   * It is persisted as the `graphName` column and used as a composite key in
   * the `Checkpoints` and `CheckpointWrites` entities, isolating state per
   * graph. Use a stable, human-readable value such as `"my-agent"`.
   */
  name: string;

  /**
   * Time-to-live for checkpoints in milliseconds.
   *
   * When set, each checkpoint stored by this saver will receive an `expiresAt`
   * timestamp (`createdAt + ttl`). A background sweeper (registered via
   * `cds.spawn()` in the CDS plugin) periodically deletes threads whose
   * latest checkpoint has expired, provided the thread is not in an
   * interrupted (human-in-the-loop) state.
   *
   * @example
   * ```ts
   * // Checkpoints expire after 1 hour of inactivity
   * const saver = new CdsCheckpointSaver({ name: "my-agent", ttl: 3_600_000 });
   * ```
   */
  ttl?: number;
  /**
   * The fully qualified name of the entity to use for storing checkpoints.
   *
   * @default "plugin.langgraph.persistence.Checkpoints"
   */
  fqnCheckpointsEntity?: string;
  /**
   * The fully qualified name of the entity to use for storing pending writes.
   *
   * @default "plugin.langgraph.persistence.CheckpointWrites"
   */
  fqnCheckpointWritesEntity?: string;
};

/**
 * A LangGraph {@link BaseCheckpointSaver} backed by the SAP CAP data layer.
 *
 * Instances persist graph state (checkpoints and pending writes) through CAP
 * CDS queries (`SELECT`, `UPSERT`, `DELETE`), which CDS routes to the correct
 * database and tenant based on the active request context. This gives agents
 * durable, multi-tenant checkpointing on any database CAP supports (SQLite,
 * SAP HANA, PostgreSQL, …) without additional infrastructure.
 *
 * A saver is scoped to a single graph via the mandatory {@link CdsCheckpointSaverConfig.name},
 * preventing collisions when multiple graphs share the same database.
 *
 * @example
 * ```ts
 * const saver = new CdsCheckpointSaver({ name: "my-agent" });
 * const graph = new StateGraph(State).compile({ checkpointer: saver });
 * ```
 */
export class CdsCheckpointSaver extends BaseCheckpointSaver {
  // The graph name is used to scope the checkpoints and writes to a specific graph instance.
  #graphName: string;
  #config: CdsCheckpointSaverConfig;
  #fqnCheckpointsEntity: string;
  #fqnCheckpointWritesEntity: string;

  constructor(config: CdsCheckpointSaverConfig, serde?: SerializerProtocol) {
    super(serde);
    this.#config = config;
    this.#graphName = config.name;
    this.#fqnCheckpointsEntity =
      config.fqnCheckpointsEntity ?? DEFAULT_FQN_ENTITY_CHECKPOINTS;
    this.#fqnCheckpointWritesEntity =
      config.fqnCheckpointWritesEntity ?? DEFAULT_FQN_ENTITY_CHECKPOINT_WRITES;
  }

  /**
   * Runs the function in an independent transaction, so cds outboxed consumption won't rollback the checkpointers
   */
  async #execWithTx<T = never>(fn: () => Promise<T>): Promise<T> {
    if (cds.requires.db.kind === "sqlite") {
      // SQLite does not support parallel transactions, so we just run the function directly.
      return fn();
    }
    return cds.tx(async () => fn());
  }

  /**
   * Deserializes raw {@link TCheckpointWrite} rows into LangGraph pending writes.
   */
  async #deserializePendingWrites(
    writes: TCheckpointWrite[],
  ): Promise<CheckpointPendingWrite[]> {
    return Promise.all(
      writes
        .map((write) => ({
          write,
          key: writesSortKey(write.taskPath ?? "", write.taskId, write.idx),
        }))
        .sort((a, b) => compareWritesSortKeys(a.key, b.key))
        .map(async ({ write: w }) => {
          return [
            w.taskId,
            w.channel,
            await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
          ] as CheckpointPendingWrite;
        }),
    );
  }

  /**
   * Rehydrates channel values and versions omitted from a sparse checkpoint.
   *
   * `put()` persists only channels present in `newVersions`; this method walks
   * the checkpoint's parent chain and fills missing entries from ancestors.
   * Values and versions stored on the requested checkpoint always take
   * precedence. It stops safely when an ancestor is missing or a cycle is
   * detected, and returns a new checkpoint without mutating the deserialized
   * input.
   */
  async #reconstructCheckpoint(
    checkpoint: Checkpoint,
    parentId: string | null | undefined,
    threadId: string,
    namespace: string,
  ): Promise<Checkpoint> {
    if (!parentId) {
      return checkpoint;
    }

    const channelValues = { ...checkpoint.channel_values };
    const channelVersions = { ...checkpoint.channel_versions };
    const visited = new Set<string>([checkpoint.id]);
    let currentParentId: string | null | undefined = parentId;

    while (currentParentId && !visited.has(currentParentId)) {
      visited.add(currentParentId);

      const parentRows = (await SELECT.from(this.#fqnCheckpointsEntity)
        .where({
          graphName: this.#graphName,
          threadId,
          namespace,
          id: currentParentId,
        })
        .limit(1)) as TCheckpoint[];
      const parentRow = parentRows[0];

      if (!parentRow) {
        break;
      }

      const parentCheckpoint = (await this.serde.loadsTyped(
        parentRow.type ?? "json",
        parentRow.checkpoint ?? "",
      )) as Checkpoint;

      for (const [channel, value] of Object.entries(
        parentCheckpoint.channel_values,
      )) {
        if (!(channel in channelValues)) {
          channelValues[channel] = value;
        }
      }

      for (const [channel, version] of Object.entries(
        parentCheckpoint.channel_versions,
      )) {
        if (!(channel in channelVersions)) {
          channelVersions[channel] = version;
        }
      }

      currentParentId = parentRow.parent_id;
    }

    return {
      ...checkpoint,
      channel_values: channelValues,
      channel_versions: channelVersions,
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    if (!config.configurable) {
      throw new Error(`Empty "config.configurable" supplied`);
    }

    const checkpointId: string | undefined = config.configurable.checkpoint_id;
    const checkpointNamespace: string = config.configurable.checkpoint_ns ?? "";
    const threadId: string | undefined = config.configurable.thread_id;
    if (!threadId) {
      return undefined;
    }

    let query = SELECT.from(this.#fqnCheckpointsEntity).where({
      graphName: this.#graphName,
      threadId: threadId,
      namespace: checkpointNamespace,
      ...(checkpointId ? { id: checkpointId } : {}),
    });

    if (!checkpointId) {
      query = query.orderBy("id desc").limit(1);
    }

    const { result } = await readParentsWithChildren<
      TCheckpoint,
      TCheckpointWrite
    >({
      match: CHECKPOINT_WRITES_MATCH,
      readParents: async () => (await query) as TCheckpoint[],
      readChildren: async ({ where }) =>
        (await SELECT.from(this.#fqnCheckpointWritesEntity)
          .where(where)
          .orderBy("taskId", "idx")) as TCheckpointWrite[],
      relationProperty: "writes",
    });

    const resCheckpoint = result[0];
    if (!resCheckpoint) {
      return undefined;
    }

    const checkpoint = (await this.serde.loadsTyped(
      resCheckpoint.type ?? "json",
      resCheckpoint.checkpoint ?? "",
    )) as Checkpoint;

    const metadata = (await this.serde.loadsTyped(
      resCheckpoint.type ?? "json",
      resCheckpoint.metadata ?? "",
    )) as CheckpointMetadata;

    const pendingWrites = await this.#deserializePendingWrites(
      resCheckpoint.writes ?? [],
    );

    if (checkpoint.v < 4 && resCheckpoint.parent_id) {
      await this.migratePendingSends(
        checkpoint,
        resCheckpoint.threadId!,
        resCheckpoint.parent_id,
      );
    }

    const reconstructedCheckpoint = await this.#reconstructCheckpoint(
      checkpoint,
      resCheckpoint.parent_id,
      resCheckpoint.threadId!,
      resCheckpoint.namespace ?? "",
    );

    return {
      checkpoint: reconstructedCheckpoint,
      config: {
        configurable: {
          thread_id: resCheckpoint.threadId,
          checkpoint_ns: resCheckpoint.namespace,
          checkpoint_id: resCheckpoint.id,
        },
      },
      parentConfig: resCheckpoint.parent_id
        ? {
            configurable: {
              thread_id: resCheckpoint.threadId,
              checkpoint_ns: resCheckpoint.namespace,
              checkpoint_id: resCheckpoint.parent_id,
            },
          }
        : undefined,
      metadata: metadata,
      pendingWrites: pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};

    const threadId: string | undefined = config.configurable?.thread_id;
    const checkpointNamespace: string | undefined =
      config.configurable?.checkpoint_ns;

    let query = SELECT.from(this.#fqnCheckpointsEntity)
      .orderBy("id desc")
      .where({ graphName: this.#graphName });

    if (threadId !== undefined) {
      query = query.where({
        threadId: threadId,
      });
    }

    if (checkpointNamespace !== undefined && checkpointNamespace !== null) {
      query = query.where({
        namespace: checkpointNamespace,
      });
    }

    if (before?.configurable?.checkpoint_id !== undefined) {
      query = query.where({
        id: { "<": before.configurable.checkpoint_id },
      });
    }

    // CAP CDS does not support native JSON operations - so we filter them in memory after fetching the results
    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(([, value]) => value !== undefined),
    );
    const hasFilter = Object.keys(sanitizedFilter).length > 0;

    // apply filter if no limit is specified, otherwise we will filter in memory after fetching the results
    if (limit !== undefined && !hasFilter) {
      query = query.limit(limit);
    }

    const { result: checkpointStates } = await readParentsWithChildren<
      TCheckpoint,
      TCheckpointWrite
    >({
      match: CHECKPOINT_WRITES_MATCH,
      readParents: async () => (await query) as TCheckpoint[],
      readChildren: async ({ where }) =>
        (await SELECT.from(this.#fqnCheckpointWritesEntity)
          .where(where)
          .orderBy("taskId", "idx")) as TCheckpointWrite[],
      relationProperty: "writes",
    });

    let yielded = 0;
    // TODO: from minimum CDS 10 SQLite onwards, use `streaming` option
    // with CDS 9, the cursor is not released leading to errors
    for (const checkpointState of checkpointStates) {
      if (limit !== undefined && yielded >= limit) {
        break;
      }

      const deserializedMetadata = (await this.serde.loadsTyped(
        checkpointState.type ?? "json",
        checkpointState.metadata ?? "",
      )) as CheckpointMetadata & Record<string, unknown>;

      if (hasFilter) {
        // since not filtered in the query, we filter in memory
        const matchesFilter = Object.entries(sanitizedFilter).every(
          ([key, value]) => deserializedMetadata[key] === value,
        );
        if (!matchesFilter) {
          continue;
        }
      }

      const checkpoint = (await this.serde.loadsTyped(
        checkpointState.type ?? "json",
        checkpointState.checkpoint ?? "",
      )) as Checkpoint;

      const pendingWrites = await this.#deserializePendingWrites(
        checkpointState.writes ?? [],
      );

      if (checkpoint.v < 4 && checkpointState.parent_id) {
        await this.migratePendingSends(
          checkpoint,
          checkpointState.threadId!,
          checkpointState.parent_id,
        );
      }

      const reconstructedCheckpoint = await this.#reconstructCheckpoint(
        checkpoint,
        checkpointState.parent_id,
        checkpointState.threadId!,
        checkpointState.namespace ?? "",
      );

      yield {
        config: {
          configurable: {
            thread_id: checkpointState.threadId,
            checkpoint_ns: checkpointState.namespace,
            checkpoint_id: checkpointState.id,
          },
        },
        checkpoint: reconstructedCheckpoint,
        parentConfig: checkpointState.parent_id
          ? {
              configurable: {
                thread_id: checkpointState.threadId,
                checkpoint_ns: checkpointState.namespace,
                checkpoint_id: checkpointState.parent_id,
              },
            }
          : undefined,
        metadata: deserializedMetadata,
        pendingWrites: pendingWrites,
      };

      yielded++;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    if (!config.configurable) {
      throw new Error(`Empty "config.configurable" supplied`);
    }

    const checkpointNamespace: string = config.configurable.checkpoint_ns ?? "";
    const parentCheckpointId: string | undefined =
      config.configurable.checkpoint_id;
    const threadId: string | undefined = config.configurable.thread_id;
    if (!threadId) {
      throw new Error(
        `Missing "thread_id" field in passed in "config.configurable"`,
      );
    }

    const newChannelValues = Object.fromEntries(
      Object.entries(checkpoint.channel_values).filter(
        ([key]) => key in newVersions,
      ),
    );
    const newChannelVersions = Object.fromEntries(
      Object.entries(checkpoint.channel_versions).filter(
        ([key]) => key in newVersions,
      ),
    );

    const filteredCheckpoint = {
      ...checkpoint,
      channel_values: newChannelValues,
      channel_versions: newChannelVersions,
    };

    const preparedCheckpoint: Partial<Checkpoint> =
      copyCheckpoint(filteredCheckpoint);

    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ]);
    if (type1 !== type2) {
      throw new Error(
        "Failed to serialized checkpoint and metadata to the same type.",
      );
    }

    const expiresAt = this.#config.ttl
      ? new Date(Date.now() + this.#config.ttl).toISOString()
      : null;

    const valueDecoder = new TextDecoder("utf-8");
    await this.#execWithTx(async () =>
      UPSERT.into(this.#fqnCheckpointsEntity).entries({
        graphName: this.#graphName,
        id: checkpoint.id,
        namespace: checkpointNamespace,
        threadId: threadId,
        parent_id: parentCheckpointId ?? null,
        type: type1,
        checkpoint: valueDecoder.decode(serializedCheckpoint),
        metadata: valueDecoder.decode(serializedMetadata),
        expiresAt: expiresAt,
      }),
    );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = "",
  ): Promise<void> {
    if (!config.configurable) {
      throw new Error(`Empty "config.configurable" supplied`);
    }

    const checkpointNamespace: string = config.configurable.checkpoint_ns ?? "";
    const checkpointId: string | undefined = config.configurable.checkpoint_id;
    if (!checkpointId) {
      throw new Error(
        `Missing "checkpoint_id" field in passed in "config.configurable"`,
      );
    }
    const threadId: string | undefined = config.configurable.thread_id;
    if (!threadId) {
      throw new Error(
        `Missing "thread_id" field in passed in "config.configurable"`,
      );
    }

    const pendingWrites: TCheckpointWrite[] = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serializedValue] = await this.serde.dumpsTyped(write[1]);
        const valueDecoder = new TextDecoder("utf-8");
        return {
          threadId: threadId,
          checkpoint_graphName: this.#graphName,
          checkpoint_id: checkpointId,
          checkpoint_namespace: checkpointNamespace,
          checkpoint_threadId: threadId,
          taskId: taskId,
          taskPath,
          // Special channels are stored at fixed negative indices so they
          // never collide with regular per-step writes (whose `idx` is the
          // ordinal within `writes`).
          idx: WRITES_IDX_MAP[write[0]] ?? idx,
          channel: write[0],
          type: type,
          value: valueDecoder.decode(serializedValue),
        };
      }),
    );

    await this.#execWithTx(async () =>
      UPSERT.into(this.#fqnCheckpointWritesEntity).entries(pendingWrites),
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.#execWithTx(async () => {
      await DELETE.from(this.#fqnCheckpointWritesEntity).where({
        checkpoint_graphName: this.#graphName,
        checkpoint_threadId: threadId,
      });
      await DELETE.from(this.#fqnCheckpointsEntity).where({
        graphName: this.#graphName,
        threadId: threadId,
      });
    });
  }

  protected async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentId: string,
  ) {
    const parentWrites = (await SELECT.from(this.#fqnCheckpointWritesEntity)
      .where({
        checkpoint_graphName: this.#graphName,
        checkpoint_threadId: threadId,
        checkpoint_id: parentId,
        channel: TASKS,
      })
      .orderBy("taskId", "idx")) as TCheckpointWrite[];

    if (parentWrites === undefined || parentWrites.length === 0) {
      return;
    }

    checkpoint.channel_values[TASKS] = await Promise.all(
      parentWrites.map((w: TCheckpointWrite) =>
        this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
      ),
    );
    checkpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}
