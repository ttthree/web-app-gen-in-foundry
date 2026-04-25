# Skills

This directory is mounted into the hosted agent image at `/app/skills` and passed to the GitHub Copilot SDK through `skillDirectories`.

## `web-app-builder`

`web-app-builder/SKILL.md` is currently a placeholder stub for the Anthropic Web App Builder skill. Replace the folder with the approved external skill contents before building a production image.

Replacement checklist:

1. Preserve the directory name `web-app-builder` so `customAgents.skills: ["web-app-builder"]` resolves correctly.
2. Keep `SKILL.md` at the skill root.
3. Re-run the package tests to confirm the skill packaging check still passes.
4. Verify the vendored license/source metadata before claiming the full skill is included.
