import cds from "@sap/cds";
import type { BackendProtocolV2 } from "deepagents";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SdmBackend } from "@/index";
import { CmisPropertyName, type CmisObject } from "@/types";

function object(
  name: string,
  options: {
    folder?: boolean;
    mimeType?: string;
    size?: number;
    objectId?: string;
    changeToken?: string;
    checkedOut?: boolean;
    workingCopyId?: string;
    privateWorkingCopy?: boolean;
  } = {},
): CmisObject {
  return {
    succinctProperties: {
      [CmisPropertyName.NAME]: name,
      [CmisPropertyName.BASE_TYPE_ID]: options.folder
        ? "cmis:folder"
        : "cmis:document",
      [CmisPropertyName.OBJECT_ID]: options.objectId ?? `id-${name}`,
      [CmisPropertyName.CHANGE_TOKEN]: options.changeToken ?? "change-1",
      [CmisPropertyName.IS_VERSION_SERIES_CHECKED_OUT]: options.checkedOut,
      [CmisPropertyName.VERSION_SERIES_CHECKED_OUT_ID]: options.workingCopyId,
      [CmisPropertyName.IS_PRIVATE_WORKING_COPY]: options.privateWorkingCopy,
      [CmisPropertyName.CONTENT_STREAM_MIME_TYPE]:
        options.mimeType ?? "text/plain",
      [CmisPropertyName.CONTENT_STREAM_LENGTH]: options.size ?? 0,
      [CmisPropertyName.CREATION_DATE]: 1_700_000_000_000,
      [CmisPropertyName.LAST_MODIFICATION_DATE]: 1_700_000_001_000,
    },
  };
}

function response<T>(data: T, headers: Record<string, string> = {}) {
  return { data, status: 200, headers } as never;
}

function cmisError(
  status: number,
  exception: string,
  message = exception,
): Error {
  return Object.assign(new Error(message), {
    response: { status, data: { exception, message } },
  });
}

function createBackend(options: Record<string, unknown> = {}) {
  return new SdmBackend({
    destination: { destinationName: "CMIS" },
    repositoryId: "knowledge",
    requestExecutor: vi.fn(),
    ...options,
  });
}

