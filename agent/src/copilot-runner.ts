import { CopilotClient } from "@github/copilot-sdk";
import type { SessionEvent } from "@github/copilot-sdk";
import { createGuardedPermissionHandler } from "./permission-guard.js";

export const WEB_APP_BUILDER_AGENT_NAME = "web-app-builder-agent";

export type ProgressEvent = {
  type: "intent" | "tool_start" | "tool_complete" | "status" | "error";
  message: string;
  toolName?: string;
};

export type CopilotRunnerInput = {
  gitHubToken: string;
  workingDirectory: string;
  prompt: string;
  skillsDirectory?: string;
  timeoutMs?: number;
};

export type CopilotStreamingInput = CopilotRunnerInput & {
  onEvent: (event: ProgressEvent) => void;
};

export function buildCopilotClientOptions() {
  return {
    useLoggedInUser: false,
  };
}

export function buildCopilotSessionConfig(input: Omit<CopilotRunnerInput, "prompt">) {
  const skillsDirectory = input.skillsDirectory ?? "/app/skills";
  return {
    gitHubToken: input.gitHubToken,
    workingDirectory: input.workingDirectory,
    skillDirectories: [skillsDirectory],
    customAgents: [
      {
        name: WEB_APP_BUILDER_AGENT_NAME,
        prompt: "Generate frontend-only static web apps and write only under the output directory.",
        skills: ["web-app-builder"],
      },
    ],
    agent: WEB_APP_BUILDER_AGENT_NAME,
    onPermissionRequest: createGuardedPermissionHandler({
      workspacePath: input.workingDirectory,
      skillsPath: skillsDirectory,
    }),
  };
}

export async function runCopilotWebAppGeneration(input: CopilotRunnerInput): Promise<void> {
  const client = new CopilotClient(buildCopilotClientOptions());
  await client.start();

  try {
    const session = await client.createSession(buildCopilotSessionConfig(input));
    try {
      await session.sendAndWait({ prompt: buildGenerationPrompt(input.prompt) }, input.timeoutMs ?? 10 * 60 * 1000);
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
  }
}

export async function runCopilotWebAppGenerationStreaming(input: CopilotStreamingInput): Promise<void> {
  const client = new CopilotClient(buildCopilotClientOptions());
  await client.start();

  try {
    const session = await client.createSession(buildCopilotSessionConfig(input));
    try {
      session.on((event: SessionEvent) => {
        const progress = mapEventToProgress(event);
        if (progress) input.onEvent(progress);
      });
      await session.sendAndWait({ prompt: buildGenerationPrompt(input.prompt) }, input.timeoutMs ?? 10 * 60 * 1000);
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
  }
}

function mapEventToProgress(event: SessionEvent): ProgressEvent | null {
  switch (event.type) {
    case "assistant.intent":
      return { type: "intent", message: event.data.intent };
    case "tool.execution_start":
      return { type: "tool_start", message: `Running ${event.data.toolName}`, toolName: event.data.toolName };
    case "tool.execution_complete":
      return { type: "tool_complete", message: `Done: ${event.data.toolCallId}`, toolName: event.data.toolCallId };
    case "session.error":
      return { type: "error", message: event.data.message };
    default:
      return null;
  }
}

export function buildGenerationPrompt(userRequest: string): string {
  return [
    "Use the web-app-builder skill to generate or update a frontend-only static web app.",
    "",
    "Rules:",
    "- Read existing files in output/app/ if present — modify them to fulfill the user request.",
    "- If no files exist yet, create a new app from scratch.",
    "- Write all app files under output/app.",
    "- The app must run by opening index.html directly in a browser.",
    "- Do not create output/app.zip — the server will package the files.",
    "- Do not create a backend, server process, database, auth provider, or cloud dependency.",
    "- Do not include tokens, secrets, or user auth data in generated files.",
    "",
    "User request:",
    userRequest,
  ].join("\n");
}
