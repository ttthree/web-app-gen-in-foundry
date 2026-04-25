import { describe, expect, it, vi } from "vitest";
import { FoundryRestClient } from "./foundry-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("FoundryRestClient", () => {
  it("constructs session URLs and headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ agent_session_id: "sid" }));
    const client = new FoundryRestClient({ endpoint: "https://acct.services.ai.azure.com/api/projects/proj", agentName: "agent", fetchImpl, azureTokenProvider: async () => "az-token" });

    const session = await client.createSession({ agentName: "agent", isolationKey: "github:1" });

    expect(session).toEqual({ sessionId: "sid", isolationKey: "github:1", agentName: "agent" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://acct.services.ai.azure.com/api/projects/proj/agents/agent/endpoint/sessions?api-version=v1",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer az-token",
          "Foundry-Features": "HostedAgents=V1Preview",
          "x-session-isolation-key": "github:1",
        }),
      }),
    );
  });

  it("passes GitHub token only in response body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ id: "resp", status: "completed", output_text: "ok" }));
    const client = new FoundryRestClient({ endpoint: "https://acct.services.ai.azure.com/api/projects/proj", agentName: "agent", fetchImpl, azureTokenProvider: async () => "az-token" });

    await client.createResponse({ agentName: "agent", sessionId: "sid", prompt: "build", githubToken: "gh-token" });

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ input: "build", agent_session_id: "sid", github_token: "gh-token" });
    expect(init.headers).not.toMatchObject({ github_token: "gh-token" });
  });

  it("surfaces Foundry error messages", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "bad", message: "Nope" } }, 400));
    const client = new FoundryRestClient({ endpoint: "https://acct.services.ai.azure.com/api/projects/proj", agentName: "agent", fetchImpl, azureTokenProvider: async () => "az-token" });

    await expect(client.listSessionFiles({ agentName: "agent", sessionId: "sid" })).rejects.toThrow("Foundry API error 400: Nope");
  });

  it("downloads binary session files", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3])));
    const client = new FoundryRestClient({ endpoint: "https://acct.services.ai.azure.com/api/projects/proj", agentName: "agent", fetchImpl, azureTokenProvider: async () => "az-token" });

    await expect(client.downloadSessionFile({ agentName: "agent", sessionId: "sid", path: "output/app.zip" })).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://acct.services.ai.azure.com/api/projects/proj/agents/agent/endpoint/sessions/sid/files/content?api-version=v1&path=output%2Fapp.zip");
  });

  it("retries session_not_ready 424 responses three times", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { code: "session_not_ready", message: "warming" } }, 424))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "session_not_ready", message: "warming" } }, 424))
      .mockResolvedValueOnce(jsonResponse({ id: "resp", status: "completed" }));
    const sleeps: number[] = [];
    const client = new FoundryRestClient({
      endpoint: "https://acct.services.ai.azure.com/api/projects/proj",
      agentName: "agent",
      fetchImpl,
      azureTokenProvider: async () => "az-token",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.createResponse({ agentName: "agent", sessionId: "sid", prompt: "build", githubToken: "gh-token" })).resolves.toMatchObject({ status: "completed" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5000, 5000]);
  });
});