describe("SdmBackend", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("returns a structured error without a request bearer JWT", async () => {
    const previous = cds.context;
    const executor = vi.fn();
    try {
      cds.context = undefined;
      const backend = new SdmBackend({
        repositoryId: "knowledge",
        requestExecutor: executor,
      });
      await expect(backend.ls("/")).resolves.toEqual({
        error:
          "A bearer JWT in the current CAP request is required for the SDM service binding",
      });
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cds.context = previous;
    }
  });

  test("implements the Deep Agents v2 backend protocol with one virtual root", () => {
    const backend: BackendProtocolV2 = createBackend({
      virtualRootPath: "//agents//",
    });
    expect(backend).toBeInstanceOf(SdmBackend);
    expect((backend as SdmBackend).virtualRootPath).toBe("/agents");
  });

  test("lists all child pages with virtual paths and directory suffixes", async () => {
    const backend = createBackend({ virtualRootPath: "/agents", pageSize: 1 });
    vi.spyOn(backend.client, "getChildren")
      .mockResolvedValueOnce(
        response({
          objects: [
            {
              object: object("docs", { folder: true }),
              pathSegment: "docs",
            },
          ],
          hasMoreItems: true,
        }),
      )
      .mockResolvedValueOnce(
        response({
          objects: [
            {
              object: object("readme.md", { size: 12 }),
              pathSegment: "readme.md",
            },
          ],
          hasMoreItems: false,
        }),
      );

    await expect(backend.ls("/workspace")).resolves.toEqual({
      files: [
        expect.objectContaining({ path: "/workspace/docs/", is_dir: true }),
        expect.objectContaining({
          path: "/workspace/readme.md",
          is_dir: false,
          size: 12,
        }),
      ],
    });
    expect(backend.client.getChildren).toHaveBeenNthCalledWith(
      1,
      "/agents/workspace",
      { maxItems: 1, skipCount: 0 },
    );
    expect(backend.client.getChildren).toHaveBeenNthCalledWith(
      2,
      "/agents/workspace",
      { maxItems: 1, skipCount: 1 },
    );
  });

  test("reads and paginates text content", async () => {
    const backend = createBackend();
    vi.spyOn(backend.client, "getObject").mockResolvedValue(
      response(object("notes.txt", { mimeType: "text/plain" })),
    );
    vi.spyOn(backend.client, "getContentStream").mockResolvedValue(
      response(new TextEncoder().encode("one\ntwo\nthree\n").buffer),
    );

    await expect(backend.read("/notes.txt", 1, 1)).resolves.toEqual({
      content: "two",
      mimeType: "text/plain",
      totalLines: 3,
      startLine: 2,
      endLine: 2,
      nextOffset: 2,
    });
    await expect(backend.readRaw("/notes.txt")).resolves.toEqual({
      data: {
        content: "one\ntwo\nthree\n",
        mimeType: "text/plain",
        created_at: "2023-11-14T22:13:20.000Z",
        modified_at: "2023-11-14T22:13:21.000Z",
      },
    });
  });

  test("reads and returns virtual paths under a non-root repository folder", async () => {
    const backend = createBackend({ virtualRootPath: "/private/agents" });
    const getObject = vi
      .spyOn(backend.client, "getObject")
      .mockResolvedValue(response(object("a.txt", { mimeType: "text/plain" })));
    const getContent = vi
      .spyOn(backend.client, "getContentStream")
      .mockResolvedValue(
        response(new TextEncoder().encode("hello\nworld").buffer),
      );

    await expect(backend.read("/docs/a.txt", 1, 1)).resolves.toMatchObject({
      content: "world",
      startLine: 2,
    });
    await expect(backend.readRaw("//docs//a.txt/")).resolves.toMatchObject({
      data: { content: "hello\nworld" },
    });
    expect(
      getObject.mock.calls.map(([repositoryPath]) => repositoryPath),
    ).toEqual(["/private/agents/docs/a.txt", "/private/agents/docs/a.txt"]);
    expect(
      getContent.mock.calls.map(([repositoryPath]) => repositoryPath),
    ).toEqual(["/private/agents/docs/a.txt", "/private/agents/docs/a.txt"]);
    const smallBackend = createBackend({
      virtualRootPath: "/private/agents",
      maxFileSize: 1,
    });
    vi.spyOn(smallBackend.client, "getObject").mockResolvedValue(
      response(object("a.txt", { size: 100 })),
    );
    const result = await smallBackend.readRaw("/docs/a.txt");
    expect(result.error).toContain("'/docs/a.txt'");
    expect(result.error).not.toContain("/private/agents");
  });

  test("returns binary content without line pagination", async () => {
    const backend = createBackend();
    const bytes = new Uint8Array([1, 2, 3]);
    vi.spyOn(backend.client, "getObject").mockResolvedValue(
      response(object("image.png", { mimeType: "image/png" })),
    );
    vi.spyOn(backend.client, "getContentStream").mockResolvedValue(
      response(bytes.buffer),
    );

    await expect(backend.read("/image.png", 20, 1)).resolves.toEqual({
      content: bytes,
      mimeType: "image/png",
    });
  });

  test("limits file reads and rejects paths before executing CMIS requests", async () => {
    const backend = createBackend({
      maxFileSize: 3,
      virtualRootPath: "/agents",
    });
    const getObject = vi
      .spyOn(backend.client, "getObject")
      .mockResolvedValue(response(object("big.txt", { size: 4 })));
    const getContent = vi.spyOn(backend.client, "getContentStream");
    await expect(backend.readRaw("/big.txt")).resolves.toEqual({
      error: expect.stringContaining("exceeds the maximum"),
    });
    expect(getContent).not.toHaveBeenCalled();
    await expect(backend.write("/../outside.txt", "bad")).resolves.toEqual({
      error: "path traversal is not allowed",
    });
    expect(getObject).toHaveBeenCalledTimes(1);
    getObject.mockResolvedValue(response(object("small.txt", { size: 0 })));
    getContent.mockResolvedValue(
      response(new TextEncoder().encode("longer").buffer),
    );
    await expect(backend.readRaw("/small.txt")).resolves.toEqual({
      error: expect.stringContaining("exceeds the maximum"),
    });
  });

  test("creates missing parent folders and a new document", async () => {
    const backend = createBackend();
    vi.spyOn(backend.client, "getObject")
      .mockRejectedValueOnce(cmisError(404, "objectNotFound"))
      .mockRejectedValueOnce(cmisError(404, "objectNotFound"));
    const createFolder = vi
      .spyOn(backend.client, "createFolder")
      .mockResolvedValue(response(object("docs", { folder: true })));
    const createDocument = vi
      .spyOn(backend.client, "createDocument")
      .mockResolvedValue(response(object("readme.md")));

    await expect(backend.write("/docs/readme.md", "# Hello")).resolves.toEqual({
      path: "/docs/readme.md",
      filesUpdate: null,
    });
    expect(createFolder).toHaveBeenCalledWith("/docs");
    expect(createDocument).toHaveBeenCalledWith(
      "/docs/readme.md",
      expect.any(Blob),
    );
  });

  test("writes only below an existing virtual root and returns virtual paths", async () => {
    const backend = createBackend({ virtualRootPath: "/private/agents" });
    const getObject = vi
      .spyOn(backend.client, "getObject")
      .mockImplementation(async (repositoryPath) => {
        if (repositoryPath === "/private/agents")
          return response(object("agents", { folder: true }));
        if (
          repositoryPath === "/private/agents/docs" ||
          repositoryPath === "/private/agents/docs/a.txt"
        ) {
          throw cmisError(404, "objectNotFound");
        }
        throw new Error(`unexpected path: ${repositoryPath}`);
      });
    const createFolder = vi
      .spyOn(backend.client, "createFolder")
      .mockResolvedValue(response(object("docs", { folder: true })));
    const createDocument = vi
      .spyOn(backend.client, "createDocument")
      .mockResolvedValue(response(object("a.txt")));

    await expect(backend.write("//docs//a.txt", "content")).resolves.toEqual({
      path: "/docs/a.txt",
      filesUpdate: null,
    });
    expect(
      getObject.mock.calls.map(([repositoryPath]) => repositoryPath),
    ).toEqual([
      "/private/agents",
      "/private/agents/docs",
      "/private/agents/docs/a.txt",
    ]);
    expect(createFolder).toHaveBeenCalledWith("/private/agents/docs");
    expect(createDocument).toHaveBeenCalledWith(
      "/private/agents/docs/a.txt",
      expect.any(Blob),
    );
  });

  test("requires a pre-existing virtual root and never creates its parents", async () => {
    const backend = createBackend({ virtualRootPath: "/private/agents" });
    const getObject = vi
      .spyOn(backend.client, "getObject")
      .mockRejectedValue(cmisError(404, "objectNotFound"));
    const createFolder = vi.spyOn(backend.client, "createFolder");
    await expect(backend.write("/docs/a.txt", "content")).resolves.toEqual({
      error: "virtual root folder does not exist",
    });
    expect(getObject).toHaveBeenCalledTimes(1);
    expect(getObject).toHaveBeenCalledWith("/private/agents");
    expect(createFolder).not.toHaveBeenCalled();
    await expect(backend.write("/", "content")).resolves.toEqual({
      error: "cannot write a document at the root path",
    });
    await expect(backend.edit("/", "a", "b")).resolves.toEqual({
      error: "cannot edit a document at the root path",
    });
    expect(getObject).toHaveBeenCalledTimes(1);
  });

  test("does not write through a virtual root that is a document", async () => {
    const backend = createBackend({ virtualRootPath: "/private/agents" });
    vi.spyOn(backend.client, "getObject").mockResolvedValue(
      response(object("agents")),
    );
    const createFolder = vi.spyOn(backend.client, "createFolder");
    await expect(backend.write("/docs/a.txt", "content")).resolves.toEqual({
      error: "virtual root is not a folder",
    });
    expect(createFolder).not.toHaveBeenCalled();
  });

  test("falls back to checkout and checkin for versioned documents", async () => {
    const backend = createBackend();
    const folder = object("docs", { folder: true });
    const document = object("readme.md", { changeToken: "old-token" });
    vi.spyOn(backend.client, "getObject")
      .mockResolvedValueOnce(response(folder))
      .mockResolvedValueOnce(response(document))
      .mockResolvedValueOnce(response(document));
    vi.spyOn(backend.client, "setContentStream").mockRejectedValue(
      cmisError(409, "updateConflict"),
    );
    vi.spyOn(backend.client, "checkOut").mockResolvedValue(
      response(object("readme.md", { objectId: "pwc-1" })),
    );
    const checkIn = vi
      .spyOn(backend.client, "checkIn")
      .mockResolvedValue(response(document));

    await expect(backend.write("/docs/readme.md", "updated")).resolves.toEqual({
      path: "/docs/readme.md",
      filesUpdate: null,
    });
    expect(backend.client.setContentStream).toHaveBeenCalledWith(
      "/docs/readme.md",
      expect.any(Blob),
      "old-token",
    );
    expect(checkIn).toHaveBeenCalledWith(
      "pwc-1",
      "readme.md",
      expect.any(Blob),
    );
  });

  test("checks in an existing working copy without checking out or cancelling it", async () => {
    const backend = createBackend();
    const document = object("readme.md");
    const getObject = vi
      .spyOn(backend.client, "getObject")
      .mockResolvedValueOnce(response(object("docs", { folder: true })))
      .mockResolvedValueOnce(response(document))
      .mockResolvedValueOnce(
        response(
          object("readme.md", {
            checkedOut: true,
            workingCopyId: "existing-pwc",
          }),
        ),
      );
    vi.spyOn(backend.client, "setContentStream").mockRejectedValue(
      cmisError(409, "updateConflict"),
    );
    const checkOut = vi.spyOn(backend.client, "checkOut");
    const checkIn = vi
      .spyOn(backend.client, "checkIn")
      .mockResolvedValue(response(document));
    const cancelCheckOut = vi.spyOn(backend.client, "cancelCheckOut");

    await expect(backend.write("/docs/readme.md", "updated")).resolves.toEqual({
      path: "/docs/readme.md",
      filesUpdate: null,
    });
    expect(getObject).toHaveBeenCalledTimes(3);
    expect(checkOut).not.toHaveBeenCalled();
    expect(checkIn).toHaveBeenCalledWith(
      "existing-pwc",
      "readme.md",
      expect.any(Blob),
    );
    expect(await checkIn.mock.calls[0][2].text()).toBe("updated");
    expect(cancelCheckOut).not.toHaveBeenCalled();
  });

  test("edits a private working copy and retains it on check-in failure", async () => {
    const backend = createBackend();
    const document = object("readme.md");
    vi.spyOn(backend.client, "getObject")
      .mockResolvedValueOnce(response(document))
      .mockResolvedValueOnce(response(document))
      .mockResolvedValueOnce(
        response(
          object("readme.md", {
            objectId: "existing-pwc",
            privateWorkingCopy: true,
          }),
        ),
      );
    vi.spyOn(backend.client, "getContentStream").mockResolvedValue(
      response(new TextEncoder().encode("old").buffer),
    );
    vi.spyOn(backend.client, "setContentStream").mockRejectedValue(
      cmisError(409, "updateConflict"),
    );
    const checkOut = vi.spyOn(backend.client, "checkOut");
    const checkIn = vi
      .spyOn(backend.client, "checkIn")
      .mockRejectedValue(cmisError(403, "permissionDenied"));
    const cancelCheckOut = vi.spyOn(backend.client, "cancelCheckOut");

    await expect(backend.edit("/readme.md", "old", "updated")).resolves.toEqual(
      {
        error: "SDM access denied (HTTP 403)",
      },
    );
    expect(checkOut).not.toHaveBeenCalled();
    expect(checkIn).toHaveBeenCalledWith(
      "existing-pwc",
      "readme.md",
      expect.any(Blob),
    );
    expect(cancelCheckOut).not.toHaveBeenCalled();
  });

  test("fails safely when a checked-out document has no visible working copy", async () => {
    const backend = createBackend();
    const document = object("readme.md");
    vi.spyOn(backend.client, "getObject")
      .mockResolvedValueOnce(response(object("docs", { folder: true })))
      .mockResolvedValueOnce(response(document))
      .mockResolvedValueOnce(
        response(object("readme.md", { checkedOut: true })),
      );
    vi.spyOn(backend.client, "setContentStream").mockRejectedValue(
      cmisError(409, "updateConflict"),
    );
    const checkOut = vi.spyOn(backend.client, "checkOut");
    const checkIn = vi.spyOn(backend.client, "checkIn");
    await expect(backend.write("/docs/readme.md", "updated")).resolves.toEqual({
      error: "CMIS checked-out document has no visible working copy ID",
    });
    expect(checkOut).not.toHaveBeenCalled();
    expect(checkIn).not.toHaveBeenCalled();
  });

  test("cancels only a checkout created by this update if check-in fails", async () => {
    const backend = createBackend();
    const document = object("readme.md");
    vi.spyOn(backend.client, "getObject")
      .mockResolvedValueOnce(response(object("docs", { folder: true })))
      .mockResolvedValueOnce(response(document))
      .mockResolvedValueOnce(response(document));
    vi.spyOn(backend.client, "setContentStream").mockRejectedValue(
      cmisError(409, "updateConflict"),
    );
    vi.spyOn(backend.client, "checkOut").mockResolvedValue(
      response(object("readme.md", { objectId: "new-pwc" })),
    );
    vi.spyOn(backend.client, "checkIn").mockRejectedValue(
      cmisError(403, "permissionDenied"),
    );
    const cancelCheckOut = vi
      .spyOn(backend.client, "cancelCheckOut")
      .mockResolvedValue(response(undefined));

    await expect(backend.write("/docs/readme.md", "updated")).resolves.toEqual({
      error: "SDM access denied (HTTP 403)",
    });
    expect(cancelCheckOut).toHaveBeenCalledWith("new-pwc");
  });

  test("edits text and validates occurrence rules", async () => {
    const backend = createBackend();
    vi.spyOn(backend.client, "getObject").mockResolvedValue(
      response(object("a.txt", { mimeType: "text/plain" })),
    );
    vi.spyOn(backend.client, "getContentStream").mockResolvedValue(
      response(new TextEncoder().encode("hello hello").buffer),
    );
    const setContent = vi
      .spyOn(backend.client, "setContentStream")
      .mockResolvedValue(response(object("a.txt")));

    await expect(backend.edit("/a.txt", "hello", "goodbye")).resolves.toEqual({
      error:
        "Multiple occurrences found in '/a.txt'. Use replaceAll=true to replace all.",
    });
    await expect(
      backend.edit("/a.txt", "hello", "goodbye", true),
    ).resolves.toEqual({
      path: "/a.txt",
      filesUpdate: null,
      occurrences: 2,
    });
    expect(setContent).toHaveBeenCalledTimes(1);
  });

  test("edits through the virtual root without applying the prefix twice", async () => {
    const backend = createBackend({ virtualRootPath: "/private/agents" });
    const getObject = vi
      .spyOn(backend.client, "getObject")
      .mockResolvedValue(response(object("a.txt")));
    const getContent = vi
      .spyOn(backend.client, "getContentStream")
      .mockResolvedValue(response(new TextEncoder().encode("hello").buffer));
    const setContent = vi
      .spyOn(backend.client, "setContentStream")
      .mockResolvedValue(response(object("a.txt")));

    await expect(
      backend.edit("/docs/a.txt", "hello", "updated"),
    ).resolves.toEqual({
      path: "/docs/a.txt",
      filesUpdate: null,
      occurrences: 1,
    });
    expect(
      getObject.mock.calls.map(([repositoryPath]) => repositoryPath),
    ).toEqual(["/private/agents/docs/a.txt", "/private/agents/docs/a.txt"]);
    expect(getContent).toHaveBeenCalledTimes(1);
    expect(getContent).toHaveBeenCalledWith("/private/agents/docs/a.txt");
    expect(setContent).toHaveBeenCalledWith(
      "/private/agents/docs/a.txt",
      expect.any(Blob),
      "change-1",
    );
  });

  test("uses descendants for glob and grep", async () => {
    const backend = createBackend();
    const root = object("RootFolder", { folder: true });
    const docs = object("docs", { folder: true });
    const text = object("a.txt", { mimeType: "text/plain", size: 12 });
    const binary = object("image.png", { mimeType: "image/png", size: 3 });
    vi.spyOn(backend.client, "getObject").mockImplementation(
      async (filePath) => {
        if (filePath === "/") return response(root);
        if (filePath === "/docs/a.txt") return response(text);
        if (filePath === "/docs/image.png") return response(binary);
        throw cmisError(404, "objectNotFound");
      },
    );
    vi.spyOn(backend.client, "getDescendants").mockResolvedValue(
      response([
        {
          object: { object: docs, pathSegment: "docs" },
          children: [
            { object: { object: text, pathSegment: "a.txt" } },
            { object: { object: binary, pathSegment: "image.png" } },
          ],
        },
      ]),
    );
    vi.spyOn(backend.client, "getContentStream").mockImplementation(
      async (filePath) =>
        filePath.endsWith("a.txt")
          ? response(new TextEncoder().encode("hello\nhello again").buffer)
          : response(new Uint8Array([1, 2, 3]).buffer),
    );

    const glob = await backend.glob("**/*.txt");
    expect(glob.files).toEqual([
      expect.objectContaining({ path: "/docs/a.txt", is_dir: false }),
    ]);
    await expect(backend.grep("hello", "/", "**/*.txt", 1)).resolves.toEqual({
      matches: [{ path: "/docs/a.txt", line: 1, text: "hello" }],
      truncated: true,
    });
  });

  test("matches dotfiles against paths relative to the search base", async () => {
    const backend = createBackend();
    vi.spyOn(backend.client, "getObject").mockImplementation(
      async (repositoryPath) =>
        response(
          object(repositoryPath === "/" ? "root" : ".hidden.md", {
            folder: repositoryPath === "/",
          }),
        ),
    );
    vi.spyOn(backend.client, "getDescendants").mockResolvedValue(
      response([
        { object: { object: object(".hidden.md"), pathSegment: ".hidden.md" } },
        {
          object: {
            object: object("docs", { folder: true }),
            pathSegment: "docs",
          },
          children: [
            {
              object: { object: object(".notes.md"), pathSegment: ".notes.md" },
            },
          ],
        },
      ]),
    );
    vi.spyOn(backend.client, "getContentStream").mockResolvedValue(
      response(new TextEncoder().encode("hello").buffer),
    );

    await expect(backend.glob("*.md")).resolves.toEqual({
      files: [expect.objectContaining({ path: "/.hidden.md" })],
      truncated: undefined,
    });
    await expect(backend.glob("**/*.md")).resolves.toEqual({
      files: [
        expect.objectContaining({ path: "/.hidden.md" }),
        expect.objectContaining({ path: "/docs/.notes.md" }),
      ],
      truncated: undefined,
    });
    await expect(backend.grep("hello", "/", "*.md")).resolves.toEqual({
      matches: [{ path: "/.hidden.md", line: 1, text: "hello" }],
      truncated: undefined,
    });
  });

  test("keeps root-relative paths in paginated traversal fallback", async () => {
    const backend = createBackend({ virtualRootPath: "/private/agents" });
    const getObject = vi
      .spyOn(backend.client, "getObject")
      .mockImplementation(async (repositoryPath) => {
        if (repositoryPath === "/private/agents")
          return response(object("agents", { folder: true }));
        if (repositoryPath === "/private/agents/docs/a.txt")
          return response(object("a.txt"));
        throw cmisError(404, "objectNotFound");
      });
    vi.spyOn(backend.client, "getDescendants").mockRejectedValue(
      cmisError(405, "notSupported"),
    );
    const getChildren = vi
      .spyOn(backend.client, "getChildren")
      .mockImplementation(async (repositoryPath) =>
        response({
          objects:
            repositoryPath === "/private/agents"
              ? [
                  {
                    object: object("docs", { folder: true }),
                    pathSegment: "docs",
                  },
                ]
              : [{ object: object("a.txt"), pathSegment: "a.txt" }],
          hasMoreItems: false,
        }),
      );
    vi.spyOn(backend.client, "getContentStream").mockResolvedValue(
      response(new TextEncoder().encode("hello").buffer),
    );

    await expect(backend.glob("**/*.txt")).resolves.toEqual({
      files: [expect.objectContaining({ path: "/docs/a.txt" })],
      truncated: undefined,
    });
    await expect(backend.grep("hello")).resolves.toEqual({
      matches: [{ path: "/docs/a.txt", line: 1, text: "hello" }],
      truncated: undefined,
    });
    expect(
      getChildren.mock.calls.map(([repositoryPath]) => repositoryPath),
    ).toEqual([
      "/private/agents",
      "/private/agents/docs",
      "/private/agents",
      "/private/agents/docs",
    ]);
    expect(
      getObject.mock.calls.every(([repositoryPath]) =>
        repositoryPath.startsWith("/private/agents"),
      ),
    ).toBe(true);
  });

  test("matches nested virtual bases and a file base", async () => {
    const backend = createBackend({ virtualRootPath: "/private/agents" });
    const getObject = vi
      .spyOn(backend.client, "getObject")
      .mockImplementation(async (repositoryPath) =>
        repositoryPath === "/private/agents/docs"
          ? response(object("docs", { folder: true }))
          : response(object("a.txt")),
      );
    const getDescendants = vi
      .spyOn(backend.client, "getDescendants")
      .mockResolvedValue(
        response([
          {
            object: {
              object: object("sub", { folder: true }),
              pathSegment: "sub",
            },
            children: [
              { object: { object: object("a.txt"), pathSegment: "a.txt" } },
            ],
          },
        ]),
      );
    vi.spyOn(backend.client, "getContentStream").mockResolvedValue(
      response(new TextEncoder().encode("hello").buffer),
    );

    await expect(backend.glob("**/*.{txt,md}", "/docs")).resolves.toEqual({
      files: [expect.objectContaining({ path: "/docs/sub/a.txt" })],
      truncated: undefined,
    });
    await expect(
      backend.grep("hello", "/docs", "**/*.{txt,md}"),
    ).resolves.toEqual({
      matches: [{ path: "/docs/sub/a.txt", line: 1, text: "hello" }],
      truncated: undefined,
    });
    await expect(backend.glob("*.txt", "/docs/sub/a.txt")).resolves.toEqual({
      files: [expect.objectContaining({ path: "/docs/sub/a.txt" })],
      truncated: undefined,
    });
    expect(getDescendants).toHaveBeenCalledTimes(2);
    expect(
      getObject.mock.calls.every(([repositoryPath]) =>
        repositoryPath.startsWith("/private/agents/docs"),
      ),
    ).toBe(true);
  });

  test("rejects unsafe CMIS child segments in listings and traversal", async () => {
    const backend = createBackend({ virtualRootPath: "/private/agents" });
    vi.spyOn(backend.client, "getChildren").mockResolvedValue(
      response({
        objects: [{ object: object("outside"), pathSegment: "../outside" }],
        hasMoreItems: false,
      }),
    );
    await expect(backend.ls("/")).resolves.toEqual({
      error: "CMIS returned an unsafe path segment",
    });
    vi.spyOn(backend.client, "getObject").mockResolvedValue(
      response(object("agents", { folder: true })),
    );
    vi.spyOn(backend.client, "getDescendants").mockResolvedValue(
      response([{ object: { object: object("outside"), pathSegment: "a/b" } }]),
    );
    await expect(backend.glob("**")).resolves.toEqual({
      error: "CMIS returned an unsafe path segment",
    });
  });

  test("marks traversal results as truncated at the configured limit", async () => {
    const backend = createBackend({ maxTraversalItems: 1 });
    vi.spyOn(backend.client, "getObject").mockResolvedValue(
      response(object("root", { folder: true })),
    );
    vi.spyOn(backend.client, "getDescendants").mockResolvedValue(
      response([
        { object: { object: object("a.txt"), pathSegment: "a.txt" } },
        { object: { object: object("b.txt"), pathSegment: "b.txt" } },
      ]),
    );

    await expect(backend.glob("**")).resolves.toEqual({
      files: [expect.objectContaining({ path: "/a.txt" })],
      truncated: true,
    });
  });

  test("returns structured errors for invalid paths and CMIS failures", async () => {
    const backend = createBackend();
    await expect(backend.read("relative.md")).resolves.toEqual({
      error: "file path must be absolute - 'relative.md'",
    });
    await expect(backend.edit("/../secret.txt", "a", "b")).resolves.toEqual({
      error: "path traversal is not allowed",
    });
    await expect(backend.glob("**", "/../secret")).resolves.toEqual({
      error: "path traversal is not allowed",
    });
    await expect(
      backend.grep("hello", "/../secret", "**/*.txt"),
    ).resolves.toEqual({
      error: "path traversal is not allowed",
    });
    vi.spyOn(backend.client, "getChildren").mockRejectedValue(
      cmisError(403, "permissionDenied", "Access denied"),
    );
    await expect(backend.ls("/")).resolves.toEqual({
      error: "SDM access denied (HTTP 403)",
    });
    vi.spyOn(backend.client, "getChildren").mockRejectedValue(
      cmisError(401, "unauthorized", "secret-bearing error"),
    );
    await expect(backend.ls("/")).resolves.toEqual({
      error: "SDM authentication required (HTTP 401)",
    });
  });
});
