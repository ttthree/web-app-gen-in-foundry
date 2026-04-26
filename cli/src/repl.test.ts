import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoredZip, type FoundrySessionsClient } from "@web-app-gen/contracts";
import { handleCommand, runTurn } from "./repl.js";
import type { PreviewServer } from "./preview-server.js";

const execMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execMock,
}));

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  execMock.mockReset();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("REPL command routing", () => {
  it("prints help for /help", async () => {
    const logs = captureLogs();
    await expect(handleCommand("/help", context())).resolves.toBe(false);
    expect(logs.output()).toContain("/sessions");
    expect(logs.output()).toContain("/help");
    logs.restore();
  });

  it("exits on /quit", async () => {
    await expect(handleCommand("/quit", context())).resolves.toBe(true);
  });

  it("prints current session details for /session", async () => {
    const logs = captureLogs();
    await expect(handleCommand("/session", context())).resolves.toBe(false);
    expect(logs.output()).toContain("Session: sid");
    expect(logs.output()).toContain("Agent: agent");
    expect(logs.output()).toContain("Endpoint: https://example.test/api/projects/proj");
    logs.restore();
  });

  it("opens the preview URL for /open", async () => {
    execMock.mockImplementation((_cmd: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, "", "");
    });

    await expect(handleCommand("/open", context())).resolves.toBe(false);

    expect(execMock).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["http://localhost:3001"]), expect.any(Object), expect.any(Function));
  });

  it("prints command list for unknown slash commands", async () => {
    const logs = captureLogs();
    await expect(handleCommand("/wat", context())).resolves.toBe(false);
    expect(logs.output()).toContain("Unknown command: /wat");
    expect(logs.output()).toContain("Commands: /sessions");
    logs.restore();
  });

  it("exports current preview files", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "web-app-gen-repl-test-"));
    tempDirs.push(rootDir);
    await writeFile(path.join(rootDir, "index.html"), "<h1>ok</h1>");
    const outDir = path.join(rootDir, "..", "exported");
    tempDirs.push(outDir);

    await expect(handleCommand(`/export ${outDir}`, context({ preview: preview(rootDir) }))).resolves.toBe(false);
    expect(await readFile(path.join(outDir, "index.html"), "utf8")).toBe("<h1>ok</h1>");
  });

  it("runs a basic turn flow", async () => {
    execMock.mockImplementation((_cmd: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, "gh-token\n", "");
    });
    const foundry = fakeFoundry();
    const previewServer = preview(await mkdtemp(path.join(tmpdir(), "web-app-gen-repl-turn-")));
    tempDirs.push(previewServer.rootDir);
    const logs = captureLogs();

    await runTurn(foundry, { agentName: "agent", sessionId: "sid", isolationKey: "github:1" }, previewServer, "build", { openBrowser: false });

    expect(foundry.requests).toEqual([{ prompt: "build", githubToken: "gh-token", sessionId: "sid" }]);
    expect(previewServer.version).toBe(1);
    expect(logs.output()).toContain("Generated app");
    logs.restore();
  });

  it("runs multiple turns against the same Foundry session", async () => {
    execMock.mockImplementation((_cmd: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, "gh-token\n", "");
    });
    const foundry = fakeFoundry();
    const previewServer = preview(await mkdtemp(path.join(tmpdir(), "web-app-gen-repl-multi-")));
    tempDirs.push(previewServer.rootDir);
    const session = { agentName: "agent", sessionId: "sid", isolationKey: "github:1" };

    await runTurn(foundry, session, previewServer, "build", { openBrowser: false });
    await runTurn(foundry, session, previewServer, "make it blue", { openBrowser: false });

    expect(foundry.requests).toEqual([
      { prompt: "build", githubToken: "gh-token", sessionId: "sid" },
      { prompt: "make it blue", githubToken: "gh-token", sessionId: "sid" },
    ]);
    expect(previewServer.version).toBe(2);
  });
});

function context(overrides: Partial<Parameters<typeof handleCommand>[1]> = {}): Parameters<typeof handleCommand>[1] {
  return {
    session: { agentName: "agent", sessionId: "sid", isolationKey: "github:1" },
    preview: preview("/tmp/web-app-gen-preview-test"),
    config: { endpoint: "https://example.test/api/projects/proj", agentName: "agent", previewPort: 3001, apiVersion: "v1" },
    foundry: fakeFoundry(),
    ...overrides,
  };
}

function preview(rootDir: string): PreviewServer {
  let version = 0;
  return {
    url: "http://localhost:3001",
    rootDir,
    port: 3001,
    get version() {
      return version;
    },
    async updateFromZip() {
      version += 1;
      return { files: [{ path: "index.html", contents: new TextEncoder().encode("<h1>ok</h1>") }] };
    },
    async exportTo(outDir: string) {
      await rm(outDir, { recursive: true, force: true });
      await import("node:fs/promises").then((fs) => fs.cp(rootDir, outDir, { recursive: true }));
    },
    async close() {},
  };
}

function fakeFoundry(): FoundrySessionsClient & { requests: Array<{ prompt: string; githubToken: string; sessionId: string }> } {
  const requests: Array<{ prompt: string; githubToken: string; sessionId: string }> = [];
  return {
    requests,
    async createSession(input) {
      return { agentName: input.agentName, sessionId: "sid", isolationKey: input.isolationKey };
    },
    async listSessions() {
      return [{ sessionId: "sid", status: "active", agentVersion: "1", createdAt: new Date(), lastAccessedAt: new Date() }];
    },
    async createResponse(input) {
      requests.push({ prompt: input.prompt, githubToken: input.githubToken, sessionId: input.sessionId });
      return { responseId: "resp", status: "completed" };
    },
    async createResponseStreaming(input) {
      requests.push({ prompt: input.prompt, githubToken: input.githubToken, sessionId: input.sessionId });
      input.onProgress({ type: "status", message: "Generating..." });
      return { responseId: "resp", status: "completed" };
    },
    async downloadSessionFile() {
      return createStoredZip([{ path: "index.html", contents: "<h1>ok</h1>" }]);
    },
    async listSessionFiles() {
      return [];
    },
  };
}

function captureLogs(): { output(): string; restore(): void } {
  const messages: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
    messages.push(String(message));
  });
  return {
    output: () => messages.join("\n"),
    restore: () => spy.mockRestore(),
  };
}
