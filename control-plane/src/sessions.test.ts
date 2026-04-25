import { describe, expect, it } from "vitest";
import { InMemoryFoundrySessionsClient, InMemoryGitHubTokenBroker } from "@web-app-gen/contracts";
import { ProductSessionManager } from "./sessions.js";

describe("ProductSessionManager", () => {
  it("creates a mapped session and sends generation through Foundry boundary", async () => {
    const foundry = new InMemoryFoundrySessionsClient();
    const tokens = new InMemoryGitHubTokenBroker();
    tokens.setToken("user-1", { accessToken: "ghu_user_token" });
    const manager = new ProductSessionManager({ foundry, tokens, now: () => new Date("2026-04-25T00:00:00.000Z") });

    const session = await manager.createOrResume({ productUserId: "user-1", githubUserId: "github-1", isolationKey: "iso-1" });
    const generated = await manager.generate({ productSessionId: session.id, prompt: "pomodoro timer" });

    expect(session).toMatchObject({ productUserId: "user-1", githubUserId: "github-1", foundrySessionId: "session-1" });
    expect(generated).toMatchObject({ status: "completed", lastManifestPath: "output/manifest.json", lastZipPath: "output/app.zip" });
  });
});
