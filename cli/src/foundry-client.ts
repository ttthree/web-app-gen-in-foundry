import { execFile } from "node:child_process";
import type { FoundrySessionRef, FoundrySessionsClient, FoundrySessionFile, FoundryProgressEvent } from "@web-app-gen/contracts";

export type FoundryClientOptions = {
  endpoint: string;
  agentName: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  azureTokenProvider?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
};

export class FoundryRestClient implements FoundrySessionsClient {
  private readonly endpoint: string;
  private readonly agentName: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly azureTokenProvider: () => Promise<string>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: FoundryClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.agentName = options.agentName;
    this.apiVersion = options.apiVersion ?? "v1";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.azureTokenProvider = options.azureTokenProvider ?? getAzureAccessToken;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async createSession(input: { agentName: string; isolationKey: string }): Promise<FoundrySessionRef> {
    const response = await this.requestJson<{ agent_session_id?: string; id?: string }>(
      "POST",
      this.agentPath(input.agentName, "endpoint/sessions"),
      { headers: { "x-session-isolation-key": input.isolationKey }, body: {} },
    );
    const sessionId = response.agent_session_id ?? response.id;
    if (!sessionId) throw new Error("Foundry create session response missing agent_session_id");
    return { sessionId, isolationKey: input.isolationKey, agentName: input.agentName };
  }

  async createResponse(input: { agentName: string; sessionId: string; prompt: string; githubToken: string }): Promise<{ responseId: string; status: string; outputText?: string }> {
    const response = await this.requestJson<{ id?: string; status?: string; output_text?: string }>(
      "POST",
      this.agentPath(input.agentName, "endpoint/protocols/openai/responses"),
      {
        body: {
          input: input.prompt,
          stream: false,
          agent_session_id: input.sessionId,
          github_token: input.githubToken,
        },
        timeoutMs: 5 * 60 * 1000,
      },
    );
    if (response.status === "failed") throw new Error(response.output_text ?? "Foundry response failed");
    return { responseId: response.id ?? "", status: response.status ?? "unknown", outputText: response.output_text };
  }

  async createResponseStreaming(input: { agentName: string; sessionId: string; prompt: string; githubToken: string; onProgress: (event: FoundryProgressEvent) => void }): Promise<{ responseId: string; status: string; outputText?: string }> {
    const token = await this.azureTokenProvider();
    const url = this.url(this.agentPath(input.agentName, "endpoint/protocols/openai/responses"));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "Foundry-Features": "HostedAgents=V1Preview",
        },
        body: JSON.stringify({
          input: input.prompt,
          stream: true,
          agent_session_id: input.sessionId,
          github_token: input.githubToken,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await readFoundryError(response);
        throw formatFoundryError(response.status, error.message);
      }

      const contentType = response.headers.get("content-type") ?? "";

      if (contentType.includes("text/event-stream") && response.body) {
        return await this.consumeSSE(response.body, input.onProgress);
      }

      // Fallback: server responded with JSON (non-streaming)
      const json = (await response.json()) as { id?: string; status?: string; output_text?: string };
      if (json.status === "failed") throw new Error(json.output_text ?? "Foundry response failed");
      return { responseId: json.id ?? "", status: json.status ?? "unknown", outputText: json.output_text };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Generation timed out. Try a simpler request.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async consumeSSE(body: ReadableStream<Uint8Array>, onProgress: (event: FoundryProgressEvent) => void): Promise<{ responseId: string; status: string; outputText?: string }> {
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let result: { responseId: string; status: string; outputText?: string } = { responseId: "", status: "unknown" };

    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);
              if (currentEvent === "progress") {
                onProgress(parsed as FoundryProgressEvent);
              } else if (currentEvent === "done") {
                result = { responseId: parsed.id ?? "", status: parsed.status ?? "completed", outputText: parsed.output_text };
              } else if (currentEvent === "error") {
                throw new Error(parsed.message ?? "Generation failed");
              }
            } catch (parseError) {
              if (parseError instanceof SyntaxError) continue; // skip malformed JSON
              throw parseError;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return result;
  }

