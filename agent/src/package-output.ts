import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createZip, sha256, validateZipBuffer, type ZipFileInput } from "@web-app-gen/contracts";

export type PackageOutputInput = {
  workspacePath: string;
  prompt: string;
};

/**
 * Reads generated app files from output/app/, builds manifest.json,
 * and packages everything into a valid output/app.zip.
 * Always recreates app.zip so output never goes stale across turns.
 */
export async function ensureValidAppZip(input: PackageOutputInput) {
  const outputDir = path.join(input.workspacePath, "output");
  const appDir = path.join(outputDir, "app");
  const zipPath = path.join(outputDir, "app.zip");

  await rm(zipPath, { force: true });

  const appFiles = await readAppFiles(appDir);
  if (!appFiles.some((file) => file.path === "index.html")) {
    throw new Error("Generated app must contain output/app/index.html before packaging");
  }

  const manifest = await buildManifest(input.prompt, appDir, appFiles);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(outputDir, "manifest.json"), manifestText);

  const zip = createZip([...appFiles, { path: "manifest.json", contents: manifestText }]);
  const validation = validateZipBuffer(zip);
  if (!validation.ok) throw new Error(`Packaged app ZIP failed validation: ${validation.errors.join("; ")}`);

  await writeFile(zipPath, zip);
  return { zipPath, manifest };
}

async function buildManifest(prompt: string, appDir: string, knownFiles?: ZipFileInput[]) {
  const files = knownFiles ?? (await readAppFiles(appDir));
  return {
    schemaVersion: "1.0" as const,
    entrypoint: "index.html" as const,
    generatedAt: new Date().toISOString(),
    promptHash: sha256(prompt),
    files: files.map((file) => {
      const bytes = typeof file.contents === "string" ? new TextEncoder().encode(file.contents) : file.contents;
      return { path: file.path, sizeBytes: bytes.byteLength, sha256: sha256(bytes) };
    }),
  };
}

async function readAppFiles(appDir: string, prefix = ""): Promise<ZipFileInput[]> {
  const entries = await readdir(path.join(appDir, prefix), { withFileTypes: true });
  const files: ZipFileInput[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(appDir, relativePath);
    if (entry.isDirectory()) {
      files.push(...(await readAppFiles(appDir, relativePath)));
    } else if (entry.isFile() && (await stat(fullPath)).size > 0) {
      files.push({ path: relativePath, contents: await readFile(fullPath) });
    }
  }
  return files;
}
