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

// See "Contracts Update" section below for the current FoundrySessionsClient interface.
// The CLI calls Foundry REST APIs directly; the control-plane GitHubTokenBroker
// is replaced by per-request `gh auth token` in the CLI.
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

## CLI REPL and Direct Foundry API

### Motivation

The CLI must call Foundry REST APIs directly instead of wrapping `azd ai agent invoke` (a dev/debug tool). This enables:
- Per-request GitHub token passing (tokens expire, can't bake into env vars)
- User session isolation via Foundry isolation keys
- Multi-turn REPL chat with live preview

### CLI Architecture

```text
CLI REPL
  ├─ gh auth token → fresh GitHub token (per request)
  ├─ GET https://api.github.com/user → derive isolation key (github:<id>)
  ├─ az account get-access-token → Azure AD Bearer token for Foundry API
  ├─ POST /agents/{name}/endpoint/sessions → create isolated session
  ├─ POST /agents/{name}/endpoint/protocols/openai/responses → multi-turn chat
  ├─ GET /agents/{name}/endpoint/sessions/{sid}/files/content → download output
  └─ Local preview server (localhost) with auto-refresh
```

### Foundry REST API Contract

```text
BASE = https://{account}.services.ai.azure.com/api/projects/{project}
API_VERSION = v1
Headers: Foundry-Features: HostedAgents=V1Preview
Auth: Bearer <azure-ad-token> (resource: https://ai.azure.com)

# Create session
POST {BASE}/agents/{name}/endpoint/sessions?api-version={API_VERSION}
Header: x-session-isolation-key: github:<id>
Body: {}
Response: { "agent_session_id": "...", "status": "..." }

# Invoke via Responses API
POST {BASE}/agents/{name}/endpoint/protocols/openai/responses?api-version={API_VERSION}
Body: { "input": "...", "stream": false, "agent_session_id": "<session-id>", "github_token": "<token>" }
Response: { "id": "resp_...", "output": [...], "output_text": "...", "status": "completed" }

# List session files
GET {BASE}/agents/{name}/endpoint/sessions/{sid}/files?api-version={API_VERSION}&path=output
Response: { "entries": [{ "name": "app.zip", "size": 1234, "is_dir": false }, ...] }

# Download session file
GET {BASE}/agents/{name}/endpoint/sessions/{sid}/files/content?api-version={API_VERSION}&path=output/app.zip
Response: binary file content
```

### Per-Request GitHub Token

The agent server accepts `github_token` in the Responses request body alongside `input`:

```ts
// POST /responses body
{
  "input": "build a calculator",
  "agent_session_id": "abc123",
  "github_token": "gho_xxxx"   // per-request, fresh token
}
```

The agent server reads `github_token` from the request body first, falls back to `COPILOT_GITHUB_TOKEN` env var. This keeps backward compatibility with Foundry portal invocations while enabling per-request tokens from the CLI.

**Token freshness policy:** The CLI calls `gh auth token` **before each `POST /responses`** call, not once per session. This ensures the token is always fresh even in long REPL sessions. The agent server must never log, persist, or include the token in error payloads.

Agent server token precedence (in `server.ts`):
1. `body.github_token` (from request body)
2. `process.env.COPILOT_GITHUB_TOKEN`
3. `process.env.GITHUB_TOKEN`
4. `process.env.GH_TOKEN`
5. If none → return 401 `missing_copilot_auth`

### Session Isolation

Each CLI user gets isolated sessions via Foundry isolation keys:

1. CLI calls `GET https://api.github.com/user` with the GitHub token
2. Uses the GitHub `user.id` (numeric, stable) as isolation key, prefixed: `github:<id>`
3. Creates Foundry session with `x-session-isolation-key: github:<id>`
4. All subsequent requests use the same `agent_session_id`
5. Different users get different sandboxes — can't see each other's sessions/files

### CLI Configuration

The CLI reads configuration from the following sources (in order of precedence):

1. **CLI flags** (e.g., `--endpoint`, `--agent-name`, `--port`)
2. **Environment variables:**
   - `AZURE_AI_PROJECT_ENDPOINT` — full project endpoint URL (e.g., `https://foundry-test-jie-ncu.services.ai.azure.com/api/projects/proj-default`)
   - `WEB_APP_GEN_AGENT_NAME` — agent name (default: `web-app-gen-in-foundry`)
   - `WEB_APP_GEN_PREVIEW_PORT` — local preview server port (default: `3001`)
   - `FOUNDRY_API_VERSION` — API version (default: `v1`)
3. **azd environment** — if env vars are not set, CLI runs `azd env get-values` to read `AZURE_AI_PROJECT_ENDPOINT` from the azd environment

The CLI derives `{account}` and `{project}` by parsing the endpoint URL:
```
https://{account}.services.ai.azure.com/api/projects/{project}
→ account = foundry-test-jie-ncu, project = proj-default
```

### CLI Prerequisites

The CLI requires:
- `gh` — GitHub CLI, authenticated (`gh auth login`)
- `az` — Azure CLI, authenticated (`az login`)
- The user must have `Azure AI User` role on the Foundry project
- The user's GitHub account must have a Copilot entitlement

On startup, the CLI validates each prerequisite and prints actionable errors:
```
✗ GitHub CLI not found. Install: https://cli.github.com
✗ Not logged in to Azure. Run: az login
✗ AZURE_AI_PROJECT_ENDPOINT not set. Run: azd env get-values or set the env var.
```

### Multi-Turn Behavior

Each REPL turn creates a **new Copilot SDK session** on the agent server, but reuses the **same Foundry hosted session** (same `agent_session_id`). This means:

- **Workspace files persist** across turns — the Foundry session sandbox filesystem is stateful
- **Copilot SDK context does NOT persist** — each turn starts fresh, but Copilot can read/modify files left by previous turns
- The generation prompt tells Copilot: "Modify the existing app in output/app/ based on the user request. If no app exists yet, create one from scratch."
- Multi-turn works because Copilot reads the existing `output/app/` files, understands the current app state, and makes incremental changes

Updated generation prompt for multi-turn:
```text
Use the web-app-builder skill to generate or update a frontend-only static web app.

Rules:
- Read existing files in output/app/ if present — modify them to fulfill the user request.
- If no files exist yet, create a new app from scratch.
- Write all app files under output/app.
- The app must run by opening index.html directly in a browser.
- Do not create output/app.zip — the server will package the files.
- Do not create a backend, server process, database, auth provider, or cloud dependency.
- Do not include tokens, secrets, or user auth data in generated files.

User request:
{userRequest}
```

### ZIP Repackaging on Every Turn

`agent/src/package-output.ts:ensureValidAppZip()` must **always repackage** on each `/responses` call, not skip when a valid ZIP exists. Delete any existing `output/app.zip` before repackaging to ensure the downloaded ZIP reflects the latest files.

### Contracts Update

Update `packages/contracts/src/foundry.ts` to model the new API surface:

```ts
interface FoundrySessionsClient {
  createSession(input: {
    agentName: string;
    isolationKey: string;
  }): Promise<{ sessionId: string; status: string }>;

  createResponse(input: {
    agentName: string;
    sessionId: string;
    prompt: string;
    githubToken: string;
  }): Promise<{
    responseId: string;
    status: string;
    outputText: string;
    error?: { code: string; message: string };
  }>;

  downloadSessionFile(input: {
    agentName: string;
    sessionId: string;
    path: string;
  }): Promise<Uint8Array>;

  listSessionFiles(input: {
    agentName: string;
    sessionId: string;
    path: string;
  }): Promise<Array<{ name: string; size: number; isDir: boolean }>>;
}
```

### Preview Server Details

- **Port**: defaults to 3001, configurable via `--port` or `WEB_APP_GEN_PREVIEW_PORT`
- **Port conflict**: if port is busy, try ports 3002-3010, then fail with error
- **Browser open**: uses `open` (macOS), `xdg-open` (Linux), `start` (Windows) via `child_process.exec`
- **MIME types**: serve `.html` as `text/html`, `.css` as `text/css`, `.js` as `application/javascript`, `.json` as `application/json`, `.svg` as `image/svg+xml`, `.png` as `image/png`, others as `application/octet-stream`
- **Auto-refresh injection**: inject the polling script before `</body>` if present, or append to end of HTML response if `</body>` not found
- **Cache headers**: `Cache-Control: no-store` on all responses to prevent stale previews
- **ZIP extraction**: use new `extractStoredZip()` from contracts (see below). Extract to a fixed temp directory (`os.tmpdir()/web-app-gen-preview/`), overwriting on each turn. Before extracting, delete all existing files in the temp dir to avoid stale files from previous turns.

### ZIP Content Extraction

Add `extractStoredZip()` to `packages/contracts/src/artifact.ts`:

```ts
export type ExtractedFile = {
  path: string;
  contents: Uint8Array;
};

export function extractStoredZip(zip: Uint8Array): ExtractedFile[] {
  // Read local file headers (0x04034b50) sequentially.
  // For stored entries (compression method 0), file data immediately follows the
  // local header (30 bytes) + filename + extra field.
  // Returns all non-directory entries with their raw content.
  // Throws on compressed entries (method != 0), since we only create stored ZIPs.
  // Validates: safe relative paths (reuse isSafeRelativePath), no path traversal.
}
```

This works because `createStoredZip()` always writes method=0 (stored) entries with no compression and no data descriptor. The local header layout is fixed:
- Bytes 0-3: signature 0x04034b50
- Bytes 8-9: compression method (must be 0)
- Bytes 18-21: compressed size (== uncompressed size for stored)
- Bytes 26-27: filename length
- Bytes 28-29: extra field length
- Data starts at offset 30 + filenameLen + extraLen

Unit tests for `extractStoredZip`:
- Round-trip: `createStoredZip → extractStoredZip` recovers original content
- Rejects ZIP with compressed entries (method != 0)
- Validates path safety (rejects `../` traversal)
- Handles empty ZIP (no entries)
- Handles single-file ZIP
- Handles multi-file ZIP with subdirectories

### Error Handling

Foundry REST API errors:
- **Non-2xx response**: parse error JSON `{ error: { code, message } }`, display to user
- **401/403**: "Azure credentials expired. Run: az login"
- **424 session_not_ready**: "Session is starting up, retrying..." (auto-retry up to 3 times with 5s delay)
- **Timeout**: 5 minute timeout per response; "Generation timed out. Try a simpler request."
- **`status: "failed"`**: display error details from response body

### REPL Special Commands

- `/quit` or `/exit` — exit REPL, stop preview server
- `/open` — re-open browser to preview URL
- `/session` — show current session ID, agent name, endpoint
- `/export [dir]` — copy extracted app files (not ZIP) to specified directory (default: `./output`). Creates dir if needed, overwrites existing files.
- `/help` — show all commands

```text
$ web-app-gen

🔧 Authenticating...
✓ GitHub: jietong (Copilot entitled)
✓ Azure: ttthree@hotmail.com
✓ Session: abc123 (new)
✓ Preview: http://localhost:3001

web-app-gen> build a pomodoro timer
⏳ Generating...
✓ Generated app (3 files, 4.2 KB)
✓ Preview updated — check your browser

web-app-gen> make the timer circular with a progress ring
⏳ Generating...
✓ Generated app (3 files, 5.1 KB)
✓ Preview updated — check your browser

web-app-gen> /quit
```

### Live Preview Server

A minimal HTTP server on `localhost:3001` (configurable) that:

1. Serves extracted app files (index.html, CSS, JS, assets) from a temp directory
2. Injects a tiny auto-refresh script into HTML responses
3. Tracks a version counter that increments when files are updated
4. The injected script polls `/__version` every 500ms; reloads on change
5. Browser opens once on first successful generation; subsequent turns just refresh

```ts
// Injected before </body>
<script>
(function(){
  let v = 0;
  setInterval(async () => {
    try {
      const r = await fetch('/__version');
      const nv = +(await r.text());
      if (v && nv !== v) location.reload();
      v = nv;
    } catch {}
  }, 500);
})();
</script>
```

### CLI File Structure

```text
cli/src/
  index.ts              — entry point, command routing
  repl.ts               — REPL chat loop
  foundry-client.ts     — direct Foundry REST API client
  github-identity.ts    — GitHub user identity from token
  preview-server.ts     — local HTTP preview with auto-refresh
  download.ts           — download + validate ZIP (existing)
  foundry-sessions.ts   — re-exports (existing)
  validate-static-app.ts — re-exports (existing)
```

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
    repl.ts
    foundry-client.ts
    github-identity.ts
    preview-server.ts
    download.ts
    foundry-sessions.ts
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
- `foundry-client.ts`: correct URL construction, headers (`Foundry-Features`, `Authorization`), request body shape, Azure token parsing from `az` output, error handling for non-2xx responses.
- `github-identity.ts`: parses GitHub user response, returns `{ login, id }`, handles API errors and missing token.
- `preview-server.ts`: injects auto-refresh script into HTML, serves correct MIME types, `/__version` returns incrementing counter, `Cache-Control: no-store` headers.
- `agent/src/server.ts`: body-token precedence (body > env vars), token not logged/persisted, missing token returns 401.
- `package-output.ts`: always repackages (deletes stale ZIP), handles missing `index.html` error.
- `extractStoredZip`: round-trip with `createStoredZip`, rejects compressed entries (method != 0), validates path safety, handles empty/single/multi-file ZIPs.

### REPL Tests

- Mock stdin/stdout to test `/help`, `/session`, `/open`, `/export`, `/quit` commands.
- Multi-turn prompt flow: send two prompts, verify both invoke Foundry and trigger preview update.
- Unknown command shows help.

### Integration Tests

- Agent runner constructs `CopilotClient` with `useLoggedInUser: false` and a Copilot session with `gitHubToken`.
- Agent runner creates a session with `skillDirectories` pointing at the parent skills directory.
- Skill packaging test asserts `agent/skills/web-app-builder/SKILL.md` exists.
- CLI download flow handles a mocked Foundry session file response and unpacks `app.zip`.
- Local fake Foundry HTTP server: create session → invoke responses → download file → verify ZIP.

### E2E Tests

- In CI against a preview Foundry hosted agent:
  - Authenticate as a test product user connected through the GitHub App.
  - Create or resume a hosted session.
  - Generate apps for prompts such as `pomodoro timer`, `expense calculator`, and `tic tac toe`.
  - Download `output/app.zip` from session files.
  - Unzip each app.
  - Open `index.html` with Playwright.
  - Fail on missing assets, console errors, or network calls to unsupported backend endpoints.
- Two different GitHub user IDs proving session isolation (different isolation keys → different sessions).
- Second-turn regeneration proving preview/ZIP refresh (modify existing app, verify ZIP reflects changes).

### Error Path Tests

- Missing GitHub token returns an actionable authorization error.
- Copilot entitlement failure returns a user-facing reconnect/upgrade message.
- Foundry session missing returns a resumable-session error.
- Invalid ZIP output returns a validation failure and preserves session logs for debugging.
