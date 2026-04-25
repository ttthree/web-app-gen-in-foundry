import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile, mkdir, cp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractStoredZip, type ExtractedFile } from "@web-app-gen/contracts";

export type PreviewServer = {
  url: string;
  rootDir: string;
  port: number;
  version: number;
  updateFromZip(zip: Uint8Array): Promise<{ files: ExtractedFile[] }>;
  exportTo(outDir: string): Promise<void>;
  close(): Promise<void>;
};

const refreshScript = `<script>
(function(){let v=0;setInterval(async()=>{try{const r=await fetch('/__version');const nv=+(await r.text());if(v&&nv!==v)location.reload();v=nv;}catch{}},500);})();
</script>`;

export async function startPreviewServer(preferredPort = 3001): Promise<PreviewServer> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "web-app-gen-preview-"));
  let version = 0;
  const server = createServer(async (request, response) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/__version") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(String(version));
        return;
      }

      const relativePath = safeRequestPath(url.pathname);
      if (!relativePath) {
        response.writeHead(400);
        response.end("Bad request");
        return;
      }
      const filePath = path.join(rootDir, relativePath === "." ? "index.html" : relativePath);
      const fileStat = await stat(filePath).catch(() => undefined);
      if (!fileStat?.isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      const mimeType = mimeFor(filePath);
      response.setHeader("content-type", mimeType);
      if (mimeType === "text/html") {
        const html = await import("node:fs/promises").then((fs) => fs.readFile(filePath, "utf8"));
        response.end(injectRefreshScript(html));
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  const port = await listenWithFallback(server, preferredPort);

  return {
    get url() {
      return `http://localhost:${port}`;
    },
    rootDir,
    port,
    get version() {
      return version;
    },
    async updateFromZip(zip: Uint8Array) {
      const files = extractStoredZip(zip);
      await rm(rootDir, { recursive: true, force: true });
      await mkdir(rootDir, { recursive: true });
      for (const file of files) {
        const target = path.join(rootDir, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.contents);
      }
      version += 1;
      return { files };
    },
    async exportTo(outDir: string) {
      await rm(outDir, { recursive: true, force: true });
      await mkdir(outDir, { recursive: true });
      await cp(rootDir, outDir, { recursive: true });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function injectRefreshScript(html: string): string {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${refreshScript}</body>`) : `${html}${refreshScript}`;
}

export function mimeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html";
  if (extension === ".css") return "text/css";
  if (extension === ".js") return "application/javascript";
  if (extension === ".json") return "application/json";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  return "application/octet-stream";
}

function safeRequestPath(pathname: string): string | undefined {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("..") || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function listenWithFallback(server: Server, preferredPort: number): Promise<number> {
  const ports = preferredPort === 3001 ? Array.from({ length: 10 }, (_, index) => 3001 + index) : [preferredPort];
  return new Promise((resolve, reject) => {
    const tryPort = (index: number) => {
      const port = ports[index];
      if (!port) {
        reject(new Error("No preview ports available in range 3001-3010"));
        return;
      }
      const onError = () => {
        server.off("listening", onListening);
        tryPort(index + 1);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };
    tryPort(0);
  });
}
