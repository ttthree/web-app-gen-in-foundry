import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGitHubIdentityCache, getGitHubIdentity } from "./github-identity.js";

describe("getGitHubIdentity", () => {
  beforeEach(() => clearGitHubIdentityCache());

  it("parses and caches GitHub user response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ login: "octo", id: 123 })));

    await expect(getGitHubIdentity("token", fetchImpl)).resolves.toEqual({ login: "octo", id: 123 });
    await expect(getGitHubIdentity("token", fetchImpl)).resolves.toEqual({ login: "octo", id: 123 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("handles HTTP and malformed responses", async () => {
    await expect(getGitHubIdentity("bad", async () => new Response("no", { status: 401 }))).rejects.toThrow("GitHub identity request failed: 401");
    await expect(getGitHubIdentity("bad2", async () => new Response(JSON.stringify({ login: "octo" })))).rejects.toThrow("missing login or id");
  });
});
