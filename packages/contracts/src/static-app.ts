import type { ValidationResult } from "./artifact.js";

export type StaticAppFile = {
  path: string;
  content?: string;
};

const assetReferencePattern = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;

export function validateStaticApp(files: StaticAppFile[], allowlist: string[] = []): ValidationResult {
  const errors: string[] = [];
  const fileMap = new Map(files.map((file) => [file.path.replaceAll("\\", "/"), file]));

  if (!fileMap.has("index.html")) errors.push("static app must include index.html");

  for (const file of files) {
    const content = file.content ?? "";
    if (isScriptOrHtml(file.path) && hasForbiddenNetworkUse(content, allowlist)) {
      errors.push(`unexpected network dependency in ${file.path}`);
    }

    if (file.path === "index.html") {
      for (const reference of findAssetReferences(content)) {
        if (isExternalReference(reference)) {
          if (!allowlist.some((allowed) => reference.startsWith(allowed))) {
            errors.push(`external asset is not allowlisted: ${reference}`);
          }
          continue;
        }

        if (isLocalAssetReference(reference) && !fileMap.has(reference.replace(/^\.\//, ""))) {
          errors.push(`missing local asset: ${reference}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function findAssetReferences(content: string): string[] {
  return [...content.matchAll(assetReferencePattern)].map((match) => match[1]).filter(Boolean);
}

function hasForbiddenNetworkUse(content: string, allowlist: string[]): boolean {
  const matches = content.match(/https?:\/\/[^\s"')]+|\/\/[^\s"')]+|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/gi) ?? [];
  return matches.some((match) => {
    if (!match.includes("://") && !match.startsWith("//")) return true;
    return !allowlist.some((allowed) => match.startsWith(allowed));
  });
}

function isScriptOrHtml(path: string): boolean {
  return path.endsWith(".html") || path.endsWith(".js") || path.endsWith(".mjs");
}

function isExternalReference(reference: string): boolean {
  return /^https?:\/\//i.test(reference) || reference.startsWith("//");
}

function isLocalAssetReference(reference: string): boolean {
  return !reference.startsWith("#") && !reference.startsWith("data:") && !reference.startsWith("mailto:");
}
