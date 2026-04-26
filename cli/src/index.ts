#!/usr/bin/env node
import { downloadAndValidateAppZip } from "./download.js";
import { FoundryRestClient } from "./foundry-client.js";
import { getGitHubIdentity } from "./github-identity.js";
import { getFreshGitHubToken, resolveConfig, startRepl } from "./repl.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "chat") {
    const parsed = parseArgs(rest);
    await startRepl({ ...parsed.flags, sessionId: parsed.flags.session });
    return;
  }

  if (command === "help" || command === "--help") {
    printUsage();
    return;
  }

  if (command === "sessions") {
    await runListSessions(parseFlags(rest));
    return;
  }

  if (command === "generate") {
    const parsed = parseArgs(rest);
    const prompt = parsed.positionals.join(" ");
    if (!prompt) {
      console.error("Usage: web-app-gen generate <prompt>");
      process.exitCode = 1;
      return;
    }
    await runGenerate(prompt, parsed.flags);
    return;
  }

  if (command === "download") {
    const parsed = parseArgs(rest);
    const sessionId = parsed.positionals[0];
    const outDir = parsed.positionals[1] ?? "./output";
    if (!sessionId) {
      console.error("Usage: web-app-gen download <session-id> [output-dir]");
      process.exitCode = 1;
      return;
    }
    await runDownload(sessionId, outDir, parsed.flags);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exitCode = 1;
}

function printUsage(): void {
  console.log(`web-app-gen — Generate frontend-only static web apps via Foundry

Commands:
  chat                                Start interactive REPL (default)
  sessions                            List active Foundry sessions
  generate <prompt>                   Generate one web app from a prompt
  download <session-id> [output-dir]  Download app.zip from a Foundry session
  help                                Show this help

Options:
  --endpoint <url>                    Azure AI project endpoint
  --agent-name <name>                 Foundry hosted agent name
  --session <id>                      Resume an existing session
  --port <port>                       Preview port, fallback 3001-3010
`);
}

async function runDownload(sessionId: string, outDir: string, flags: CliFlags = {}): Promise<void> {
  const config = await resolveConfig(flags);
  const foundry = new FoundryRestClient(config);
  const session = { sessionId, isolationKey: "", agentName: config.agentName };
  const { zipPath, bytes } = await downloadAndValidateAppZip({ foundry, session, outDir });
  console.log(`✓ Valid app.zip downloaded to ${zipPath} (${bytes.length} bytes)`);
}

async function runListSessions(flags: CliFlags = {}): Promise<void> {
  const config = await resolveConfig(flags);
  const foundry = new FoundryRestClient(config);
  const sessions = await foundry.listSessions({ agentName: config.agentName });
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }
  console.log(`\n  ${"#".padEnd(4)} ${"Session ID".padEnd(52)} ${"Status".padEnd(10)} ${"Ver".padEnd(5)} ${"Last Accessed"}`);
  console.log(`  ${"─".repeat(4)} ${"─".repeat(52)} ${"─".repeat(10)} ${"─".repeat(5)} ${"─".repeat(20)}`);
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const time = s.lastAccessedAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    console.log(`  ${String(i + 1).padEnd(4)} ${s.sessionId.padEnd(52)} ${s.status.padEnd(10)} v${s.agentVersion.padEnd(4)} ${time}`);
  }
  console.log(`\n${sessions.length} session(s). Resume with: web-app-gen --session <session-id>`);
}

async function runGenerate(prompt: string, flags: { endpoint?: string; agentName?: string; previewPort?: number }): Promise<void> {
  const config = await resolveConfig(flags);
  const githubToken = await getFreshGitHubToken();
  const identity = await getGitHubIdentity(githubToken);
  const foundry = new FoundryRestClient(config);
  const session = await foundry.createSession({ agentName: config.agentName, isolationKey: `github:${identity.id}` });
  console.log(`Session: ${session.sessionId}`);
  const response = await foundry.createResponseStreaming({
    agentName: session.agentName,
    sessionId: session.sessionId,
    prompt,
    githubToken,
    onProgress: (event) => {
      if (event.type === "intent") console.log(`🤔 ${event.message}`);
      else if (event.type === "tool_start") process.stdout.write(`🔧 ${event.message}...`);
      else if (event.type === "tool_complete") process.stdout.write(" ✓\n");
      else if (event.type === "status") console.log(`⏳ ${event.message}`);
    },
  });
  if (response.status !== "completed") throw new Error(response.outputText ?? `Generation did not complete: ${response.status}`);
  const { zipPath, bytes } = await downloadAndValidateAppZip({ foundry, session, outDir: "./output" });
  console.log(`✓ Valid app.zip downloaded to ${zipPath} (${bytes.length} bytes)`);
}

type CliFlags = { endpoint?: string; agentName?: string; previewPort?: number; session?: string };

function parseFlags(args: string[]): CliFlags {
  return parseArgs(args).flags;
}

function parseArgs(args: string[]): { flags: CliFlags; positionals: string[] } {
  const flags: CliFlags = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--endpoint") {
      flags.endpoint = args[index + 1];
      index += 1;
    } else if (arg === "--agent-name") {
      flags.agentName = args[index + 1];
      index += 1;
    } else if (arg === "--port") {
      flags.previewPort = Number(args[index + 1]);
      index += 1;
    } else if (arg === "--session") {
      flags.session = args[index + 1];
      index += 1;
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

export { downloadAndValidateAppZip, getFreshGitHubToken };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
