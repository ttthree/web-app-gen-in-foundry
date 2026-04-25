import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import type { FoundrySessionRef, FoundrySessionsClient } from "@web-app-gen/contracts";
import { FoundryRestClient } from "./foundry-client.js";
import { getGitHubIdentity } from "./github-identity.js";
import { startPreviewServer, type PreviewServer } from "./preview-server.js";

export type CliConfig = {
  endpoint: string;
  agentName: string;
  previewPort: number;
  apiVersion: string;
};

export type ReplOptions = Partial<CliConfig> & {
  foundry?: FoundrySessionsClient;
  openBrowser?: boolean;
};

export async function startRepl(options: ReplOptions = {}): Promise<void> {
  const config = await resolveConfig(options);
  await validatePrerequisites();
  const initialToken = await getFreshGitHubToken();
  const identity = await getGitHubIdentity(initialToken);
  const isolationKey = `github:${identity.id}`;
  const foundry = options.foundry ?? new FoundryRestClient(config);
  const session = await foundry.createSession({ agentName: config.agentName, isolationKey });
  const preview = await startPreviewServer(config.previewPort);
  let browserOpened = false;

  console.log("🔧 Authenticating...");
  console.log(`✓ GitHub: ${identity.login}`);
  console.log("✓ Azure: authenticated");
  console.log(`✓ Session: ${session.sessionId}`);
  console.log(`✓ Preview: ${preview.url}`);
  console.log("Type /help for commands.\n");

  const rl = createInterface({ input, output, prompt: "web-app-gen> " });
  try {
    rl.prompt();
    for await (const line of rl) {
      const command = line.trim();
      if (!command) {
        rl.prompt();
        continue;
      }
      if (await handleCommand(command, { session, preview, config })) break;
      if (!command.startsWith("/")) {
        await runTurn(foundry, session, preview, command, { openBrowser: options.openBrowser !== false && !browserOpened });
        browserOpened = true;
      }
      rl.prompt();
    }
  } finally {
    rl.close();
    await preview.close();
  }
}

export async function runSingleGenerate(prompt: string, options: ReplOptions = {}): Promise<{ session: FoundrySessionRef; preview: PreviewServer }> {
  const config = await resolveConfig(options);
  await validatePrerequisites();
  const token = await getFreshGitHubToken();
  const identity = await getGitHubIdentity(token);
  const foundry = options.foundry ?? new FoundryRestClient(config);
  const session = await foundry.createSession({ agentName: config.agentName, isolationKey: `github:${identity.id}` });
  const preview = await startPreviewServer(config.previewPort);
  await runTurn(foundry, session, preview, prompt, { openBrowser: options.openBrowser !== false });
  return { session, preview };
}

export async function runTurn(
  foundry: FoundrySessionsClient,
  session: FoundrySessionRef,
  preview: PreviewServer,
  prompt: string,
  options: { openBrowser?: boolean } = {},
): Promise<void> {
  console.log("⏳ Generating...");
  const githubToken = await getFreshGitHubToken();
  const response = await foundry.createResponse({ agentName: session.agentName, sessionId: session.sessionId, prompt, githubToken });
  if (response.status !== "completed") throw new Error(response.outputText ?? `Generation did not complete: ${response.status}`);
  const zip = await foundry.downloadSessionFile({ agentName: session.agentName, sessionId: session.sessionId, path: "output/app.zip" });
  const result = await preview.updateFromZip(zip);
  const bytes = result.files.reduce((sum, file) => sum + file.contents.byteLength, 0);
  console.log(`✓ Generated app (${result.files.length} files, ${formatBytes(bytes)})`);
  if (options.openBrowser) await openBrowser(preview.url);
  console.log("✓ Preview updated — check your browser");
}

export async function resolveConfig(options: Partial<CliConfig> = {}): Promise<CliConfig> {
  const endpoint = options.endpoint ?? process.env.AZURE_AI_PROJECT_ENDPOINT ?? (await getAzdValue("AZURE_AI_PROJECT_ENDPOINT"));
  if (!endpoint) throw new Error("AZURE_AI_PROJECT_ENDPOINT not set. Run: azd env get-values or set the env var.");
  return {
    endpoint,
    agentName: options.agentName ?? process.env.WEB_APP_GEN_AGENT_NAME ?? "web-app-gen-in-foundry",
    previewPort: options.previewPort ?? Number(process.env.WEB_APP_GEN_PREVIEW_PORT ?? 3001),
    apiVersion: options.apiVersion ?? process.env.FOUNDRY_API_VERSION ?? "v1",
  };
}

export async function getFreshGitHubToken(): Promise<string> {
  const { stdout } = await exec("gh", ["auth", "token"]);
  const token = stdout.trim();
  if (!token) throw new Error("Not logged in to GitHub. Run: gh auth login");
  return token;
}

async function handleCommand(command: string, context: { session: FoundrySessionRef; preview: PreviewServer; config: CliConfig }): Promise<boolean> {
  if (command === "/quit" || command === "/exit") return true;
  if (command === "/help") {
    printReplHelp();
    return false;
  }
  if (command === "/session") {
    console.log(`Session: ${context.session.sessionId}`);
    console.log(`Agent: ${context.session.agentName}`);
    console.log(`Endpoint: ${context.config.endpoint}`);
    return false;
  }
  if (command === "/open") {
    await openBrowser(context.preview.url);
    return false;
  }
  if (command.startsWith("/export")) {
    const outDir = command.split(/\s+/)[1] ?? "./output";
    await context.preview.exportTo(path.resolve(outDir));
    console.log(`✓ Exported app files to ${outDir}`);
    return false;
  }
  if (command.startsWith("/")) {
    console.log(`Unknown command: ${command}`);
    printReplHelp();
    return false;
  }
  return false;
}

export { handleCommand };

function printReplHelp(): void {
  console.log("Commands: /quit, /exit, /open, /session, /export [dir], /help");
}

async function validatePrerequisites(): Promise<void> {
  await exec("gh", ["--version"]).catch(() => {
    throw new Error("GitHub CLI not found. Install: https://cli.github.com");
  });
  await exec("gh", ["auth", "status"]).catch(() => {
    throw new Error("Not logged in to GitHub. Run: gh auth login");
  });
  await exec("az", ["account", "show", "-o", "none"]).catch(() => {
    throw new Error("Not logged in to Azure. Run: az login");
  });
}

async function getAzdValue(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("azd", ["env", "get-values"]);
    for (const line of stdout.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match?.[1] === name) return match[2]?.replace(/^"|"$/g, "");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await exec(command, args).catch(() => undefined);
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || stdout || error.message));
      else resolve({ stdout, stderr });
    });
  });
}
