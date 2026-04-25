export type GitHubOAuthConfig = {
  clientId: string;
  redirectUri: string;
  scopes: string[];
};

export type GitHubOAuthCallback = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
};

export function buildGitHubOAuthStartUrl(config: GitHubOAuthConfig, state: string): URL {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", config.scopes.join(" "));
  return url;
}

export function validateGitHubOAuthCallback(callback: GitHubOAuthCallback, expectedState: string): { code: string; state: string } {
  if (callback.error) {
    throw new Error(callback.errorDescription ?? callback.error);
  }
  if (!callback.code) throw new Error("GitHub OAuth callback is missing code");
  if (!callback.state || callback.state !== expectedState) throw new Error("GitHub OAuth callback state mismatch");
  return { code: callback.code, state: callback.state };
}
