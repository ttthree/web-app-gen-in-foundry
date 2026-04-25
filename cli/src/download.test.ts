import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryFoundrySessionsClient } from "@web-app-gen/contracts";
import { downloadAndValidateAppZip } from "./download.js";

describe("CLI download flow", () => {
  it("downloads output/app.zip through FoundrySessionsClient and validates it", async () => {
    const foundry = new InMemoryFoundrySessionsClient();
    const session = await foundry.createOrResumeSession({ productUserId: "user-1", isolationKey: "iso-1" });
    const zip = makeCentralDirectoryOnlyZip(["index.html", "manifest.json"]);
    foundry.putSessionFile(session, "output/app.zip", zip);
    const outDir = await mkdtemp(path.join(tmpdir(), "web-app-gen-"));

    try {
      const result = await downloadAndValidateAppZip({ foundry, session, outDir });
      expect(result.zipPath).toBe(path.join(outDir, "app.zip"));
      expect(await readFile(result.zipPath)).toEqual(Buffer.from(zip));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
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

  const zip = new Uint8Array(centralSize + eocd.byteLength);
  let offset = 0;
  for (const record of records) {
    zip.set(record, offset);
    offset += record.byteLength;
  }
  zip.set(eocd, offset);
  return zip;
}
