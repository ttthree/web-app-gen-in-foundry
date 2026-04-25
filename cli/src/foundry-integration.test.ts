import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createStoredZip, extractStoredZip } from "@web-app-gen/contracts";
import { FoundryRestClient } from "./foundry-client.js";

describe("FoundryRestClient integration", () => {
  it("creates a session, invokes, downloads app.zip, and verifies content", async () => {
    const zip = createStoredZip([
      { path: "index.html", contents: "<h1>fake</h1>" },
      { path: "manifest.json", contents: "{}" },
    ]);
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "POST" && url.pathname.endsWith("/endpoint/sessions")) {
        expect(request.headers.authorization).toBe("Bearer az-token");
        expect(request.headers["x-session-isolation-key"]).toBe("github:42");
        sendJson(response, { agent_session_id: "sid-1", status: "created" });
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/endpoint/protocols/openai/responses")) {
        const body = await readJson(request);
        expect(body).toMatchObject({ input: "build", agent_session_id: "sid-1", github_token: "gh-token" });
        sendJson(response, { id: "resp-1", status: "completed", output_text: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname.endsWith("/endpoint/sessions/sid-1/files/content")) {
        expect(url.searchParams.get("path")).toBe("output/app.zip");
        response.writeHead(200, { "content-type": "application/zip" });
        response.end(zip);
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const endpoint = await listen(server);
    try {
      const client = new FoundryRestClient({ endpoint, agentName: "agent", azureTokenProvider: async () => "az-token" });
      const session = await client.createSession({ agentName: "agent", isolationKey: "github:42" });
      await expect(client.createResponse({ agentName: "agent", sessionId: session.sessionId, prompt: "build", githubToken: "gh-token" })).resolves.toMatchObject({ responseId: "resp-1", status: "completed" });
      const downloaded = await client.downloadSessionFile({ agentName: "agent", sessionId: session.sessionId, path: "output/app.zip" });
      expect(extractStoredZip(downloaded).map((file) => file.path)).toEqual(["index.html", "manifest.json"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      resolve(`http://127.0.0.1:${address.port}/api/projects/proj`);
    });
  });
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
