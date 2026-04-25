# Design: Web App Generator on Microsoft Foundry Hosted Sessions

## Goals

- Build a v1 web app generator that creates frontend-only static web apps.
- Run the generator as a Microsoft Foundry hosted agent using the Responses protocol with hosted sessions.
- Use the latest GitHub Copilot SDK inside the hosted agent container as the core agent runtime.
- Load the Anthropic Web App Builder skill as a first-class Copilot SDK skill.
- Support product multi-user usage in v1 through GitHub App OAuth user authentication.
- Write generated artifacts into the Foundry hosted session sandbox and download them through session file APIs.
- Validate generated apps in CI by downloading the ZIP and running browser-based checks.

## Non-Goals

- No generated backend, database, server runtime, authentication service, or cloud resource in v1 outputs.
- No Invocations protocol for v1 artifact transport.
- No Base64 ZIP as the primary artifact path for v1 hosted sessions.
- No shared service-user Copilot token for product traffic.
- No strict deterministic/snapshot-equal generated output requirement.

## Architecture

```text
Product UI / CLI / CI
  ├─ Authenticates to product / Azure control plane
  ├─ Starts or resumes a Foundry hosted agent session
  ├─ Sends user prompt through Responses protocol
  └─ Downloads output/app.zip from hosted session files

Product Control Plane
  ├─ Handles GitHub App OAuth flow
  ├─ Stores per-user GitHub token material securely
  ├─ Maps product users to Foundry session IDs and isolation keys
  └─ Supplies short-lived user Copilot token material to hosted agent runtime

Foundry Hosted Agent Container
  ├─ Node/TypeScript Responses-compatible agent server
  ├─ @github/copilot-sdk latest
  ├─ /app/skills/web-app-builder/SKILL.md
  ├─ Runtime GitHub user token from GitHub App OAuth
  ├─ Copilot SDK session with skillDirectories: ["/app/skills"]
  └─ Writes generated app and output/app.zip into session sandbox
```

## Key Decisions

### Foundry Protocol

Use **Hosted Agent Sessions + Responses** for v1.

Rationale:

- Hosted sessions provide platform-managed session sandbox state.
- Responses is the supported hosted-session invocation path.
- Session file APIs can be used to download generated files from the sandbox.
- This matches the desired product behavior better than Invocations with inline Base64 payloads.

### Artifact Transport

The hosted agent writes files into the session workspace:

```text
output/
  app/
    index.html
    styles.css
    app.js
    assets/...
  manifest.json
  app.zip
```

The product client or CI downloads `output/app.zip` from the session using Foundry session file download APIs.

### Copilot SDK Packaging

The agent image includes:

- `@github/copilot-sdk@latest`
- The Node runtime and compiled TypeScript agent server
- The vendored Web App Builder skill under `/app/skills/web-app-builder`

For Node SDK usage, the Copilot CLI runtime is expected to be managed by the SDK package unless current SDK docs require a separate CLI install. As of the current public SDK checked during design, the package is `@github/copilot-sdk` and the session-level token option is `gitHubToken`.

### Copilot Authentication

Use a **GitHub App OAuth flow** for product users.

- Each product user authorizes the GitHub App.
- The product control plane stores token material securely.
- Each generation uses that user’s GitHub access token with Copilot SDK.
- Usage and entitlement are attributed to the authenticated Copilot-licensed user.

Do not rely on a GitHub App installation token for Copilot model access. Installation tokens are useful for repository API operations, but Copilot SDK model access should use a user token produced by GitHub App/OAuth authorization.

### Anthropic Web App Builder Skill

Vendor the skill into:

```text
agent/skills/web-app-builder/SKILL.md
```

Load and eagerly activate the skill via Copilot SDK:

```ts
const client = new CopilotClient({
  useLoggedInUser: false,
});

const session = await client.createSession({
  gitHubToken: userGitHubAccessToken,
  workingDirectory: foundrySessionWorkspace,
  skillDirectories: ["/app/skills"],
  customAgents: [
    {
      name: "web-app-builder-agent",
      prompt: "Generate frontend-only static web apps and write only under the output directory.",
      skills: ["web-app-builder"],
    },
  ],
  agent: "web-app-builder-agent",
  onPermissionRequest: guardedPermissionHandler,
});
```

The generation prompt must explicitly constrain the skill to frontend-only static output.

## API / Interface Design

### Concrete Adapter Boundaries

The repo should isolate external preview APIs behind small interfaces so unit tests do not depend on live Foundry or GitHub services.

