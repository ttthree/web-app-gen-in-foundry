import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCopilotClientOptions,
  buildCopilotSessionConfig,
  runCopilotWebAppGeneration,
  WEB_APP_BUILDER_AGENT_NAME,
} from "./copilot-runner.js";

const sdkMock = vi.hoisted(() => {
  const session = {
    sendAndWait: vi.fn(),
    disconnect: vi.fn(),
  };
  const client = {
    start: vi.fn(),
    createSession: vi.fn(async () => session),
    stop: vi.fn(),
  };
  return {
    client,
    session,
    CopilotClient: vi.fn(() => client),
  };
});

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: sdkMock.CopilotClient,
  approveAll: async () => ({ kind: "approve-once" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Copilot runner configuration", () => {
  it("disables logged-in user auth on the client and passes per-session token", () => {
    const sessionConfig = buildCopilotSessionConfig({
      gitHubToken: "ghu_user_token",
      workingDirectory: "/foundry/session/workspace",
      skillsDirectory: "/app/skills",
    });

    expect(buildCopilotClientOptions()).toEqual({ useLoggedInUser: false });
    expect(sessionConfig).toMatchObject({
      gitHubToken: "ghu_user_token",
      workingDirectory: "/foundry/session/workspace",
      skillDirectories: ["/app/skills"],
      agent: WEB_APP_BUILDER_AGENT_NAME,
      customAgents: [
        {
          name: WEB_APP_BUILDER_AGENT_NAME,
          skills: ["web-app-builder"],
        },
      ],
    });
    expect(sessionConfig).not.toHaveProperty("useLoggedInUser");
    expect(sessionConfig.onPermissionRequest).toBeTypeOf("function");
  });

  it("starts the SDK client, creates a configured session, sends the prompt, and cleans up", async () => {
    await runCopilotWebAppGeneration({
      gitHubToken: "ghu_user_token",
      workingDirectory: "/foundry/session/workspace",
      skillsDirectory: "/app/skills",
      prompt: "pomodoro timer",
    });

    expect(sdkMock.CopilotClient).toHaveBeenCalledWith({ useLoggedInUser: false });
    expect(sdkMock.client.start).toHaveBeenCalledOnce();
    expect(sdkMock.client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        gitHubToken: "ghu_user_token",
        workingDirectory: "/foundry/session/workspace",
        skillDirectories: ["/app/skills"],
        agent: WEB_APP_BUILDER_AGENT_NAME,
      }),
    );
    expect(sdkMock.session.sendAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("pomodoro timer") as string,
      }),
      600000,
    );
    expect(sdkMock.session.disconnect).toHaveBeenCalledOnce();
    expect(sdkMock.client.stop).toHaveBeenCalledOnce();
  });
});
