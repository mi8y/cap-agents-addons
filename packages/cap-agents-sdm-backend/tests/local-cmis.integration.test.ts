import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { SdmBackend } from "@/index";

// Configure a Cloud SDK destination with base URL http://localhost:8001 and
// authentication outside this package. Never pass a credential to this test.
const destinationName = process.env.CMIS_LIVE_DESTINATION;
const repositoryId = process.env.CMIS_LIVE_REPOSITORY_ID;

describe.runIf(Boolean(destinationName && repositoryId))(
  "live SDM Browser Binding",
  () => {
    test("validates and exercises all operations under a virtual root", async () => {
      const root = `/sdm-backend-test-${randomUUID()}`;
      const backend = new SdmBackend({
        repositoryId: repositoryId!,
        destination: { destinationName: destinationName! },
        virtualRootPath: root,
      });
      const document = "/nested/readme.txt";
      // The low-level client takes repository paths; agent-facing paths are virtual.
      await backend.client.createFolder(root);
      try {
        expect(
          (await backend.write(document, "hello\nworld")).error,
        ).toBeUndefined();
        expect((await backend.read(document)).content).toBe("hello\nworld");
        expect(
          (await backend.ls("/nested")).files?.map((file) => file.path),
        ).toContain(document);
        expect(
          (await backend.glob("**/*.txt")).files?.map((file) => file.path),
        ).toContain(document);
        expect((await backend.grep("world")).matches?.[0]?.path).toBe(document);
        expect(
          (await backend.edit(document, "hello", "updated")).error,
        ).toBeUndefined();
        expect((await backend.read(document)).content).toBe("updated\nworld");
      } finally {
        await backend.client.deleteTree(root);
      }
      await expect(backend.client.getObject(root)).rejects.toMatchObject({
        response: { status: 404 },
      });
    }, 30_000);
  },
);
