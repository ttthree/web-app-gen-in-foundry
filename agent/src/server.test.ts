import { describe, expect, it } from "vitest";
import { resolveGitHubToken } from "./server.js";

describe("server GitHub token precedence", () => {
  it("uses body token before environment fallbacks", () => {
    expect(resolveGitHubToken({ github_token: "body" }, { COPILOT_GITHUB_TOKEN: "copilot", GITHUB_TOKEN: "github", GH_TOKEN: "gh" })).toBe("body");
  });

  it("falls back through COPILOT_GITHUB_TOKEN, GITHUB_TOKEN, then GH_TOKEN", () => {
    expect(resolveGitHubToken({}, { COPILOT_GITHUB_TOKEN: "copilot", GITHUB_TOKEN: "github", GH_TOKEN: "gh" })).toBe("copilot");
    expect(resolveGitHubToken({}, { GITHUB_TOKEN: "github", GH_TOKEN: "gh" })).toBe("github");
    expect(resolveGitHubToken({}, { GH_TOKEN: "gh" })).toBe("gh");
  });

  it("returns undefined when no token is available", () => {
    expect(resolveGitHubToken({}, {})).toBeUndefined();
  });
});
