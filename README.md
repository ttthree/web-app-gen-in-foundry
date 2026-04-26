# web-app-gen-in-foundry

TypeScript scaffold for a Microsoft Foundry hosted-session Responses web app generator.

The approved v1 design is in `design.md`; `PLAN.md` intentionally follows that document as the source of truth.

## Field Report

A shareable report on the Foundry hosted-agent developer experience is published from `docs/index.html` through GitHub Pages. After the Pages workflow runs on `main`, it is available at:

https://ttthree.github.io/web-app-gen-in-foundry/

## Packages

- `agent` — hosted-agent scaffold using `@github/copilot-sdk`, per-session `gitHubToken`, `skillDirectories`, a selected custom agent, and a guarded permission handler.
- `cli` — CLI/download scaffold that validates `output/app.zip` from a `FoundrySessionsClient` boundary.
- `control-plane` — GitHub App OAuth, token-store, product-session, and Foundry adapter abstractions.
- `packages/contracts` — shared manifest, ZIP, static-app, GitHub token broker, and Foundry session contracts.

## Skill Placeholder

`agent/skills/web-app-builder/SKILL.md` is a placeholder stub only. Replace `agent/skills/web-app-builder/` with the approved Anthropic Web App Builder skill before production deployment.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Try Locally

Run the hosted-agent HTTP surface in mock mode. This exercises the same `/responses` shape and session-file download path without requiring Foundry or a GitHub Copilot token.

```bash
pnpm --filter @web-app-gen/agent build
WEB_APP_GEN_MODE=mock WEB_APP_GEN_WORKSPACE=/tmp/web-app-gen-try PORT=8099 node agent/dist/server.js
```

In another shell:

```bash
curl -fsS http://localhost:8099/health
curl -fsS -X POST http://localhost:8099/responses \
  -H 'content-type: application/json' \
  -d '{"input":{"messages":[{"role":"user","content":"build a pomodoro timer"}]}}'
curl -fsS 'http://localhost:8099/files?path=output/app.zip' -o app.zip
unzip -l app.zip
```

## Try With Docker

```bash
docker build -f agent/Dockerfile -t web-app-gen-agent:local .
docker run --rm --name web-app-gen-agent-local -p 8100:8088 \
  -e WEB_APP_GEN_MODE=mock \
  web-app-gen-agent:local
```

In another shell:

```bash
curl -fsS -X POST http://localhost:8100/responses \
  -H 'content-type: application/json' \
  -d '{"input":"build a tic tac toe app"}'
curl -fsS 'http://localhost:8100/files?path=output/app.zip' -o app.zip
unzip -l app.zip
```

## Foundry Deployment Status

The container image is now locally deployable, but cloud deployment still needs the Foundry hosted-agent deployment toolchain and environment-specific values:

- Azure Developer CLI (`azd`) 1.24+ with `azure.ai.agents` extension 0.1.27-preview or later.
- A Microsoft Foundry project in a hosted-agents-supported region.
- An Azure Container Registry or azd-managed registry path.
- A real hosted-agent `agent.yaml`/`azure.yaml` generated or confirmed against the current Foundry preview schema.
- GitHub App OAuth token-broker wiring for product users.

The currently discovered project is `foundry-test-jie/proj-default` in `swedencentral`; current public hosted-agent docs call out North Central US for the preview, so verify region availability before attempting Foundry deployment there.
