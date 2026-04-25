import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./server.js";

const workspaces: string[] = [];
const servers: ReturnType<typeof startServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true });
});

describe("agent HTTP server", () => {
  it("returns missing auth for /responses when no GitHub token is available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "web-app-gen-server-"));
    workspaces.push(workspacePath);
    const server = startServer({ port: 0, workspacePath });
    servers.push(server);
    const url = await serverUrl(server);

    const response = await fetch(`${url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "build" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "missing_copilot_auth" });
  });

  it("rejects unsafe /files paths", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "web-app-gen-server-"));
    workspaces.push(workspacePath);
    const server = startServer({ port: 0, workspacePath });
    servers.push(server);
    const url = await serverUrl(server);

    const response = await fetch(`${url}/files?path=../secret`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "unsafe_path" });
  });
});

function serverUrl(server: ReturnType<typeof startServer>): Promise<string> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve(addressUrl(server.address()));
      return;
    }
    server.once("listening", () => resolve(addressUrl(server.address())));
  });
}

function addressUrl(address: ReturnType<ReturnType<typeof startServer>["address"]>): string {
  if (!address || typeof address === "string") throw new Error("missing server address");
  return `http://127.0.0.1:${address.port}`;
}
