export type FoundrySessionRef = {
  sessionId: string;
  isolationKey: string;
  agentName: string;
};

export interface FoundrySessionsClient {
  createOrResumeSession(input: { productUserId: string; isolationKey: string }): Promise<FoundrySessionRef>;
  createResponse(input: { session: FoundrySessionRef; prompt: string }): Promise<{ responseId: string; status: string }>;
  downloadSessionFile(input: { session: FoundrySessionRef; path: string }): Promise<Uint8Array>;
}

export class InMemoryFoundrySessionsClient implements FoundrySessionsClient {
  private readonly sessions = new Map<string, FoundrySessionRef>();
  private readonly files = new Map<string, Uint8Array>();

  constructor(private readonly agentName = "web-app-builder-agent") {}

  async createOrResumeSession(input: { productUserId: string; isolationKey: string }): Promise<FoundrySessionRef> {
    const key = `${input.productUserId}:${input.isolationKey}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const session = {
      sessionId: `session-${this.sessions.size + 1}`,
      isolationKey: input.isolationKey,
      agentName: this.agentName,
    };
    this.sessions.set(key, session);
    return session;
  }

  async createResponse(input: { session: FoundrySessionRef; prompt: string }): Promise<{ responseId: string; status: string }> {
    if (!input.prompt.trim()) return { responseId: "", status: "failed" };
    return { responseId: `response-${input.session.sessionId}`, status: "completed" };
  }

  async downloadSessionFile(input: { session: FoundrySessionRef; path: string }): Promise<Uint8Array> {
    const file = this.files.get(this.fileKey(input.session, input.path));
    if (!file) throw new Error(`session file not found: ${input.path}`);
    return file;
  }

  putSessionFile(session: FoundrySessionRef, path: string, contents: Uint8Array): void {
    this.files.set(this.fileKey(session, path), contents);
  }

  private fileKey(session: FoundrySessionRef, path: string): string {
    return `${session.sessionId}:${path}`;
  }
}
