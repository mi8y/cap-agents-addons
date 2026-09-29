import cds from "@sap/cds";
import type { HttpResponse } from "@sap-cloud-sdk/http-client";
import { describe, expect, test, vi } from "vitest";
import { SapCloudSdkCmisClient, type CmisHttpRequestExecutor } from "@/index";

const response = { status: 200, data: {}, headers: {} } as HttpResponse;

function executor() {
  return vi.fn<CmisHttpRequestExecutor>().mockResolvedValue(response);
}

describe("simple CMIS connection configuration", () => {
  test("resolves a repository ID function for each request", async () => {
    let repositoryId = "tenant-a";
    const execute = executor();
    const client = new SapCloudSdkCmisClient({
      destination: { destinationName: "SDM_API" },
      repositoryId: async () => repositoryId,
      requestExecutor: execute,
    });

    await client.getObject("/a.txt");
    repositoryId = "tenant-b";
    await client.getObject("/b.txt");

    expect(execute.mock.calls.map(([, request]) => request.url)).toEqual([
      "/browser/tenant-a/root/a.txt",
      "/browser/tenant-b/root/b.txt",
    ]);
    expect(execute.mock.calls.map(([destination]) => destination)).toEqual([
      { destinationName: "SDM_API" },
      { destinationName: "SDM_API" },
    ]);
  });

  test("uses the CAP repository setting when no ID is supplied", async () => {
    const requires = cds.env.requires;
    const previous = requires.sdm;
    const execute = executor();
    try {
      requires.sdm = { settings: { repositoryId: "configured-repo" } };
      const client = new SapCloudSdkCmisClient({
        destination: { destinationName: "SDM_API" },
        requestExecutor: execute,
      });
      await client.getRepositoryInfo();
      expect(execute.mock.calls[0][1].url).toBe("/browser/configured-repo");
    } finally {
      if (previous === undefined) delete requires.sdm;
      else requires.sdm = previous;
    }
  });

  test("requires a destination before sending a request", async () => {
    const execute = executor();
    const client = new SapCloudSdkCmisClient({
      repositoryId: "repo",
      requestExecutor: execute,
    });
    await expect(client.getObject("/a.txt")).rejects.toThrow(
      "Destination is not configured",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test("redacts transport errors that could contain credentials", async () => {
    const execute = executor().mockRejectedValue(
      new Error("secret-token-from-SDK"),
    );
    const client = new SapCloudSdkCmisClient({
      destination: { destinationName: "SDM_API" },
      repositoryId: "repo",
      requestExecutor: execute,
    });
    await expect(client.getObject("/a.txt")).rejects.toThrow(
      "SDM request failed",
    );
  });

  test("addresses repository info on the Browser Binding endpoint", async () => {
    const execute = executor();
    const client = new SapCloudSdkCmisClient({
      repositoryId: "my repo",
      destination: { url: "https://sdm.example" },
      requestExecutor: execute,
    });
    await client.getRepositoryInfo();
    expect(execute).toHaveBeenCalledWith(
      { url: "https://sdm.example" },
      {
        method: "GET",
        url: "/browser/my%20repo",
        params: { cmisselector: "repositoryInfo" },
      },
    );
  });
});
