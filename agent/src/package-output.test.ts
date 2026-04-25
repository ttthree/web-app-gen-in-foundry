import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractStoredZip } from "@web-app-gen/contracts";
import { ensureValidAppZip } from "./package-output.js";

describe("ensureValidAppZip", () => {
  it("always recreates app.zip from current app files", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "web-app-gen-agent-"));
    try {
      const appDir = path.join(workspacePath, "output", "app");
      await mkdir(appDir, { recursive: true });
      await writeFile(path.join(appDir, "index.html"), "<h1>first</h1>");
      await ensureValidAppZip({ workspacePath, prompt: "first" });

      await writeFile(path.join(appDir, "index.html"), "<h1>second</h1>");
      await ensureValidAppZip({ workspacePath, prompt: "second" });

      const zip = await readFile(path.join(workspacePath, "output", "app.zip"));
      const files = extractStoredZip(zip);
      const index = files.find((file) => file.path === "index.html");
      expect(new TextDecoder().decode(index?.contents)).toBe("<h1>second</h1>");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("throws when output/app/index.html is missing", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "web-app-gen-agent-"));
    try {
      const appDir = path.join(workspacePath, "output", "app");
      await mkdir(appDir, { recursive: true });
      await writeFile(path.join(appDir, "styles.css"), "body{}");

      await expect(ensureValidAppZip({ workspacePath, prompt: "missing index" })).rejects.toThrow("Generated app must contain output/app/index.html");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
