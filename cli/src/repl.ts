import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
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
  sessionId?: string;
};

export async function startRepl(options: ReplOptions = {}): Promise<void> {
  const config = await resolveConfig(options);
  await validatePrerequisites();
  const initialToken = await getFreshGitHubToken();
  const identity = await getGitHubIdentity(initialToken);
  const isolationKey = `github:${identity.id}`;
  const foundry = options.foundry ?? new FoundryRestClient(config);

  let session: FoundrySessionRef;
  if (options.sessionId) {
    session = { sessionId: options.sessionId, isolationKey, agentName: config.agentName };
  } else {
    session = await foundry.createSession({ agentName: config.agentName, isolationKey });
  }
  const preview = await startPreviewServer(config.previewPort);
  let browserOpened = false;

  console.log("🔧 Authenticating...");
  console.log(`✓ GitHub: ${identity.login}`);
  console.log("✓ Azure: authenticated");
  console.log(`✓ Session: ${session.sessionId}${options.sessionId ? " (resumed)" : ""}`);
  console.log(`✓ Preview: ${preview.url}`);

  // If resuming a session, show history and try to load existing app into preview
  if (options.sessionId) {
    const history = await loadHistory(session.sessionId);
    printHistory(history);
    try {
      const files = await foundry.listSessionFiles({ agentName: session.agentName, sessionId: session.sessionId, path: "output/app" });
      const appFiles = files.filter((f) => !f.isDirectory);
      if (appFiles.length > 0) {
        const zip = await foundry.downloadSessionFile({ agentName: session.agentName, sessionId: session.sessionId, path: "output/app.zip" });
        const loaded = await preview.updateFromZip(zip);
        const bytes = loaded.files.reduce((sum, f) => sum + f.contents.byteLength, 0);
        console.log(`✓ Loaded existing app (${loaded.files.length} files, ${formatBytes(bytes)})`);
      }
    } catch {
      // No existing app — that's fine
    }
  }

  console.log("Type /help for commands.\n");

  const context = { session, preview, config, foundry };

  const rl = createInterface({ input, output, prompt: "web-app-gen> " });
  try {
    rl.prompt();
    for await (const line of rl) {
      const command = line.trim();
      if (!command) {
        rl.prompt();
        continue;
      }
      const result = await handleCommand(command, context);
      if (result === true) break;
      if (result && typeof result === "object" && "switchTo" in result) {
        context.session = { sessionId: result.switchTo, isolationKey, agentName: config.agentName };
        session = context.session;
        console.log(`✓ Switched to session: ${session.sessionId}`);
        // Show conversation history
        const history = await loadHistory(session.sessionId);
        printHistory(history);
        // Try to load existing app from the session into preview
        try {
          const files = await foundry.listSessionFiles({ agentName: session.agentName, sessionId: session.sessionId, path: "output/app" });
          const appFiles = files.filter((f) => !f.isDirectory);
          if (appFiles.length > 0) {
            const zip = await foundry.downloadSessionFile({ agentName: session.agentName, sessionId: session.sessionId, path: "output/app.zip" });
            const loaded = await preview.updateFromZip(zip);
            const bytes = loaded.files.reduce((sum, f) => sum + f.contents.byteLength, 0);
            console.log(`✓ Loaded existing app (${loaded.files.length} files, ${formatBytes(bytes)})`);
            console.log(`✓ Preview updated — check your browser`);
          } else {
            console.log("ℹ No app in this session yet.");
          }
        } catch {
          console.log("ℹ No existing app to load from this session.");
        }
        rl.prompt();
        continue;
      }
      if (!command.startsWith("/")) {
        try {
          await runTurn(foundry, session, preview, command, { openBrowser: options.openBrowser !== false && !browserOpened });
          browserOpened = true;
        } catch (error) {
          console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
          console.log("You can retry by sending the same prompt again.");
        }
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
  const githubToken = await getFreshGitHubToken();
  let lastToolName = "";
  const clearLine = () => process.stdout.write("\x1b[2K\r");
  const ts = () => `\x1b[2m${new Date().toLocaleTimeString()}\x1b[0m`;

  const response = await foundry.createResponseStreaming({
    agentName: session.agentName,
    sessionId: session.sessionId,
    prompt,
    githubToken,
    onProgress: (event) => {
      switch (event.type) {
        case "intent":
          clearLine();
          process.stdout.write(`${ts()} 🤔 ${event.message}\n`);
          break;
        case "tool_start":
          clearLine();
          lastToolName = event.toolName ?? event.message;
          process.stdout.write(`${ts()} 🔧 ${event.message}...`);
          break;
        case "tool_complete":
          // Finish the current tool line
          process.stdout.write(" ✓\n");
          lastToolName = "";
          break;
        case "status":
          clearLine();
          if (lastToolName) process.stdout.write("\n"); // close open tool line
          lastToolName = "";
          process.stdout.write(`${ts()} ⏳ ${event.message}\n`);
          break;
        case "error":
          clearLine();
          if (lastToolName) process.stdout.write("\n");
          lastToolName = "";
          process.stdout.write(`${ts()} ✗ ${event.message}\n`);
          break;
        case "permission_denied":
          clearLine();
          if (lastToolName) process.stdout.write("\n");
          lastToolName = "";
          process.stdout.write(`${ts()} 🚫 ${event.message}\n`);
          break;
        case "agent_message":
          if (event.message) {
            clearLine();
            if (lastToolName) process.stdout.write("\n");
            lastToolName = "";
            process.stdout.write(`${ts()} 💬 ${event.message}\n`);
          }
          break;
      }
    },
  });
  if (response.status !== "completed") throw new Error(response.outputText ?? `Generation did not complete: ${response.status}`);
  clearLine();
  process.stdout.write(`${ts()} ⬇ Downloading app...\n`);
  const zip = await foundry.downloadSessionFile({ agentName: session.agentName, sessionId: session.sessionId, path: "output/app.zip" });
  const result = await preview.updateFromZip(zip);
  const bytes = result.files.reduce((sum, file) => sum + file.contents.byteLength, 0);
  console.log(`${ts()} ✓ Generated app (${result.files.length} files, ${formatBytes(bytes)})`);
  if (options.openBrowser) await openBrowser(preview.url);
  console.log(`${ts()} ✓ Preview updated — check your browser`);

  // Save conversation history locally
  const now = new Date().toISOString();
  await saveHistoryEntry(session.sessionId, { role: "user", text: prompt, timestamp: now }).catch(() => {});
  const summary = `Generated app (${result.files.length} files, ${formatBytes(bytes)})`;
  await saveHistoryEntry(session.sessionId, { role: "assistant", text: summary, timestamp: now }).catch(() => {});
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

type CommandResult = boolean | { switchTo: string };

async function handleCommand(command: string, context: { session: FoundrySessionRef; preview: PreviewServer; config: CliConfig; foundry: FoundrySessionsClient }): Promise<CommandResult> {
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
  if (command === "/sessions" || command.startsWith("/sessions ")) {
    const arg = command.split(/\s+/)[1];
    try {
      const sessions = await context.foundry.listSessions({ agentName: context.config.agentName });
      if (arg) {
        // Switch by # or full session ID
        const num = Number(arg);
        let targetId: string;
        if (Number.isInteger(num) && num >= 1 && num <= sessions.length) {
          targetId = sessions[num - 1].sessionId;
        } else {
          // Match by prefix or full ID
          const match = sessions.find((s) => s.sessionId === arg || s.sessionId.startsWith(arg));
          if (!match) {
            console.log(`✗ No session matching "${arg}". Use /sessions to list.`);
            return false;
          }
          targetId = match.sessionId;
        }
        return { switchTo: targetId };
      }
      if (sessions.length === 0) {
        console.log("No sessions found.");
      } else {
        const current = context.session.sessionId;
        console.log(`\n  ${"#".padEnd(4)} ${"Session ID".padEnd(16)} ${"Status".padEnd(10)} ${"Ver".padEnd(5)} ${"Last Accessed"}`);
        console.log(`  ${"─".repeat(4)} ${"─".repeat(16)} ${"─".repeat(10)} ${"─".repeat(5)} ${"─".repeat(20)}`);
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          const marker = s.sessionId === current ? "→" : " ";
          const shortId = s.sessionId.length > 14 ? `${s.sessionId.slice(0, 12)}..` : s.sessionId;
          const time = s.lastAccessedAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          console.log(`${marker} ${String(i + 1).padEnd(4)} ${shortId.padEnd(16)} ${s.status.padEnd(10)} v${s.agentVersion.padEnd(4)} ${time}`);
        }
        console.log(`\nSwitch: /sessions <#>  Current: ${current.slice(0, 12)}..`);
      }
    } catch (error) {
      console.error(`✗ Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  console.log("Commands: /sessions [id], /session, /open, /export [dir], /quit, /help");
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

// Local session history — stores prompts per session in ~/.web-app-gen/history/
type HistoryEntry = { role: "user" | "assistant"; text: string; timestamp: string };

function historyPath(sessionId: string): string {
  return path.join(homedir(), ".web-app-gen", "history", `${sessionId}.jsonl`);
}

async function saveHistoryEntry(sessionId: string, entry: HistoryEntry): Promise<void> {
  const filePath = historyPath(sessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n");
}

async function loadHistory(sessionId: string): Promise<HistoryEntry[]> {
  try {
    const content = await readFile(historyPath(sessionId), "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as HistoryEntry);
  } catch {
    return [];
  }
}

function printHistory(entries: HistoryEntry[]): void {
  if (entries.length === 0) {
    console.log("ℹ No conversation history for this session.");
    return;
  }
  console.log("\n── Conversation History ──");
  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (entry.role === "user") {
      console.log(`\x1b[2m${time}\x1b[0m \x1b[36myou>\x1b[0m ${entry.text}`);
    } else {
      console.log(`\x1b[2m${time}\x1b[0m \x1b[33mbot>\x1b[0m ${entry.text}`);
    }
  }
  console.log("── End of History ──\n");
}

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || stdout || error.message));
      else resolve({ stdout, stderr });
    });
  });
}