```ts
type FoundrySessionRef = {
  sessionId: string;
  isolationKey: string;
  agentName: string;
};

interface FoundrySessionsClient {
  createOrResumeSession(input: { productUserId: string; isolationKey: string }): Promise<FoundrySessionRef>;
  createResponse(input: { session: FoundrySessionRef; prompt: string }): Promise<{ responseId: string; status: string }>;
  downloadSessionFile(input: { session: FoundrySessionRef; path: string }): Promise<Uint8Array>;
}

interface GitHubTokenBroker {
  getUserAccessToken(input: { productUserId: string }): Promise<{ accessToken: string; expiresAt?: string }>;
  refreshIfNeeded(input: { productUserId: string }): Promise<void>;
}
```

Live implementations will use the current Foundry hosted session Responses and session file APIs. Tests use in-memory mocks with the same interface.

### Foundry Hosted Session Flow

1. Control plane resolves the product user and GitHub token.
2. Control plane creates or resumes a Foundry hosted session using the user-specific `isolationKey`.
3. Control plane invokes the hosted agent through Responses with the hosted `sessionId` bound to the request.
4. Hosted agent runs Copilot SDK in the Foundry session workspace.
5. Hosted agent writes `output/manifest.json` and `output/app.zip`.
6. Client downloads `output/app.zip` through Foundry session file download.

The exact Azure SDK or REST method names are intentionally encapsulated in `FoundrySessionsClient` because hosted session APIs are preview and may change.

### Product Control Plane

Minimum v1 endpoints or commands:

- `GET /auth/github/start` — starts GitHub App OAuth authorization.
- `GET /auth/github/callback` — exchanges code for user token and stores it securely.
- `POST /sessions` — creates or resumes a Foundry hosted session for a product user.
- `POST /sessions/:sessionId/generate` — sends a generation prompt through Responses.
- `GET /sessions/:sessionId/files/output/app.zip` — downloads generated app ZIP through Foundry file APIs or a product proxy.
- `GET /sessions` — lists known product session mappings.

### Agent Prompt Contract

The control plane sends the hosted agent a structured prompt containing:

- User request
- Output directory
- Static-only constraints
- Required artifact paths
- Manifest requirements

Example instruction:

```text
Use the web-app-builder skill to generate a frontend-only static web app.

Rules:
- Write all generated app files under output/app.
- Create output/manifest.json.
- Create output/app.zip containing output/app and manifest.json.
- The app must run by opening index.html directly.
- Do not create a backend, server process, database, auth provider, or cloud dependency.
- Do not include tokens, secrets, or user auth data in generated files.
```

### Session Metadata

Persist lightweight mappings in the product control plane:

```ts
type ProductSession = {
  id: string;
  productUserId: string;
  githubUserId: string;
  foundrySessionId: string;
  isolationKey: string;
  agentName: string;
  agentVersion?: string;
  status: "created" | "running" | "completed" | "failed";
  lastPrompt?: string;
  lastManifestPath?: string;
  lastZipPath?: string;
  createdAt: string;
  updatedAt: string;
};
```

Foundry hosted session state remains the runtime/sandbox state. Product session mappings are still useful for cross-machine product UX and CI discoverability.

## Copilot SDK Contract

- Use `@github/copilot-sdk@latest` in `package.json`, with lockfile pinning from `npm install` for reproducible CI.
- Pass user identity through the session-level `gitHubToken` option.
- Construct `CopilotClient` with `useLoggedInUser: false` so container-local CLI login state is never used for product traffic.
- Set `workingDirectory` to the Foundry session workspace path exposed to session file operations.
- Set `skillDirectories` to the parent directory `/app/skills`.
- Eagerly load `web-app-builder` by configuring a custom agent with `skills: ["web-app-builder"]` and selecting that agent.
- Register a guarded permission handler instead of `approveAll`.

### Permission Guard

The permission handler must:

- Allow reads from `/app/skills` and the session workspace.
- Allow writes only under `output/` in the Foundry session workspace.
- Deny writes outside the workspace and deny path traversal.
- Deny commands that start servers, install arbitrary packages at runtime, access credentials, or write to home/config directories.
- Allow only the minimal shell commands needed for static app packaging, such as directory creation, file listing, and ZIP creation.
- Never log GitHub tokens, OAuth codes, refresh tokens, or Authorization headers.

## GitHub App OAuth Contract

