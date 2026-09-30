import { describe, expect, test } from "vitest";
import {
  epochTimeToISO as cmisDateToIso,
  normalizeAbsolutePath,
  resolvePaths as resolveBackendPaths,
  joinPath,
  relativeVirtualPath,
} from "@/utils";

describe("CMIS backend paths", () => {
  test("normalizes repeated and trailing separators", () => {
    expect(normalizeAbsolutePath("//skills//writer/")).toBe("/skills/writer");
    expect(normalizeAbsolutePath("/")).toBe("/");
  });

  test.each(["relative/path", "/../secret", "/a/./b", "/a\\b", "/a\0b"])(
    "rejects unsafe path %s",
    (filePath) => {
      expect(() => normalizeAbsolutePath(filePath)).toThrow();
    },
  );

  test("returns virtual and repository paths under the configured root", () => {
    expect(resolveBackendPaths("/agent-content", "/skills/writer.md")).toEqual({
      virtualPath: "/skills/writer.md",
      repositoryPath: "/agent-content/skills/writer.md",
    });
    expect(resolveBackendPaths("/agent-content", "/")).toEqual({
      virtualPath: "/",
      repositoryPath: "/agent-content",
    });
    expect(resolveBackendPaths("/", "/knowledge.md")).toEqual({
      virtualPath: "/knowledge.md",
      repositoryPath: "/knowledge.md",
    });
    expect(resolveBackendPaths("//agent-content//", "//docs//a.txt/")).toEqual({
      virtualPath: "/docs/a.txt",
      repositoryPath: "/agent-content/docs/a.txt",
    });
    expect(
      resolveBackendPaths("/agent-content", "/agent-content/a.txt")
        .repositoryPath,
    ).toBe("/agent-content/agent-content/a.txt");
  });

  test("rejects traversal in the root or requested path", () => {
    expect(() => resolveBackendPaths("/root/../other", "/a.txt")).toThrow(
      "path traversal",
    );
    expect(() => resolveBackendPaths("/root", "/../other")).toThrow(
      "path traversal",
    );
  });

  test("appends one safe CMIS segment to a virtual folder", () => {
    expect(joinPath("/", "a.txt")).toBe("/a.txt");
    expect(joinPath("/docs/", "a.txt")).toBe("/docs/a.txt");
    expect(joinPath("/docs", "a%2Fb.txt")).toBe("/docs/a%2Fb.txt");
    expect(() => joinPath("/docs/../outside", "a.txt")).toThrow(
      "path traversal",
    );
  });

  test.each(["", ".", "..", "a/b", "/absolute", "a\\b", "a\0b"])(
    "rejects unsafe CMIS segment %s",
    (segment) => {
      expect(() => joinPath("/docs", segment)).toThrow("unsafe path segment");
    },
  );

  test("matches virtual paths relative to a folder or the file itself", () => {
    expect(relativeVirtualPath("/", "/docs/a.txt")).toBe("docs/a.txt");
    expect(relativeVirtualPath("/docs", "/docs/nested/a.txt")).toBe(
      "nested/a.txt",
    );
    expect(relativeVirtualPath("/docs", "/docs/nested/")).toBe("nested");
    expect(relativeVirtualPath("/docs/a.txt", "/docs/a.txt")).toBe("a.txt");
    expect(() => relativeVirtualPath("/docs", "/docs/../outside")).toThrow(
      "path traversal",
    );
  });

  test("converts CMIS epoch timestamps to ISO strings", () => {
    expect(cmisDateToIso(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
  });
});
