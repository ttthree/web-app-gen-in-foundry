#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateZipBuffer } from "@web-app-gen/contracts";
import { downloadAndValidateAppZip } from "./download.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }

  if (command === "generate") {
    const prompt = rest.join(" ");
    if (!prompt) {
      console.error("Usage: web-app-gen generate <prompt>");
      process.exitCode = 1;
      return;
    }
    await runGenerate(prompt);
    return;
  }

  if (command === "download") {
    const sessionId = rest[0];
    const outDir = rest[1] ?? "./output";
    if (!sessionId) {
      console.error("Usage: web-app-gen download <session-id> [output-dir]");
      process.exitCode = 1;
      return;
    }
    await runDownload(sessionId, outDir);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exitCode = 1;
}

function printUsage(): void {
  console.log(`web-app-gen — Generate frontend-only static web apps via Foundry

Commands:
  generate <prompt>                    Generate a web app from a prompt
  download <session-id> [output-dir]   Download app.zip from a Foundry session
  help                                 Show this help

Requires: azd CLI with azure.ai.agents extension, authenticated via 'azd auth login'
`);
}

async function runGenerate(prompt: string): Promise<void> {
  console.log(`Generating web app: "${prompt}"`);
  console.log("Invoking Foundry hosted agent...\n");

  const { stdout, stderr } = await exec("azd", [
    "ai", "agent", "invoke",
    "--new-session",
    "--new-conversation",
    "--timeout", "300",
    "--no-prompt",
    prompt,
  ]);

  if (stderr) console.error(stderr);

  // Extract session ID from output
  const sessionMatch = stdout.match(/Session:\s+(\S+)\s+\(assigned by server\)/);
  if (!sessionMatch) {
    console.log(stdout);
    console.error("Could not extract session ID from invocation output.");
    process.exitCode = 1;
    return;
  }

  const sessionId = sessionMatch[1];
  console.log(`Session: ${sessionId}`);
  console.log("Generation complete. Downloading output...\n");

  await runDownload(sessionId, "./output");
}

async function runDownload(sessionId: string, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const zipPath = path.join(outDir, "app.zip");

  console.log(`Downloading output/app.zip from session ${sessionId}...`);
  await exec("azd", [
    "ai", "agent", "files", "download",
    "/output/app.zip",
    "--session-id", sessionId,
    "--target-path", zipPath,
    "--no-prompt",
  ]);

  const { readFile } = await import("node:fs/promises");
  const zipBytes = await readFile(zipPath);
  const validation = validateZipBuffer(zipBytes);

  if (!validation.ok) {
    console.error(`ZIP validation failed: ${validation.errors.join("; ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✓ Valid app.zip downloaded to ${zipPath} (${zipBytes.length} bytes)`);
  console.log(`  Open ${outDir}/app/index.html in a browser to preview.`);

  // Also extract the zip for convenience
  try {
    await exec("unzip", ["-o", zipPath, "-d", path.join(outDir, "app")]);
    console.log(`✓ Extracted to ${outDir}/app/`);
  } catch {
    console.log("  (unzip not available — extract manually)");
  }
}

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr || stdout || error.message;
        reject(new Error(`${cmd} failed: ${msg}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export { downloadAndValidateAppZip };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
