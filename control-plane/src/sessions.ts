import type { FoundrySessionRef, FoundrySessionsClient, GitHubTokenBroker } from "@web-app-gen/contracts";

export type ProductSession = {
  id: string;
  productUserId: string;
  githubUserId: string;
  foundrySessionId: string;
  isolationKey: string;
  agentName: string;
  agentVersion?: string;
  status: "created" | "running" | "completed" | "failed";
  lastPrompt?: string;
  lastManifestPath?: string;
  lastZipPath?: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionManagerOptions = {
  foundry: FoundrySessionsClient;
  tokens: GitHubTokenBroker;
  now?: () => Date;
};

export class ProductSessionManager {
  private readonly sessions = new Map<string, ProductSession>();
  private readonly now: () => Date;

  constructor(private readonly options: SessionManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async createOrResume(input: { productUserId: string; githubUserId: string; isolationKey: string }): Promise<ProductSession> {
    await this.options.tokens.refreshIfNeeded({ productUserId: input.productUserId });
    const foundrySession = await this.options.foundry.createSession({ agentName: "web-app-builder-agent", isolationKey: input.isolationKey });

    const existing = [...this.sessions.values()].find((session) => session.foundrySessionId === foundrySession.sessionId);
    if (existing) return existing;

    const timestamp = this.now().toISOString();
    const session = toProductSession(input, foundrySession, timestamp);
    this.sessions.set(session.id, session);
    return session;
  }

  async generate(input: { productSessionId: string; prompt: string }): Promise<ProductSession> {
    const session = this.requireSession(input.productSessionId);
    const token = await this.options.tokens.getUserAccessToken({ productUserId: session.productUserId });
    const response = await this.options.foundry.createResponse({
      agentName: session.agentName,
      sessionId: session.foundrySessionId,
      prompt: input.prompt,
      githubToken: token.accessToken,
    });

    const updated: ProductSession = {
      ...session,
      status: response.status === "completed" ? "completed" : response.status === "failed" ? "failed" : "running",
      lastPrompt: input.prompt,
      lastManifestPath: "output/manifest.json",
      lastZipPath: "output/app.zip",
      updatedAt: this.now().toISOString(),
    };
    this.sessions.set(updated.id, updated);
    return updated;
  }

  list(): ProductSession[] {
    return [...this.sessions.values()];
  }

  private requireSession(productSessionId: string): ProductSession {
    const session = this.sessions.get(productSessionId);
    if (!session) throw new Error(`product session not found: ${productSessionId}`);
    return session;
  }
}

function toProductSession(
  input: { productUserId: string; githubUserId: string; isolationKey: string },
  foundrySession: FoundrySessionRef,
  timestamp: string,
): ProductSession {
  return {
    id: `product-${foundrySession.sessionId}`,
    productUserId: input.productUserId,
    githubUserId: input.githubUserId,
    foundrySessionId: foundrySession.sessionId,
    isolationKey: input.isolationKey,
    agentName: foundrySession.agentName,
    status: "created",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
