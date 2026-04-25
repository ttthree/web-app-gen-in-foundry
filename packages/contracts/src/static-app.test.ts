import { describe, expect, it } from "vitest";
import { validateStaticApp } from "./static-app.js";

describe("static app validation", () => {
  it("accepts local relative assets", () => {
    const result = validateStaticApp([
      { path: "index.html", content: '<link href="styles.css" rel="stylesheet"><script src="app.js"></script>' },
      { path: "styles.css", content: "body { color: black; }" },
      { path: "app.js", content: "document.body.dataset.ready = 'true';" },
    ]);

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects missing assets and network dependencies", () => {
    const result = validateStaticApp([
      { path: "index.html", content: '<script src="missing.js"></script><img src="https://example.com/a.png">' },
      { path: "app.js", content: "fetch('https://api.example.com')" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("missing local asset: missing.js");
    expect(result.errors).toContain("external asset is not allowlisted: https://example.com/a.png");
    expect(result.errors).toContain("unexpected network dependency in app.js");
  });
});
