import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FoundrySessionRef, FoundrySessionsClient } from "@web-app-gen/contracts";
import { validateZipBuffer } from "@web-app-gen/contracts";

export type DownloadAppZipInput = {
  foundry: FoundrySessionsClient;
  session: FoundrySessionRef;
  outDir: string;
  sessionFilePath?: string;
};

export async function downloadAndValidateAppZip(input: DownloadAppZipInput): Promise<{ zipPath: string; bytes: Uint8Array }> {
  const sessionFilePath = input.sessionFilePath ?? "output/app.zip";
  const bytes = await input.foundry.downloadSessionFile({ session: input.session, path: sessionFilePath });
  const validation = validateZipBuffer(bytes);
  if (!validation.ok) {
    throw new Error(`Downloaded app ZIP failed validation: ${validation.errors.join("; ")}`);
  }

  await mkdir(input.outDir, { recursive: true });
  const zipPath = path.join(input.outDir, "app.zip");
  await writeFile(zipPath, bytes);
  return { zipPath, bytes };
}
