import { describe, expect, test } from "vitest";
import { mapMetadataFromGrounding, mapMetadataToGrounding } from "@/utils";

describe("Grounding metadata mapping", () => {
  test("serializes supported LangChain metadata values", () => {
    expect(
      mapMetadataToGrounding({
        text: "cap",
        count: 42,
        active: true,
        tags: ["sap", 7],
        nested: { source: "docs" },
        empty: null,
        omitted: undefined,
      }),
    ).toEqual([
      { key: "text", value: ["cap"] },
      { key: "count", value: ["42"] },
      { key: "active", value: ["true"] },
      { key: "tags", value: ["sap", "7"] },
      { key: "nested", value: ['{"source":"docs"}'] },
      { key: "empty", value: ["null"] },
    ]);
  });

  test("maps single values to strings and multiple values to arrays", () => {
    expect(
      mapMetadataFromGrounding([
        { key: "source", value: ["guide.md"] },
        { key: "tags", value: ["sap", "cap"] },
        { key: "empty", value: [] },
      ]),
    ).toEqual({
      source: "guide.md",
      tags: ["sap", "cap"],
      empty: [],
    });
  });

  test("handles absent metadata", () => {
    expect(mapMetadataFromGrounding(undefined)).toEqual({});
  });
});
