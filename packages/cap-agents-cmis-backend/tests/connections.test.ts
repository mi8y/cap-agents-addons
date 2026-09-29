import cds from "@sap/cds";
import {
  getDestinationFromServiceBinding,
  getServiceBinding,
  jwtBearerToken,
  type Service,
} from "@sap-cloud-sdk/connectivity";
import type { HttpResponse } from "@sap-cloud-sdk/http-client";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SapCloudSdkCmisClient, type CmisHttpRequestExecutor } from "@/index";

vi.mock("@sap-cloud-sdk/connectivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sap-cloud-sdk/connectivity")>()),
  getServiceBinding: vi.fn(),
  getDestinationFromServiceBinding: vi.fn(),
  jwtBearerToken: vi.fn(),
}));

const response = { status: 200, data: {}, headers: {} } as HttpResponse;
const binding = {
  name: "SDM-instance",
  label: "sdm",
  tags: [],
  credentials: {
    uri: "https://sdm.example/api/",
    uaa: {
      url: "https://auth.example",
      clientid: "sdk-client",
      clientsecret: "test-secret",
    },
  },
} as unknown as Service;

async function withBearer(jwt: string, work: () => Promise<void>) {
  const previous = cds.context;
  cds.context = {
    http: { req: { headers: { authorization: `Bearer ${jwt}` } } },
  } as unknown as NonNullable<typeof cds.context>;
  try {
    await work();
  } finally {
    cds.context = previous;
  }
}

beforeEach(() => {
  vi.mocked(getServiceBinding).mockReset();
  vi.mocked(getDestinationFromServiceBinding).mockReset();
  vi.mocked(jwtBearerToken).mockReset();
});

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

  test("requires a CAP bearer JWT before reading the SDM binding", async () => {
    const execute = executor();
    const client = new SapCloudSdkCmisClient({
      repositoryId: "repo",
      requestExecutor: execute,
    });
    await expect(client.getObject("/a.txt")).rejects.toThrow(
      "bearer JWT in the current CAP request is required",
    );
    expect(getServiceBinding).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("exchanges each CAP user's JWT for a fresh SDM destination", async () => {
    const execute = executor();
    const client = new SapCloudSdkCmisClient({
      repositoryId: "repo",
      requestExecutor: execute,
    });
    vi.mocked(getServiceBinding).mockReturnValue(binding);
    vi.mocked(jwtBearerToken)
      .mockResolvedValueOnce("sdm-token-a")
      .mockResolvedValueOnce("sdm-token-b");
    vi.mocked(getDestinationFromServiceBinding).mockImplementation(
      async ({ service, serviceBindingTransformFn }) => {
        expect(service).toBe(binding);
        return {
          name: binding.name,
          ...(await serviceBindingTransformFn!(binding)),
        };
      },
    );

    await withBearer("user-a", async () => {
      await client.getObject("/a.txt");
    });
    await withBearer("user-b", async () => {
      await client.getObject("/b.txt");
    });

    expect(getServiceBinding).toHaveBeenCalledTimes(2);
    expect(getServiceBinding).toHaveBeenCalledWith("sdm");
    expect(getDestinationFromServiceBinding).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ service: binding, jwt: "user-a" }),
    );
    expect(getDestinationFromServiceBinding).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ service: binding, jwt: "user-b" }),
    );
    expect(jwtBearerToken).toHaveBeenNthCalledWith(
      1,
      "user-a",
      expect.objectContaining({ credentials: binding.credentials.uaa }),
    );
    expect(jwtBearerToken).toHaveBeenNthCalledWith(
      2,
      "user-b",
      expect.objectContaining({ credentials: binding.credentials.uaa }),
    );
    expect(execute.mock.calls.map(([destination]) => destination)).toEqual([
      {
        name: "SDM-instance",
        url: "https://sdm.example/api/",
        authentication: "OAuth2JWTBearer",
        authTokens: [
          {
            type: "bearer",
            value: "sdm-token-a",
            http_header: { key: "Authorization", value: "Bearer sdm-token-a" },
            error: null,
          },
        ],
      },
      {
        name: "SDM-instance",
        url: "https://sdm.example/api/",
        authentication: "OAuth2JWTBearer",
        authTokens: [
          {
            type: "bearer",
            value: "sdm-token-b",
            http_header: { key: "Authorization", value: "Bearer sdm-token-b" },
            error: null,
          },
        ],
      },
    ]);
  });

  test("redacts missing, incomplete, or unreadable SDM bindings", async () => {
    const execute = executor();
    const client = new SapCloudSdkCmisClient({
      repositoryId: "repo",
      requestExecutor: execute,
    });
    vi.mocked(jwtBearerToken).mockResolvedValue("sdm-token");
    vi.mocked(getDestinationFromServiceBinding).mockImplementation(
      async ({ service, serviceBindingTransformFn }) =>
        serviceBindingTransformFn!(service!),
    );
    await withBearer("user-jwt", async () => {
      await expect(client.getObject("/a.txt")).rejects.toThrow(
        "SDM JWT bearer destination resolution failed",
      );
      vi.mocked(getServiceBinding).mockReturnValue({
        ...binding,
        credentials: { ...binding.credentials, uri: "" },
      });
      await expect(client.getObject("/a.txt")).rejects.toThrow(
        "SDM JWT bearer destination resolution failed",
      );
      vi.mocked(getServiceBinding).mockImplementationOnce(() => {
        throw new Error("secret-from-binding-parser");
      });
      await expect(client.getObject("/a.txt")).rejects.toThrow(
        "SDM JWT bearer destination resolution failed",
      );
    });
    expect(getDestinationFromServiceBinding).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  test("redacts SDK token exchange failures", async () => {
    const execute = executor();
    const client = new SapCloudSdkCmisClient({
      repositoryId: "repo",
      requestExecutor: execute,
    });
    vi.mocked(getServiceBinding).mockReturnValue(binding);
    vi.mocked(jwtBearerToken).mockRejectedValue(
      new Error("secret-token-detail"),
    );
    vi.mocked(getDestinationFromServiceBinding).mockImplementation(
      async ({ service, serviceBindingTransformFn }) =>
        serviceBindingTransformFn!(service!),
    );
    await withBearer("user-jwt", async () => {
      await expect(client.getObject("/a.txt")).rejects.toThrow(
        "SDM JWT bearer destination resolution failed",
      );
    });
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
    expect(getServiceBinding).not.toHaveBeenCalled();
    expect(getDestinationFromServiceBinding).not.toHaveBeenCalled();
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
