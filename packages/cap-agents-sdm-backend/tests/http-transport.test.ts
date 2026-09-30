import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { SapCloudSdkCmisClient } from "@/index";

let server: Server | undefined;
afterEach(async () => {
  if (server?.listening)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  server = undefined;
});

describe("Cloud SDK transport against a local HTTP server", () => {
  test("posts a real multipart CMIS Browser Binding request", async () => {
    let received: { url?: string; type?: string; body: string } | undefined;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = {
        url: request.url,
        type: request.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ succinctProperties: { "cmis:objectId": "new-doc" } }),
      );
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("test HTTP server has no port");
    const client = new SapCloudSdkCmisClient({
      destination: { url: `http://127.0.0.1:${address.port}` },
      repositoryId: "repo",
    });
    const created = await client.createDocument(
      "/a file.txt",
      new Blob(["hello"], { type: "text/plain" }),
    );
    expect(created.status).toBe(201);
    expect(received?.url).toBe("/browser/repo/root");
    expect(received?.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(received?.body).toContain('name="cmisaction"');
    expect(received?.body).toContain("createDocument");
    expect(received?.body).toContain("hello");
  });
});
