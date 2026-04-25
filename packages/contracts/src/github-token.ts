export type GitHubUserAccessToken = {
  accessToken: string;
  expiresAt?: string;
};

export interface GitHubTokenBroker {
  getUserAccessToken(input: { productUserId: string }): Promise<GitHubUserAccessToken>;
  refreshIfNeeded(input: { productUserId: string }): Promise<void>;
}

export class MissingGitHubTokenError extends Error {
  constructor(productUserId: string) {
    super(`GitHub App authorization is required for product user ${productUserId}`);
    this.name = "MissingGitHubTokenError";
  }
}

export class InMemoryGitHubTokenBroker implements GitHubTokenBroker {
  private readonly tokens = new Map<string, GitHubUserAccessToken>();

  setToken(productUserId: string, token: GitHubUserAccessToken): void {
    this.tokens.set(productUserId, token);
  }

  async getUserAccessToken(input: { productUserId: string }): Promise<GitHubUserAccessToken> {
    const token = this.tokens.get(input.productUserId);
    if (!token) throw new MissingGitHubTokenError(input.productUserId);
    return token;
  }

  async refreshIfNeeded(input: { productUserId: string }): Promise<void> {
    await this.getUserAccessToken(input);
  }
}
