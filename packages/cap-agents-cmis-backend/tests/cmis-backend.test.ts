import type { BackendProtocolV2 } from "deepagents";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CmisBackend, CmisPropertyName, type CmisObject } from "@/index";

function object(
  name: string,
  options: {
    folder?: boolean;
    mimeType?: string;
    size?: number;
    objectId?: string;
    changeToken?: string;
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
  return new CmisBackend({
    destination: { destinationName: "CMIS" },
    repositoryId: "knowledge",
    requestExecutor: vi.fn(),
    ...options,
  });
}

describe("CmisBackend", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("implements the Deep Agents v2 backend protocol and rootPath alias", () => {
    const backend: BackendProtocolV2 = createBackend({ rootPath: "/agents" });
    expect(backend).toBeInstanceOf(CmisBackend);
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

  test("falls back to checkout and checkin for versioned documents", async () => {
    const backend = createBackend();
    const folder = object("docs", { folder: true });
    const document = object("readme.md", { changeToken: "old-token" });
    vi.spyOn(backend.client, "getObject")
      .mockResolvedValueOnce(response(folder))
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
    vi.spyOn(backend.client, "getChildren").mockRejectedValue(
      cmisError(403, "permissionDenied", "Access denied"),
    );
    await expect(backend.ls("/")).resolves.toEqual({
      error: "Access denied",
    });
  });
});
