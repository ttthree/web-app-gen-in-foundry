import { describe, expect, it } from "vitest";
import { buildGitHubOAuthStartUrl, validateGitHubOAuthCallback } from "./github-oauth.js";

describe("GitHub App OAuth", () => {
  it("builds an authorization URL", () => {
    const url = buildGitHubOAuthStartUrl(
      { clientId: "client-id", redirectUri: "https://product.example/callback", scopes: ["read:user", "user:email"] },
      "state-1",
    );

    expect(url.hostname).toBe("github.com");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("rejects callback errors and state mismatches", () => {
    expect(() => validateGitHubOAuthCallback({ error: "access_denied" }, "state-1")).toThrow("access_denied");
    expect(() => validateGitHubOAuthCallback({ code: "abc", state: "wrong" }, "state-1")).toThrow("state mismatch");
    expect(validateGitHubOAuthCallback({ code: "abc", state: "state-1" }, "state-1")).toEqual({ code: "abc", state: "state-1" });
  });
});
