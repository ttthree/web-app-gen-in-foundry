import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStoredZip } from "@web-app-gen/contracts";
import { injectRefreshScript, mimeFor, startPreviewServer, type PreviewServer } from "./preview-server.js";

let servers: PreviewServer[] = [];

afterEach(async () => {
  for (const server of servers) {
    await server.close().catch(() => undefined);
    await rm(server.rootDir, { recursive: true, force: true });
  }
  servers = [];
});

describe("preview server", () => {
  it("returns MIME types", () => {
    expect(mimeFor("index.html")).toBe("text/html");
    expect(mimeFor("styles.css")).toBe("text/css");
    expect(mimeFor("app.js")).toBe("application/javascript");
    expect(mimeFor("manifest.json")).toBe("application/json");
    expect(mimeFor("icon.svg")).toBe("image/svg+xml");
    expect(mimeFor("image.png")).toBe("image/png");
    expect(mimeFor("file.bin")).toBe("application/octet-stream");
  });

  it("injects refresh script into HTML", () => {
    expect(injectRefreshScript("<html><body>Hi</body></html>")).toContain("/__version");
    expect(injectRefreshScript("<main>Hi</main>")).toContain("/__version");
  });

  it("serves version endpoint and injected HTML with no-store", async () => {
    const server = await startPreviewServer(3001);
    servers.push(server);
    await server.updateFromZip(createStoredZip([{ path: "index.html", contents: "<html><body>Hi</body></html>" }]));

    const version = await fetch(`${server.url}/__version`);
    expect(await version.text()).toBe("1");
    expect(version.headers.get("cache-control")).toBe("no-store");

    const html = await fetch(`${server.url}/`);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("/__version");
  });

  it("falls back from default preview port when it is busy", async () => {
    const first = await startPreviewServer(3001);
    servers.push(first);
    const second = await startPreviewServer(3001);
    servers.push(second);

    expect(first.port).toBe(3001);
    expect(second.port).toBe(3002);
  });

  it("extracts ZIP updates and exports files", async () => {
    const server = await startPreviewServer(3001);
    servers.push(server);
    await server.updateFromZip(createStoredZip([{ path: "index.html", contents: "<h1>x</h1>" }]));
    const outDir = path.join(server.rootDir, "..", "exported-app");
    await server.exportTo(outDir);
    expect(await readFile(path.join(outDir, "index.html"), "utf8")).toBe("<h1>x</h1>");
  });
});
