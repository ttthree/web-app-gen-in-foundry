import { describe, expect, it } from "vitest";
import { createStoredZip, readZipEntries, sha256, validateManifest, validateZipBuffer, validateZipEntries } from "./artifact.js";

describe("artifact contract", () => {
  it("accepts a valid manifest", () => {
    const result = validateManifest({
      schemaVersion: "1.0",
      entrypoint: "index.html",
      generatedAt: new Date("2026-04-25T00:00:00.000Z").toISOString(),
      promptHash: sha256("pomodoro timer"),
      files: [{ path: "index.html", sizeBytes: 42, sha256: sha256("html") }],
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects unsafe and backend ZIP entries", () => {
    const result = validateZipEntries([
      { path: "../index.html", compressedSize: 1, uncompressedSize: 1 },
      { path: "package.json", compressedSize: 1, uncompressedSize: 1 },
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("ZIP must contain index.html at the root");
    expect(result.errors).toContain("unsafe ZIP path: ../index.html");
    expect(result.errors).toContain("forbidden ZIP entry: package.json");
  });

  it("parses and validates a central-directory ZIP fixture", () => {
    const zip = makeCentralDirectoryOnlyZip(["index.html", "manifest.json", "assets/app.js"]);

    expect(validateZipBuffer(zip)).toEqual({ ok: true, errors: [] });
  });

  it("creates a real stored ZIP that validates", () => {
    const zip = createStoredZip([
      { path: "index.html", contents: "<main>Hello</main>" },
      { path: "manifest.json", contents: "{}" },
    ]);

    expect(readZipEntries(zip).map((entry) => entry.path)).toEqual(["index.html", "manifest.json"]);
    expect(validateZipBuffer(zip)).toEqual({ ok: true, errors: [] });
  });
});

function makeCentralDirectoryOnlyZip(paths: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const records: Uint8Array[] = [];
  for (const path of paths) {
    const name = encoder.encode(path);
    const record = new Uint8Array(46 + name.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(28, name.length, true);
    record.set(name, 46);
    records.push(record);
  }

  const centralSize = records.reduce((sum, record) => sum + record.byteLength, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, paths.length, true);
  eocdView.setUint16(10, paths.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, 0, true);

  const zip = new Uint8Array(centralSize + eocd.byteLength);
  let offset = 0;
  for (const record of records) {
    zip.set(record, offset);
    offset += record.byteLength;
  }
  zip.set(eocd, offset);
  return zip;
}