- Use a GitHub App OAuth authorization flow that returns a user access token accepted by Copilot SDK.
- The user must have a GitHub Copilot entitlement; entitlement failures should return a reconnect/upgrade message.
- Store token material encrypted at rest, preferably with Key Vault-managed keys.
- Refresh token material before invocation when expiry is near.
- Pass only a short-lived access token to the hosted agent runtime.
- Do not include tokens in model prompts, generated files, session file outputs, logs, or error payloads.
- CI uses a dedicated test product user that authorizes the same GitHub App and has a Copilot entitlement.

## Artifact Contract

`output/manifest.json` schema:

```ts
type GeneratedAppManifest = {
  schemaVersion: "1.0";
  entrypoint: "index.html";
  generatedAt: string;
  promptHash: string;
  files: Array<{
    path: string;
    sizeBytes: number;
    sha256: string;
  }>;
};
```

ZIP contract:

- File path: `output/app.zip`.
- ZIP root contains `index.html`, app assets, and `manifest.json`.
- All ZIP entries must be relative paths with no absolute paths and no `..` segments.
- Max ZIP size defaults to 8 MiB in v1.
- Required entry: `index.html`.
- Forbidden entries: server/backend files such as `package.json`, `server.js`, `api/`, `.env`, `Dockerfile`, database files, and executable secrets/config.

## Static App Policy

- Local relative assets are allowed.
- Inline CSS/JS is allowed.
- CDN/fonts/images are denied by default for CI validation unless explicitly added to an allowlist.
- Analytics, auth, database, cloud API, and generated backend calls are denied.
- Playwright validation fails on unexpected browser network calls outside the local file/app origin.

## File Structure

```text
agent/
  Dockerfile
  package.json
  tsconfig.json
  src/
    server.ts
    copilot-runner.ts
    output-contract.ts
    zip.ts
  skills/
    README.md
    web-app-builder/
      SKILL.md

cli/
  package.json
  tsconfig.json
  src/
    index.ts
    foundry-sessions.ts
    download.ts
    validate-static-app.ts

control-plane/
  package.json
  tsconfig.json
  src/
    github-oauth.ts
    token-store.ts
    sessions.ts
    foundry.ts

infra/
  README.md
  agent.yaml

.github/workflows/
  ci.yml
```

## Edge Cases

- User has not connected GitHub App.
- User’s GitHub account lacks Copilot entitlement.
- GitHub token expired or refresh fails.
- Foundry session expired, deleted, or unavailable.
- Session file download fails or returns partial content.
- Copilot generates backend files despite constraints.
- Output ZIP is missing `index.html` or includes unsafe paths.
- Generated app references external APIs or unavailable assets.
- Generated app exceeds configured size limits.

## Acceptance Criteria

- Repo contains a documented v1 design and implementation plan.
- Agent image scaffold installs latest Copilot SDK and includes `skills/web-app-builder/SKILL.md`.
- Agent code demonstrates Copilot SDK session creation with per-user GitHub token and skill directory loading.
- Agent output contract requires `output/app.zip` and `output/manifest.json`.
- CLI/control-plane scaffold documents and models hosted session creation, generation, and file download.
- CI runs typecheck/tests and static contract tests.
- Tests validate generated ZIP structure without requiring deterministic file contents.

## Test Strategy

### Unit Tests

- `output-contract` validates required output paths and rejects backend/server artifacts.
- ZIP utility rejects path traversal and missing `index.html`.
- GitHub OAuth module validates callback errors and missing token responses.
- Session metadata module validates required Foundry session fields.
- Static app validator detects missing assets and forbidden backend dependencies.

### Integration Tests

- Agent runner constructs `CopilotClient` with `useLoggedInUser: false` and a Copilot session with `gitHubToken`.
- Agent runner creates a session with `skillDirectories` pointing at the parent skills directory.
- Skill packaging test asserts `agent/skills/web-app-builder/SKILL.md` exists.
- CLI download flow handles a mocked Foundry session file response and unpacks `app.zip`.

### E2E Tests

- In CI against a preview Foundry hosted agent:
  - Authenticate as a test product user connected through the GitHub App.
  - Create or resume a hosted session.
  - Generate apps for prompts such as `pomodoro timer`, `expense calculator`, and `tic tac toe`.
  - Download `output/app.zip` from session files.
  - Unzip each app.
  - Open `index.html` with Playwright.
  - Fail on missing assets, console errors, or network calls to unsupported backend endpoints.

### Error Path Tests

- Missing GitHub token returns an actionable authorization error.
- Copilot entitlement failure returns a user-facing reconnect/upgrade message.
- Foundry session missing returns a resumable-session error.
- Invalid ZIP output returns a validation failure and preserves session logs for debugging.
