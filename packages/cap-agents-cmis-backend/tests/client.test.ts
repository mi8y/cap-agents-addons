import type { HttpResponse } from "@sap-cloud-sdk/http-client";
import { describe, expect, test, vi } from "vitest";
import { SapCloudSdkCmisClient, type CmisHttpRequestExecutor } from "@/index";

function createClient() {
  const response = { data: {}, status: 200, headers: {} } as HttpResponse;
  const requestExecutor: CmisHttpRequestExecutor = vi
    .fn()
    .mockResolvedValue(response);
  const client = new SapCloudSdkCmisClient({
    destination: { destinationName: "CMIS" },
    repositoryId: "knowledge base",
    requestExecutor,
  });
  return { client, requestExecutor, response };
}

describe("SapCloudSdkCmisClient", () => {
  test("requires a repository ID", () => {
    expect(
      () =>
        new SapCloudSdkCmisClient({
          destination: { url: "https://cmis.example" },
          repositoryId: "",
        }),
    ).toThrow("'repositoryId' is required");
  });

  test("addresses objects below the Browser Binding root and encodes segments", async () => {
    const { client, requestExecutor, response } = createClient();

    await expect(client.getObject("/folder/a file.txt")).resolves.toBe(
      response,
    );

    expect(requestExecutor).toHaveBeenCalledWith(
      { destinationName: "CMIS" },
      {
        method: "GET",
        url: "/browser/knowledge%20base/root/folder/a%20file.txt",
        params: { cmisselector: "object", succinct: true },
      },
    );
  });

  test("requests paginated children and recursive descendants", async () => {
    const { client, requestExecutor } = createClient();

    await client.getChildren("/docs", { maxItems: 25, skipCount: 50 });
    await client.getDescendants("/docs", 3);

    expect(requestExecutor).toHaveBeenNthCalledWith(
      1,
      { destinationName: "CMIS" },
      expect.objectContaining({
        url: "/browser/knowledge%20base/root/docs",
        params: expect.objectContaining({
          cmisselector: "children",
          maxItems: 25,
          skipCount: 50,
        }),
      }),
    );
    expect(requestExecutor).toHaveBeenNthCalledWith(
      2,
      { destinationName: "CMIS" },
      expect.objectContaining({
        params: expect.objectContaining({
          cmisselector: "descendants",
          depth: 3,
        }),
      }),
    );
  });

  test("creates documents at the parent folder URL", async () => {
    const { client, requestExecutor } = createClient();

    await client.createDocument(
      "/docs/read me.txt",
      new Blob(["hello"], { type: "text/plain" }),
    );

    const config = vi.mocked(requestExecutor).mock.calls[0][1];
    expect(config.url).toBe("/browser/knowledge%20base/root/docs");
    expect(config.method).toBe("POST");
    const form = config.data as FormData;
    expect(form.get("cmisaction")).toBe("createDocument");
    expect(form.get("propertyValue[0]")).toBe("read me.txt");
    expect(form.get("propertyValue[1]")).toBe("cmis:document");
  });

  test("retrieves raw content and sets content with a change token", async () => {
    const { client, requestExecutor } = createClient();

    await client.getContentStream("/docs/a.txt");
    await client.setContentStream(
      "/docs/a.txt",
      new Blob(["updated"], { type: "text/plain" }),
      "token-1",
    );

    expect(vi.mocked(requestExecutor).mock.calls[0][1]).toEqual(
      expect.objectContaining({
        responseType: "arraybuffer",
        params: { cmisselector: "content", download: "inline" },
      }),
    );
    const form = vi.mocked(requestExecutor).mock.calls[1][1].data as FormData;
    expect(form.get("cmisaction")).toBe("setContent");
    expect(form.get("overwriteFlag")).toBe("true");
    expect(form.get("changeToken")).toBe("token-1");
  });

  test("checks in a private working copy by object ID", async () => {
    const { client, requestExecutor } = createClient();

    await client.checkIn(
      "pwc-42",
      "a.txt",
      new Blob(["content"], { type: "text/plain" }),
    );

    const config = vi.mocked(requestExecutor).mock.calls[0][1];
    expect(config.url).toBe("/browser/knowledge%20base/root");
    expect(config.params).toEqual({ objectId: "pwc-42" });
    const form = config.data as FormData;
    expect(form.get("cmisaction")).toBe("checkIn");
    expect(form.get("major")).toBe("true");
  });

  test("posts queries to the repository URL", async () => {
    const { client, requestExecutor } = createClient();

    await client.query("SELECT * FROM cmis:document", {
      maxItems: 10,
      skipCount: 2,
    });

    const config = vi.mocked(requestExecutor).mock.calls[0][1];
    expect(config.url).toBe("/browser/knowledge%20base");
    const form = config.data as FormData;
    expect(form.get("statement")).toBe("SELECT * FROM cmis:document");
    expect(form.get("maxItems")).toBe("10");
    expect(form.get("skipCount")).toBe("2");
  });

  test("supports a custom Browser Binding path", async () => {
    const requestExecutor: CmisHttpRequestExecutor = vi
      .fn()
      .mockResolvedValue({ data: {}, status: 200 } as HttpResponse);
    const client = new SapCloudSdkCmisClient({
      destination: { url: "https://cmis.example" },
      repositoryId: "repository",
      browserBindingPath: "custom/browser/",
      requestExecutor,
    });

    await client.getObject("/");

    expect(requestExecutor).toHaveBeenCalledWith(
      { url: "https://cmis.example" },
      expect.objectContaining({ url: "/custom/browser/repository/root" }),
    );
  });
});
