import { describe, expect, test } from "vitest";
import {
  cmisDateToIso,
  globToRegExp,
  normalizeVirtualPath,
  resolveCmisPath,
} from "@/index";

describe("CMIS backend paths", () => {
  test("normalizes repeated and trailing separators", () => {
    expect(normalizeVirtualPath("//skills//writer/")).toBe("/skills/writer");
    expect(normalizeVirtualPath("/")).toBe("/");
  });

  test.each(["relative/path", "/../secret", "/a/./b", "/a\\b", "/a\0b"])(
    "rejects unsafe path %s",
    (filePath) => {
      expect(() => normalizeVirtualPath(filePath)).toThrow();
    },
  );

  test("resolves virtual paths below the configured root", () => {
    expect(resolveCmisPath("/agent-content", "/skills/writer.md")).toBe(
      "/agent-content/skills/writer.md",
    );
    expect(resolveCmisPath("/agent-content", "/")).toBe("/agent-content");
    expect(resolveCmisPath("/", "/knowledge.md")).toBe("/knowledge.md");
  });

  test("converts CMIS epoch timestamps to ISO strings", () => {
    expect(cmisDateToIso(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
  });

  test.each([
    ["*.ts", "index.ts", true],
    ["*.ts", "src/index.ts", false],
    ["**/*.ts", "src/index.ts", true],
    ["**/*.ts", "index.ts", true],
    ["file?.[jt]s", "file1.ts", true],
  ])("matches glob %s against %s", (pattern, value, expected) => {
    expect(globToRegExp(pattern).test(value)).toBe(expected);
  });
});