  async downloadSessionFile(input: { agentName: string; sessionId: string; path: string }): Promise<Uint8Array> {
    const url = this.url(this.agentPath(input.agentName, `endpoint/sessions/${encodeURIComponent(input.sessionId)}/files/content`), {
      path: input.path,
    });
    const response = await this.request("GET", url);
    return new Uint8Array(await response.arrayBuffer());
  }

  async listSessionFiles(input: { agentName: string; sessionId: string; path?: string }): Promise<FoundrySessionFile[]> {
    const url = this.url(this.agentPath(input.agentName, `endpoint/sessions/${encodeURIComponent(input.sessionId)}/files`), {
      path: input.path ?? "output",
    });
    const response = await this.requestJson<{ entries?: Array<{ name: string; size?: number; is_dir?: boolean; isDirectory?: boolean }> }>("GET", url);
    return (response.entries ?? []).map((entry) => ({ name: entry.name, size: entry.size, isDirectory: entry.isDirectory ?? entry.is_dir ?? false }));
  }

  private agentPath(agentName: string, suffix: string): string {
    return `agents/${encodeURIComponent(agentName || this.agentName)}/${suffix}`;
  }

  private async requestJson<T>(method: string, pathOrUrl: string, options: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const response = await this.request(method, pathOrUrl, options);
    return (await response.json()) as T;
  }

  private async request(method: string, pathOrUrl: string, options: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
    const maxAttempts = 3;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.requestOnce(method, pathOrUrl, options);
      } catch (error) {
        // Network-level failures (fetch failed, ECONNRESET, etc.) — retry with backoff
        if (attempt < maxAttempts) {
          const delay = 5000 * (attempt + 1);
          console.error(`⚠ Network error (attempt ${attempt + 1}/${maxAttempts + 1}): ${describeError(error)}. Retrying in ${delay / 1000}s...`);
          await this.sleep(delay);
          continue;
        }
        throw error;
      }
      if (response.ok) return response;
      const error = await readFoundryError(response);
      if (response.status === 424 && error.code === "session_not_ready" && attempt < maxAttempts) {
        await this.sleep(5000);
        continue;
      }
      throw formatFoundryError(response.status, error.message);
    }
    throw new Error("Foundry API retry failed");
  }

  private async requestOnce(method: string, pathOrUrl: string, options: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number }): Promise<Response> {
    const token = await this.azureTokenProvider();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
    try {
      return await this.fetchImpl(pathOrUrl.startsWith("http") ? pathOrUrl : this.url(pathOrUrl), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "Foundry-Features": "HostedAgents=V1Preview",
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Generation timed out. Try a simpler request.");
      throw new Error(`Network error: ${describeError(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.endpoint}/${path}`);
    url.searchParams.set("api-version", this.apiVersion);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }
}

export async function getAzureAccessToken(): Promise<string> {
  const { stdout } = await exec("az", ["account", "get-access-token", "--resource", "https://ai.azure.com", "--query", "accessToken", "-o", "tsv"]);
  const token = stdout.trim();
  if (!token) throw new Error("Azure credentials expired. Run: az login");
  return token;
}

async function readFoundryError(response: Response): Promise<{ code?: string; message: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string }; message?: string };
    return { code: body.error?.code, message: body.error?.message ?? body.message ?? response.statusText };
  } catch {
    return { message: await response.text().catch(() => response.statusText) };
  }
}

function formatFoundryError(status: number, message: string): Error {
  if (status === 401 || status === 403) return new Error(`Azure credentials expired. Run: az login (${message})`);
  return new Error(`Foundry API error ${status}: ${message}`);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) return `${error.message} (${cause.message})`;
  return error.message;
}

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || stdout || error.message));
      else resolve({ stdout, stderr });
    });
  });
}
