export type GitHubIdentity = {
  login: string;
  id: number;
};

let cachedToken: string | undefined;
let cachedIdentity: GitHubIdentity | undefined;

export async function getGitHubIdentity(token: string, fetchImpl: typeof fetch = fetch): Promise<GitHubIdentity> {
  if (cachedToken === token && cachedIdentity) return cachedIdentity;
  const response = await fetchImpl("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "web-app-gen-cli",
    },
  });
  if (!response.ok) throw new Error(`GitHub identity request failed: ${response.status}`);
  const body = (await response.json()) as { login?: unknown; id?: unknown };
  if (typeof body.login !== "string" || typeof body.id !== "number") throw new Error("GitHub identity response missing login or id");
  cachedToken = token;
  cachedIdentity = { login: body.login, id: body.id };
  return cachedIdentity;
}

export function clearGitHubIdentityCache(): void {
  cachedToken = undefined;
  cachedIdentity = undefined;
}
