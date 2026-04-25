import { createHash } from "node:crypto";

export const DEFAULT_MAX_ZIP_BYTES = 8 * 1024 * 1024;

export type GeneratedAppManifest = {
  schemaVersion: "1.0";
  entrypoint: "index.html";
  generatedAt: string;
  promptHash: string;
  files: Array<{
    path: string;
    sizeBytes: number;
    sha256: string;
  }>;
};

export type ZipEntry = {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
};

export type ExtractedFile = {
  path: string;
  contents: Uint8Array;
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

const forbiddenExactNames = new Set([
  ".env",
  "dockerfile",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "server.js",
  "server.ts",
]);

const forbiddenExtensions = new Set([".sqlite", ".sqlite3", ".db", ".pem", ".key", ".p12", ".pfx"]);

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function validateManifest(value: unknown): ValidationResult {
  const errors: string[] = [];

  if (!value || typeof value !== "object") {
    return { ok: false, errors: ["manifest must be an object"] };
  }

  const manifest = value as Partial<GeneratedAppManifest>;
  if (manifest.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
  if (manifest.entrypoint !== "index.html") errors.push("entrypoint must be index.html");
  if (!manifest.generatedAt || Number.isNaN(Date.parse(manifest.generatedAt))) {
    errors.push("generatedAt must be an ISO date string");
  }
  if (!manifest.promptHash || !/^[a-f0-9]{64}$/i.test(manifest.promptHash)) {
    errors.push("promptHash must be a SHA-256 hex string");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push("files must be a non-empty array");
  } else {
    for (const file of manifest.files) {
      if (!isRecord(file)) {
        errors.push("each file entry must be an object");
        continue;
      }
      if (!isSafeRelativePath(String(file.path ?? ""))) errors.push(`invalid file path: ${String(file.path ?? "")}`);
      if (!Number.isInteger(file.sizeBytes) || Number(file.sizeBytes) < 0) {
        errors.push(`invalid size for ${String(file.path ?? "<unknown>")}`);
      }
      if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
        errors.push(`invalid sha256 for ${String(file.path ?? "<unknown>")}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateZipEntries(entries: ZipEntry[], maxBytes = DEFAULT_MAX_ZIP_BYTES): ValidationResult {
  const errors: string[] = [];
  const entryPaths = new Set(entries.map((entry) => normalizeZipPath(entry.path)));

  if (!entryPaths.has("index.html")) errors.push("ZIP must contain index.html at the root");
  if (!entryPaths.has("manifest.json")) errors.push("ZIP must contain manifest.json at the root");

  let totalUncompressedSize = 0;
  for (const entry of entries) {
    const normalizedPath = normalizeZipPath(entry.path);
    totalUncompressedSize += entry.uncompressedSize;

    if (!isSafeRelativePath(normalizedPath)) errors.push(`unsafe ZIP path: ${entry.path}`);
    if (isForbiddenArtifactPath(normalizedPath)) errors.push(`forbidden ZIP entry: ${normalizedPath}`);
  }

  if (totalUncompressedSize > maxBytes) {
    errors.push(`ZIP uncompressed size exceeds ${maxBytes} bytes`);
  }

  return { ok: errors.length === 0, errors };
}

export function validateZipBuffer(zip: Uint8Array, maxBytes = DEFAULT_MAX_ZIP_BYTES): ValidationResult {
  if (zip.byteLength > maxBytes) {
    return { ok: false, errors: [`ZIP size exceeds ${maxBytes} bytes`] };
  }

  try {
    return validateZipEntries(readZipEntries(zip), maxBytes);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "invalid ZIP"] };
  }
}

export function readZipEntries(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) throw new Error("invalid ZIP: missing end of central directory");

  const centralDirectoryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  if (centralDirectoryOffset + centralDirectorySize > zip.byteLength) {
    throw new Error("invalid ZIP: central directory out of range");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < centralDirectoryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("invalid ZIP: bad central directory header");
    }

    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > zip.byteLength) throw new Error("invalid ZIP: entry name out of range");

    entries.push({
      path: new TextDecoder().decode(zip.subarray(nameStart, nameEnd)),
      compressedSize,
      uncompressedSize,
    });
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

export function extractStoredZip(zip: Uint8Array): ExtractedFile[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const files: ExtractedFile[] = [];
  let offset = 0;

  while (offset + 4 <= zip.byteLength) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) throw new Error("invalid ZIP: bad local file header");
    if (offset + 30 > zip.byteLength) throw new Error("invalid ZIP: local header out of range");

    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);

    if (flags & 0x08) throw new Error("unsupported ZIP: data descriptors are not supported");
    if (method !== 0) throw new Error(`unsupported ZIP compression method: ${method}`);
    if (compressedSize !== uncompressedSize) throw new Error("invalid ZIP: stored entry size mismatch");

    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (nameEnd > zip.byteLength || dataStart > zip.byteLength || dataEnd > zip.byteLength) {
      throw new Error("invalid ZIP: local entry out of range");
    }

    const entryPath = normalizeZipPath(new TextDecoder().decode(zip.subarray(nameStart, nameEnd)));
    if (entryPath.endsWith("/")) {
      offset = dataEnd;
      continue;
    }
    if (!isSafeRelativePath(entryPath)) throw new Error(`unsafe ZIP path: ${entryPath}`);
    files.push({ path: entryPath, contents: zip.slice(dataStart, dataEnd) });
    offset = dataEnd;
  }

  return files;
}

export type ZipFileInput = {
  path: string;
  contents: Uint8Array | string;
};

export function createStoredZip(files: ZipFileInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const normalizedPath = normalizeZipPath(file.path);
    if (!isSafeRelativePath(normalizedPath)) throw new Error(`unsafe ZIP path: ${file.path}`);

    const name = encoder.encode(normalizedPath);
    const contents = typeof file.contents === "string" ? encoder.encode(file.contents) : file.contents;
    const crc = crc32(contents);

    const localHeader = new Uint8Array(30 + name.byteLength + contents.byteLength);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, contents.byteLength, true);
    localView.setUint32(22, contents.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localHeader.set(name, 30);
    localHeader.set(contents, 30 + name.byteLength);
    localParts.push(localHeader);

    const centralHeader = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, contents.byteLength, true);
    centralView.setUint32(24, contents.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(name, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.byteLength;
  }

  const localSize = localParts.reduce((sum, part) => sum + part.byteLength, 0);
  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, localSize, true);

  const zip = new Uint8Array(localSize + centralSize + eocd.byteLength);
  let offset = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    zip.set(part, offset);
    offset += part.byteLength;
  }
  return zip;
}

export function isSafeRelativePath(path: string): boolean {
  const normalizedPath = normalizeZipPath(path);
  if (!normalizedPath || normalizedPath.startsWith("/") || normalizedPath.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(normalizedPath)) return false;
  return !normalizedPath.split("/").some((segment) => segment === ".." || segment === "");
}

export function isForbiddenArtifactPath(path: string): boolean {
  const normalizedPath = normalizeZipPath(path).toLowerCase();
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (forbiddenExactNames.has(basename)) return true;
  if (normalizedPath.startsWith("api/") || normalizedPath.includes("/api/")) return true;
  return [...forbiddenExtensions].some((extension) => basename.endsWith(extension));
}

function normalizeZipPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
