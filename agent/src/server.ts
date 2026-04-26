import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { buildGenerationPrompt, runCopilotWebAppGeneration, runCopilotWebAppGenerationStreaming } from "./copilot-runner.js";
import { validateZipBuffer } from "@web-app-gen/contracts";
import { ensureValidAppZip } from "./package-output.js";

const DEFAULT_PORT = 8088;

export { buildGenerationPrompt, runCopilotWebAppGeneration, runCopilotWebAppGenerationStreaming } from "./copilot-runner.js";

export function startServer(options: { port?: number; workspacePath?: string } = {}) {
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const workspacePath = options.workspacePath ?? process.env.WEB_APP_GEN_WORKSPACE ?? process.env.HOME ?? path.join(process.cwd(), ".session");

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && request.url === "/readiness") {
        sendJson(response, 200, { status: "ready" });
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/files")) {
        await handleFileDownload(request, response, workspacePath);
        return;
      }

      if (request.method === "POST" && request.url === "/responses") {
        await handleResponses(request, response, workspacePath);
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(port, () => {
    console.log(`web-app-gen agent listening on http://0.0.0.0:${port}`);
    console.log(`workspace: ${workspacePath}`);
  });
  return server;
}

async function handleResponses(request: IncomingMessage, response: ServerResponse, workspacePath: string): Promise<void> {
  const body = await readJson(request);
  const prompt = extractPrompt(body);
  const stream = extractStream(body);
  if (!prompt) {
    sendJson(response, 400, { error: "missing_prompt" });
    return;
  }

  await mkdir(workspacePath, { recursive: true });
  const token = resolveGitHubToken(body, process.env);
  if (!token) {
    sendJson(response, 401, {
      error: "missing_copilot_auth",
      message: "Set COPILOT_GITHUB_TOKEN, GITHUB_TOKEN, or GH_TOKEN to a GitHub user token with Copilot entitlement.",
    });
    return;
  }

  if (stream) {
    await handleStreamingResponse(response, workspacePath, token, prompt);
  } else {
    await handleNonStreamingResponse(response, workspacePath, token, prompt);
  }
}

async function handleStreamingResponse(response: ServerResponse, workspacePath: string, token: string, prompt: string): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const sendEvent = (event: string, data: unknown) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send SSE keepalive every 15s to prevent proxy idle timeout
  const heartbeat = setInterval(() => {
    response.write(": keepalive\n\n");
  }, 15_000);

  console.log(`[responses] streaming start prompt=${JSON.stringify(prompt.slice(0, 80))}`);
  sendEvent("progress", { type: "status", message: "Starting generation..." });

  try {
    await runCopilotWebAppGenerationStreaming({
      gitHubToken: token,
      workingDirectory: workspacePath,
      prompt,
      onEvent: (event) => {
        console.log(`[responses] event: ${event.type} ${event.message}`);
        sendEvent("progress", event);
      },
    });

    sendEvent("progress", { type: "status", message: "Packaging output..." });
    await ensureValidAppZip({ workspacePath, prompt });

    console.log("[responses] streaming done");
    sendEvent("done", {
      id: `resp_${Date.now()}`,
      status: "completed",
      output_text: "Generated static app at output/app.zip",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[responses] streaming error: ${message}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
    sendEvent("error", {
      status: "failed",
      message,
    });
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
}

async function handleNonStreamingResponse(response: ServerResponse, workspacePath: string, token: string, prompt: string): Promise<void> {
  await runCopilotWebAppGeneration({ gitHubToken: token, workingDirectory: workspacePath, prompt });

  try {
    await ensureValidAppZip({ workspacePath, prompt });
  } catch (error) {
    sendJson(response, 500, {
      error: "packaging_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  sendJson(response, 200, {
    id: `resp_${Date.now()}`,
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Generated static app at output/app.zip" }],
      },
    ],
    output_text: "Generated static app at output/app.zip",
  });
}

export function extractGitHubToken(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const token = (value as Record<string, unknown>).github_token;
  return typeof token === "string" && token.trim() ? token : undefined;
}

export function resolveGitHubToken(value: unknown, env: Record<string, string | undefined>): string | undefined {
  return extractGitHubToken(value) ?? env.COPILOT_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
}

async function handleFileDownload(request: IncomingMessage, response: ServerResponse, workspacePath: string): Promise<void> {
  const url = new URL(request.url ?? "/files", "http://localhost");
  const requestedPath = url.searchParams.get("path") ?? "output/app.zip";
  const normalizedPath = requestedPath.replaceAll("\\", "/");
  if (normalizedPath.startsWith("/") || normalizedPath.split("/").includes("..")) {
    sendJson(response, 400, { error: "unsafe_path" });
    return;
  }

  const filePath = path.join(workspacePath, normalizedPath);
  const fileStat = await stat(filePath).catch(() => undefined);
  if (!fileStat?.isFile()) {
    sendJson(response, 404, { error: "file_not_found", path: normalizedPath });
    return;
  }

  response.writeHead(200, {
    "content-type": normalizedPath.endsWith(".zip") ? "application/zip" : "application/octet-stream",
    "content-length": fileStat.size,
  });
  createReadStream(filePath).pipe(response);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extractPrompt(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const body = value as Record<string, unknown>;
  if (typeof body.input === "string") return body.input;
  if (body.input && typeof body.input === "object") {
    const input = body.input as Record<string, unknown>;
    const messages = input.messages;
    if (Array.isArray(messages)) {
      return messages
        .map((message) => (message && typeof message === "object" ? String((message as Record<string, unknown>).content ?? "") : ""))
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

function extractStream(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>).stream === true;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
