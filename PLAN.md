# Plan: web-app-gen-in-foundry

This plan intentionally follows `design.md` as the source of truth.

## V1 Direction

- Use Microsoft Foundry hosted agent sessions with the Responses protocol.
- Use the latest GitHub Copilot SDK inside the hosted agent image.
- Authenticate each product user through a GitHub App OAuth user token.
- Load the Anthropic Web App Builder skill through Copilot SDK skill directories.
- Generate frontend-only static apps into the hosted session sandbox.
- Download `output/app.zip` through Foundry hosted session file APIs.
- Validate generated apps in CI by downloading the ZIP and opening `index.html` in Playwright.

## Implementation Order

1. Bootstrap the TypeScript monorepo scaffold.
2. Add shared output-contract and validation modules.
3. Add the hosted-agent Copilot runner scaffold.
4. Add a placeholder Web App Builder skill package location.
5. Add product control-plane OAuth/session abstractions.
6. Add CLI commands for generate/session/download flows.
7. Add unit/integration tests around contracts and adapter boundaries.
8. Add CI for typecheck and tests.

See `design.md` for architecture, interfaces, auth, artifact contracts, and test strategy.
