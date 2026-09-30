import {
  jwtBearerToken,
  serviceToken,
  type Service,
} from "@sap-cloud-sdk/connectivity";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { transformServiceBindingToJwtBearerAssertionDestination } from "@/utils";

vi.mock("@sap-cloud-sdk/connectivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sap-cloud-sdk/connectivity")>()),
  jwtBearerToken: vi.fn(),
  serviceToken: vi.fn(),
}));

const uaa = {
  url: "https://auth.example",
  clientid: "test-client",
  clientsecret: "test-secret",
};
const binding = {
  name: "SDM-instance",
  label: "sdm",
  tags: [],
  credentials: {
    uri: "https://sdm.example/api/",
    uaa,
  },
} as unknown as Service;

beforeEach(() => {
  vi.mocked(jwtBearerToken).mockReset();
  vi.mocked(serviceToken).mockReset();
});

describe("transformServiceBindingToJwtBearerAssertionDestination", () => {
  test("exchanges the user JWT with nested SDM UAA credentials and targets the SDM API", async () => {
    vi.mocked(jwtBearerToken).mockResolvedValue("exchanged-token");

    const destination =
      await transformServiceBindingToJwtBearerAssertionDestination(
        binding,
        "current-user-jwt",
      );

    expect(jwtBearerToken).toHaveBeenCalledExactlyOnceWith("current-user-jwt", {
      ...binding,
      credentials: uaa,
    });
    expect(binding.credentials).toEqual({
      uri: "https://sdm.example/api/",
      uaa,
    });
    expect(destination).toEqual({
      url: "https://sdm.example/api/",
      authentication: "OAuth2JWTBearer",
      authTokens: [
        {
          type: "bearer",
          value: "exchanged-token",
          http_header: {
            key: "Authorization",
            value: "Bearer exchanged-token",
          },
          error: null,
        },
      ],
    });
    expect(serviceToken).not.toHaveBeenCalled();
  });

  test("keeps consecutive user assertions and their destinations separate", async () => {
    vi.mocked(jwtBearerToken)
      .mockResolvedValueOnce("token-for-a")
      .mockResolvedValueOnce("token-for-b");

    const first = await transformServiceBindingToJwtBearerAssertionDestination(
      binding,
      "user-a",
    );
    const second = await transformServiceBindingToJwtBearerAssertionDestination(
      binding,
      "user-b",
    );

    expect(jwtBearerToken).toHaveBeenNthCalledWith(
      1,
      "user-a",
      expect.objectContaining({ credentials: uaa }),
    );
    expect(jwtBearerToken).toHaveBeenNthCalledWith(
      2,
      "user-b",
      expect.objectContaining({ credentials: uaa }),
    );
    expect(first.authTokens?.[0].http_header.value).toBe("Bearer token-for-a");
    expect(second.authTokens?.[0].http_header.value).toBe("Bearer token-for-b");
    expect(first).not.toBe(second);
  });

  test("propagates token exchange failures without using client credentials", async () => {
    const failure = new Error("token exchange failed");
    vi.mocked(jwtBearerToken).mockRejectedValue(failure);

    await expect(
      transformServiceBindingToJwtBearerAssertionDestination(
        binding,
        "current-user-jwt",
      ),
    ).rejects.toBe(failure);
    expect(serviceToken).not.toHaveBeenCalled();
  });
});
