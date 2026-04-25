export type FoundrySessionRef = {
  sessionId: string;
  isolationKey: string;
  agentName: string;
};

export type FoundrySessionFile = {
  name: string;
  size?: number;
  isDirectory: boolean;
};

export type FoundryProgressEvent = {
  type: "intent" | "tool_start" | "tool_complete" | "status" | "error";
  message: string;
  toolName?: string;
};

export interface FoundrySessionsClient {
  createSession(input: { agentName: string; isolationKey: string }): Promise<FoundrySessionRef>;
  createResponse(input: { agentName: string; sessionId: string; prompt: string; githubToken: string }): Promise<{ responseId: string; status: string; outputText?: string }>;
  createResponseStreaming(input: { agentName: string; sessionId: string; prompt: string; githubToken: string; onProgress: (event: FoundryProgressEvent) => void }): Promise<{ responseId: string; status: string; outputText?: string }>;
  downloadSessionFile(input: { agentName: string; sessionId: string; path: string }): Promise<Uint8Array>;
  listSessionFiles(input: { agentName: string; sessionId: string; path?: string }): Promise<FoundrySessionFile[]>;
}

export class InMemoryFoundrySessionsClient implements FoundrySessionsClient {
  private readonly sessions = new Map<string, FoundrySessionRef>();
  private readonly files = new Map<string, Uint8Array>();

  constructor(private readonly defaultAgentName = "web-app-builder-agent") {}

  async createSession(input: { agentName: string; isolationKey: string }): Promise<FoundrySessionRef> {
    const agentName = input.agentName || this.defaultAgentName;
    const key = `${agentName}:${input.isolationKey}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const session = {
      sessionId: `session-${this.sessions.size + 1}`,
      isolationKey: input.isolationKey,
      agentName,
    };
    this.sessions.set(key, session);
    return session;
  }

  async createResponse(input: { agentName: string; sessionId: string; prompt: string; githubToken: string }): Promise<{ responseId: string; status: string; outputText?: string }> {
    if (!input.prompt.trim()) return { responseId: "", status: "failed" };
    if (!input.githubToken.trim()) return { responseId: "", status: "failed", outputText: "missing GitHub token" };
    return { responseId: `response-${input.sessionId}`, status: "completed", outputText: "Generated static app at output/app.zip" };
  }

  async createResponseStreaming(input: { agentName: string; sessionId: string; prompt: string; githubToken: string; onProgress: (event: FoundryProgressEvent) => void }): Promise<{ responseId: string; status: string; outputText?: string }> {
    input.onProgress({ type: "status", message: "Generating..." });
    return this.createResponse(input);
  }

  async downloadSessionFile(input: { agentName: string; sessionId: string; path: string }): Promise<Uint8Array> {
    const file = this.files.get(this.fileKey(input.agentName, input.sessionId, input.path));
    if (!file) throw new Error(`session file not found: ${input.path}`);
    return file;
  }

  async listSessionFiles(input: { agentName: string; sessionId: string; path?: string }): Promise<FoundrySessionFile[]> {
    const directory = input.path ? input.path.replace(/\/$/, "") : "";
    const prefix = `${input.agentName}:${input.sessionId}:${directory ? `${directory}/` : ""}`;
    const entries = new Map<string, FoundrySessionFile>();
    for (const [key, contents] of this.files) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const [name, ...remaining] = rest.split("/");
      if (!name) continue;
      entries.set(name, { name, size: remaining.length ? undefined : contents.byteLength, isDirectory: remaining.length > 0 });
    }
    return [...entries.values()];
  }

  putSessionFile(session: FoundrySessionRef, path: string, contents: Uint8Array): void {
    this.files.set(this.fileKey(session.agentName, session.sessionId, path), contents);
  }

  private fileKey(agentName: string, sessionId: string, path: string): string {
    return `${agentName}:${sessionId}:${path}`;
  }
}
