import { describe, expect, it } from "vitest";
import { createStoredZip, createZip, extractStoredZip, extractZip, readZipEntries, sha256, validateManifest, validateZipBuffer, validateZipEntries } from "./artifact.js";

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

  it("extracts a stored ZIP round trip", () => {
    const zip = createStoredZip([
      { path: "index.html", contents: "<main>Hello</main>" },
      { path: "assets/app.js", contents: "console.log('ok')" },
      { path: "manifest.json", contents: "{}" },
    ]);

    expect(extractStoredZip(zip).map((file) => [file.path, new TextDecoder().decode(file.contents)])).toEqual([
      ["index.html", "<main>Hello</main>"],
      ["assets/app.js", "console.log('ok')"],
      ["manifest.json", "{}"],
    ]);
  });

  it("handles empty, single-file, and multi-file ZIPs", () => {
    expect(extractStoredZip(createStoredZip([]))).toEqual([]);
    expect(extractStoredZip(createStoredZip([{ path: "index.html", contents: "one" }])).map((file) => file.path)).toEqual(["index.html"]);
    expect(extractStoredZip(createStoredZip([{ path: "a.txt", contents: "a" }, { path: "dir/b.txt", contents: "b" }])).map((file) => file.path)).toEqual([
      "a.txt",
      "dir/b.txt",
    ]);
  });

  it("rejects unsupported compression methods", () => {
    const zip = createStoredZip([{ path: "index.html", contents: "hello" }]);
    const patched = zip.slice();
    new DataView(patched.buffer).setUint16(8, 5, true); // method 5 = unsupported
    expect(() => extractZip(patched)).toThrow("unsupported ZIP compression method: 5");
  });

  it("rejects unsafe local header paths", () => {
    const zip = createUnsafeLocalZip("../secret.txt", "secret");
    expect(() => extractStoredZip(zip)).toThrow("unsafe ZIP path");
  });

  it("creates a compressed ZIP that validates and extracts correctly", () => {
    const files = [
      { path: "index.html", contents: "<main>Hello World!</main>".repeat(100) },
      { path: "manifest.json", contents: "{}" },
    ];
    const zip = createZip(files);

    expect(readZipEntries(zip).map((entry) => entry.path)).toEqual(["index.html", "manifest.json"]);
    expect(validateZipBuffer(zip)).toEqual({ ok: true, errors: [] });

    // Compressed ZIP should be smaller than stored for repetitive content
    const storedZip = createStoredZip(files);
    expect(zip.byteLength).toBeLessThan(storedZip.byteLength);

    // Round-trip extraction
    const extracted = extractZip(zip);
    expect(extracted.map((file) => [file.path, new TextDecoder().decode(file.contents)])).toEqual([
      ["index.html", "<main>Hello World!</main>".repeat(100)],
      ["manifest.json", "{}"],
    ]);
  });

  it("extractZip handles both stored and compressed entries", () => {
    // Stored ZIP
    const storedZip = createStoredZip([{ path: "a.txt", contents: "stored" }]);
    expect(extractZip(storedZip).map((f) => new TextDecoder().decode(f.contents))).toEqual(["stored"]);

    // Compressed ZIP
    const compressedZip = createZip([{ path: "b.txt", contents: "compressed content ".repeat(50) }]);
    expect(extractZip(compressedZip).map((f) => new TextDecoder().decode(f.contents))).toEqual(["compressed content ".repeat(50)]);
  });
});

function createUnsafeLocalZip(entryPath: string, contents: string): Uint8Array {
  const encoder = new TextEncoder();
  const name = encoder.encode(entryPath);
  const data = encoder.encode(contents);
  const header = new Uint8Array(30 + name.byteLength + data.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(8, 0, true);
  view.setUint32(18, data.byteLength, true);
  view.setUint32(22, data.byteLength, true);
  view.setUint16(26, name.byteLength, true);
  header.set(name, 30);
  header.set(data, 30 + name.byteLength);
  const eocd = new Uint8Array(22);
  new DataView(eocd.buffer).setUint32(0, 0x06054b50, true);
  const zip = new Uint8Array(header.byteLength + eocd.byteLength);
  zip.set(header);
  zip.set(eocd, header.byteLength);
  return zip;
}

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
