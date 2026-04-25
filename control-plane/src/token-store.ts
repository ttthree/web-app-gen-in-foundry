import type { GitHubUserAccessToken } from "@web-app-gen/contracts";

export interface TokenStore {
  get(productUserId: string): Promise<GitHubUserAccessToken | undefined>;
  set(productUserId: string, token: GitHubUserAccessToken): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, GitHubUserAccessToken>();

  async get(productUserId: string): Promise<GitHubUserAccessToken | undefined> {
    return this.tokens.get(productUserId);
  }

  async set(productUserId: string, token: GitHubUserAccessToken): Promise<void> {
    this.tokens.set(productUserId, token);
  }
}
