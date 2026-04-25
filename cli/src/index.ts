#!/usr/bin/env node
import { InMemoryFoundrySessionsClient } from "@web-app-gen/contracts";
import { downloadAndValidateAppZip } from "./download.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log("web-app-gen scaffold commands: generate, download");
    return;
  }

  if (command === "download") {
    throw new Error("Live Foundry download is implemented behind FoundrySessionsClient; use product wiring or tests with a concrete client.");
  }

  if (command === "generate") {
    throw new Error("Live generation requires Foundry hosted session wiring and GitHub App OAuth token broker.");
  }

  throw new Error(`Unknown command: ${command}`);
}

export { downloadAndValidateAppZip, InMemoryFoundrySessionsClient };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
