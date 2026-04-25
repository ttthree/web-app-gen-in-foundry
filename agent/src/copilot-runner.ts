import { CopilotClient } from "@github/copilot-sdk";
import { createGuardedPermissionHandler } from "./permission-guard.js";

export const WEB_APP_BUILDER_AGENT_NAME = "web-app-builder-agent";

export type CopilotRunnerInput = {
  gitHubToken: string;
  workingDirectory: string;
  prompt: string;
  skillsDirectory?: string;
  timeoutMs?: number;
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
