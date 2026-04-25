import { describe, expect, it } from "vitest";
import { createGuardedPermissionHandler, isAllowedShellCommand } from "./permission-guard.js";

describe("guarded permission handler", () => {
  const handler = createGuardedPermissionHandler({ workspacePath: "/workspace", skillsPath: "/app/skills" });

  it("allows reads from skills and writes only under output", async () => {
    await expect(handler({ kind: "read", path: "/app/skills/web-app-builder/SKILL.md" })).resolves.toEqual({ kind: "approve-once" });
    await expect(handler({ kind: "write", fileName: "output/app/index.html" })).resolves.toEqual({ kind: "approve-once" });
  });

  it("denies traversal, outside writes, network, and install commands", async () => {
    await expect(handler({ kind: "write", fileName: "../secret" })).resolves.toMatchObject({ kind: "reject" });
    await expect(handler({ kind: "url" })).resolves.toMatchObject({ kind: "reject" });
    expect(isAllowedShellCommand("npm install left-pad")).toBe(false);
    expect(isAllowedShellCommand("python3 -m http.server 8080")).toBe(false);
    expect(isAllowedShellCommand("mkdir -p output/app")).toBe(true);
  });
});
