# RepoTreeX CNB Repository Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a loadable Manifest V3 browser extension that adds a secure, searchable, branch-aware repository tree to signed-in CNB repository pages, including private repositories.

**Architecture:** An isolated-world content script owns route state, in-memory repository data, and a Shadow DOM side panel. A main-world bridge performs only allowlisted same-origin CNB `GET` requests with the browser's existing session; a typed provider isolates that transport so OAuth can be added later without changing tree behavior.

**Tech Stack:** TypeScript 5, esbuild, Vitest with jsdom, ESLint, native DOM/Shadow DOM, Chrome Manifest V3 APIs

**Spec:** `docs/superpowers/specs/2026-11-07-repotreex-cnb-tree-design.md`

## Global Constraints

- Support `https://cnb.cool/*` only; do not request `cookies`, `webRequest`, browsing-history, clipboard, or broad tab permissions.
- Never read, serialize, log, persist, or export CNB cookies, personal access tokens, OAuth tokens, repository slugs, refs, file paths, tree nodes, expanded paths, or search queries.
- Persist only panel open/closed state, panel width, and explicitly non-sensitive display preferences.
- The page bridge accepts only allowlisted same-origin `GET` operations for repository contents, HEAD, branches, and tags.
- Clear repository data and abort pending work on `401`, `403`, repository change, ref change, teardown, or extension reload.
- Keep OAuth hidden and inactive until CNB approves a real public client; do not ship an invented `client_id` or embedded client secret.
- Implement independently from CNB documentation and observed public interfaces; do not copy Octotree code, assets, identifiers, or proprietary protocols.
- Use original inline SVG icons and isolated Shadow DOM styles; respect CNB light/dark appearance and `prefers-reduced-motion`.
- Keep each source file focused; production logging must never contain repository metadata or response bodies.

---

## File Map

- `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`: deterministic toolchain and validation commands.
- `scripts/build.mjs`, `scripts/package.mjs`: build the unpacked extension and reproducible release ZIP.
- `src/manifest.json`: minimal Manifest V3 permissions and CNB-only content scripts.
- `src/shared/protocol.ts`: typed bridge request/response and repository DTO contracts.
- `src/shared/errors.ts`: explicit repository/auth/rate-limit/compatibility error model.
- `src/shared/route.ts`: CNB route parsing and canonical file URL construction.
- `src/page/allowlist.ts`: pure validation and URL construction for bridge operations.
- `src/page/bridge.ts`: main-world credentialed fetch bridge and SPA history notification.
- `src/content/bridge-client.ts`: isolated-world request correlation, timeout, abort, and response validation.
- `src/content/provider.ts`: session-backed repository provider and OAuth-ready interface.
- `src/content/tree-store.ts`: in-memory normalized tree, expansion, indexing, selection, and secure clearing.
- `src/content/search.ts`: loaded-node matching and bounded full-tree traversal.
- `src/content/preferences.ts`: strict non-sensitive preference persistence.
- `src/content/icons.ts`: original inline SVG icon functions.
- `src/content/panel.ts`, `src/content/panel.css`: accessible Shadow DOM UI and resize/collapse behavior.
- `src/content/controller.ts`: route/session lifecycle, CNB synchronization, and error-state orchestration.
- `src/content/index.ts`: idempotent content-script bootstrap and teardown.
- `src/assets/icon-*.png`: RepoTreeX extension icons.
- `tests/**/*.test.ts`, `tests/fixtures/*.ts`: unit and DOM integration coverage using synthetic repository names only.
- `README.md`, `docs/privacy.md`, `docs/oauth-application.md`, `docs/manual-test.md`: installation, privacy, OAuth fallback request, and browser QA.

### Task 1: Reproducible Extension Scaffold

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `vitest.config.ts`
- Create: `scripts/build.mjs`
- Create: `scripts/package.mjs`
- Create: `src/manifest.json`
- Create: `src/content/index.ts`
- Create: `src/page/bridge.ts`
- Create: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `npm run build`, `npm run package`, `npm test`, `npm run typecheck`, and `npm run lint`; unpacked output at `dist/extension/`.

- [ ] **Step 1: Write the manifest permission test**

```ts
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.json";

describe("extension manifest", () => {
  it("uses only the required CNB host and storage permission", () => {
    expect(manifest.host_permissions).toEqual(["https://cnb.cool/*"]);
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.permissions).not.toContain("webRequest");
  });

  it("loads isolated UI before the main-world bridge", () => {
    expect(manifest.content_scripts).toEqual([
      expect.objectContaining({
        matches: ["https://cnb.cool/*"],
        js: ["content/index.js"],
        run_at: "document_start",
      }),
      expect.objectContaining({
        matches: ["https://cnb.cool/*"],
        js: ["page/bridge.js"],
        world: "MAIN",
        run_at: "document_start",
      }),
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the scaffold is absent**

Run: `npm test -- tests/manifest.test.ts`

Expected: FAIL because `package.json` and `src/manifest.json` do not exist.

- [ ] **Step 3: Add the minimal toolchain and manifest**

Create `package.json` with these scripts and exact development dependencies resolved into `package-lock.json` by `npm install`:

```json
{
  "name": "repotreex",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/build.mjs",
    "package": "node scripts/package.mjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src tests scripts"
  },
  "devDependencies": {
    "@eslint/js": "latest",
    "@types/chrome": "latest",
    "@types/node": "latest",
    "esbuild": "latest",
    "eslint": "latest",
    "globals": "latest",
    "jsdom": "latest",
    "typescript": "latest",
    "typescript-eslint": "latest",
    "vitest": "latest"
  }
}
```

Configure TypeScript for strict `ES2022` browser code with `resolveJsonModule`, Chrome types, and no emit. Configure Vitest to use jsdom, clear mocks, and include `tests/**/*.test.ts`. Configure ESLint with the TypeScript strict presets and browser/node globals scoped to the appropriate directories.

Use this manifest shape:

```json
{
  "manifest_version": 3,
  "name": "RepoTreeX for CNB",
  "version": "0.1.0",
  "description": "A fast repository tree for CNB code pages.",
  "permissions": ["storage"],
  "host_permissions": ["https://cnb.cool/*"],
  "content_scripts": [
    {
      "matches": ["https://cnb.cool/*"],
      "js": ["content/index.js"],
      "run_at": "document_start"
    },
    {
      "matches": ["https://cnb.cool/*"],
      "js": ["page/bridge.js"],
      "run_at": "document_start",
      "world": "MAIN"
    }
  ],
  "icons": {
    "16": "assets/icon-16.png",
    "32": "assets/icon-32.png",
    "48": "assets/icon-48.png",
    "128": "assets/icon-128.png"
  }
}
```

Make `scripts/build.mjs` remove and recreate `dist/extension`, bundle both TypeScript entry points with esbuild (`format: "iife"`, target `chrome120`, no sourcemap in production), copy the manifest/assets, and fail when required files are absent. Make `scripts/package.mjs` call the build script and create `dist/repotreex-0.1.0.zip` with stable sorted paths using the system `zip` command. Initial entry points may only contain `export {};`.

- [ ] **Step 4: Generate original extension icons**

Create a simple green/teal RepoTreeX mark from original geometric shapes, then export `src/assets/icon-16.png`, `icon-32.png`, `icon-48.png`, and `icon-128.png`. Do not use CNB or Octotree logos.

- [ ] **Step 5: Run scaffold validation**

Run: `npm test -- tests/manifest.test.ts && npm run typecheck && npm run lint && npm run build`

Expected: all checks pass and `dist/extension/manifest.json`, `dist/extension/content/index.js`, and `dist/extension/page/bridge.js` exist.

- [ ] **Step 6: Commit the independently loadable scaffold**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.mjs vitest.config.ts scripts src tests/manifest.test.ts
git commit -m "build: scaffold RepoTreeX MV3 extension"
```

### Task 2: CNB Route Parsing and URL Construction

**Files:**
- Create: `src/shared/route.ts`
- Create: `tests/route.test.ts`

**Interfaces:**
- Consumes: browser `URL`.
- Produces: `parseCnbRoute(url: URL): CnbRoute`, `buildBlobUrl(route: RepositoryRoute, ref: string, path: string): URL`, and exported `CnbRoute`, `RepositoryRoute`, `PageKind` types.

- [ ] **Step 1: Write route tests for nested groups and encoded paths**

```ts
import { describe, expect, it } from "vitest";
import { buildBlobUrl, parseCnbRoute } from "../src/shared/route";

describe("parseCnbRoute", () => {
  it("parses a nested repository root without assuming owner/repo", () => {
    expect(parseCnbRoute(new URL("https://cnb.cool/acme/platform/web"))).toMatchObject({
      kind: "repository",
      repo: "acme/platform/web",
      ref: null,
      filePath: null,
    });
  });

  it("parses a blob route when route state supplies the ref boundary", () => {
    const url = new URL("https://cnb.cool/acme/platform/web/-/blob/main/src/a%20b.ts");
    expect(parseCnbRoute(url, { knownRef: "main" })).toMatchObject({
      kind: "blob",
      repo: "acme/platform/web",
      ref: "main",
      filePath: "src/a b.ts",
    });
  });

  it("rejects non-CNB and non-repository routes", () => {
    expect(parseCnbRoute(new URL("https://example.com/acme/repo"))).toEqual({ kind: "unsupported" });
    expect(parseCnbRoute(new URL("https://cnb.cool/profile"))).toEqual({ kind: "unsupported" });
  });
});

describe("buildBlobUrl", () => {
  it("encodes each ref and path segment", () => {
    const route = { kind: "repository", repo: "acme/platform/web", ref: null, filePath: null } as const;
    expect(buildBlobUrl(route, "release/v1", "src/a b.ts").href).toBe(
      "https://cnb.cool/acme/platform/web/-/blob/release%2Fv1/src/a%20b.ts",
    );
  });
});
```

- [ ] **Step 2: Run the route tests and confirm failure**

Run: `npm test -- tests/route.test.ts`

Expected: FAIL because `src/shared/route.ts` does not exist.

- [ ] **Step 3: Implement conservative route parsing**

Define:

```ts
export type PageKind = "repository" | "blob" | "commit";
export type UnsupportedRoute = { kind: "unsupported" };
export type RepositoryRoute = {
  kind: PageKind;
  repo: string;
  ref: string | null;
  filePath: string | null;
};
export type CnbRoute = RepositoryRoute | UnsupportedRoute;
export type RouteHints = { knownRef?: string | null };
```

Allow only `https:` and hostname `cnb.cool`. Reject known non-repository top-level routes (`profile`, `login`, `oauth2`, `explore`, `new`, `u`, `search`, `announcements`, `invitations`, `error`, `forbidden`, `freeze`, `mine`, `user-locked`, `wx`) and paths with fewer than two repository segments. Split at the first `/-/` marker. For blob URLs, use `knownRef` to disambiguate refs that contain slashes; without a matching hint, parse the first post-marker segment as a provisional ref and let the controller reconcile it after branch/tag discovery. Decode each segment separately and fail closed on malformed encoding.

- [ ] **Step 4: Run route tests and typecheck**

Run: `npm test -- tests/route.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit route behavior**

```bash
git add src/shared/route.ts tests/route.test.ts
git commit -m "feat: parse CNB repository routes"
```

### Task 3: Typed Protocol and Read-only Request Allowlist

**Files:**
- Create: `src/shared/protocol.ts`
- Create: `src/shared/errors.ts`
- Create: `src/page/allowlist.ts`
- Create: `tests/allowlist.test.ts`

**Interfaces:**
- Consumes: typed `BridgeOperation` values.
- Produces: `buildAllowedRequest(operation: BridgeOperation): URL`, bridge event constants, repository DTOs, `RepositoryError`, and `classifyHttpError(status: number): RepositoryError`.

- [ ] **Step 1: Write allowlist tests that attempt privilege expansion**

```ts
import { describe, expect, it } from "vitest";
import { buildAllowedRequest } from "../src/page/allowlist";

describe("buildAllowedRequest", () => {
  it("builds encoded content URLs", () => {
    expect(buildAllowedRequest({
      type: "list-directory",
      repo: "acme/platform/web",
      ref: "release/v1",
      path: "src/a b",
    }).href).toBe(
      "https://cnb.cool/acme/platform/web/-/git/contents/src/a%20b?ref=release%2Fv1",
    );
  });

  it.each([
    "../profile",
    "/absolute",
    "acme/repo?admin=true",
    "acme/repo#fragment",
  ])("rejects unsafe repository input %s", (repo) => {
    expect(() => buildAllowedRequest({ type: "get-head", repo })).toThrow();
  });

  it("does not expose a generic URL or method operation", () => {
    expect(() => buildAllowedRequest({ type: "fetch", url: "https://example.com", method: "POST" } as never)).toThrow();
  });
});
```

- [ ] **Step 2: Run the allowlist test and verify failure**

Run: `npm test -- tests/allowlist.test.ts`

Expected: FAIL because protocol and allowlist modules do not exist.

- [ ] **Step 3: Define exact bridge contracts**

Define operation variants:

```ts
export type BridgeOperation =
  | { type: "list-directory"; repo: string; ref: string; path: string }
  | { type: "get-head"; repo: string }
  | { type: "list-branches"; repo: string; page: number; pageSize: number }
  | { type: "list-tags"; repo: string; page: number; pageSize: number };

export type BridgeRequest = {
  channel: string;
  requestId: string;
  operation: BridgeOperation;
};
export type BridgeResponse =
  | { channel: string; requestId: string; ok: true; status: number; data: unknown }
  | { channel: string; requestId: string; ok: false; status: number; code: string };
```

Export fixed event names `repotreex:request`, `repotreex:response`, and `repotreex:navigation`. Define DTOs matching CNB `Content`, `TreeEntry`, `Branch`, `Tag`, and `HeadRef` schemas without `any`.

Define `RepositoryError` codes `signed-out`, `forbidden`, `not-found`, `rate-limited`, `server`, `network`, `compatibility`, `cancelled`, and store only code/status/retryAfter, never response bodies.

- [ ] **Step 4: Implement strict URL construction**

Validate repo/path components before encoding: non-empty repo with at least two segments; no empty, dot, or dot-dot segments; no query, fragment, backslash, control character, or leading slash. Accept `path === ""` only for root content. Clamp pages to positive integers and page sizes to `1..100`. Construct URLs with `new URL("https://cnb.cool")` and `URLSearchParams`; do not concatenate unvalidated input into a full URL.

- [ ] **Step 5: Run tests and static checks**

Run: `npm test -- tests/allowlist.test.ts && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit the security boundary**

```bash
git add src/shared/protocol.ts src/shared/errors.ts src/page/allowlist.ts tests/allowlist.test.ts
git commit -m "feat: constrain CNB bridge requests"
```

### Task 4: Credentialed Main-world Bridge and Isolated Client

**Files:**
- Modify: `src/page/bridge.ts`
- Create: `src/content/bridge-client.ts`
- Create: `tests/bridge-client.test.ts`
- Create: `tests/page-bridge.test.ts`

**Interfaces:**
- Consumes: protocol constants/types and `buildAllowedRequest`.
- Produces: `createBridgeClient(window, channel): BridgeClient`; main-world request handler; `BridgeClient.request<T>(operation, options?): Promise<T>` and `BridgeClient.dispose(): void`.

- [ ] **Step 1: Write client correlation, abort, and disposal tests**

```ts
import { describe, expect, it } from "vitest";
import { createBridgeClient } from "../src/content/bridge-client";

describe("bridge client", () => {
  it("ignores responses from a different channel", async () => {
    const client = createBridgeClient(window, "channel-a", { timeoutMs: 20 });
    const pending = client.request({ type: "get-head", repo: "acme/repo" });
    window.dispatchEvent(new CustomEvent("repotreex:response", {
      detail: { channel: "channel-b", requestId: "unknown", ok: true, status: 200, data: {} },
    }));
    await expect(pending).rejects.toMatchObject({ code: "network" });
    client.dispose();
  });

  it("rejects pending work as cancelled on dispose", async () => {
    const client = createBridgeClient(window, "channel-a", { timeoutMs: 1_000 });
    const pending = client.request({ type: "get-head", repo: "acme/repo" });
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
});
```

- [ ] **Step 2: Write the page bridge fetch contract test**

Extract and export `handleBridgeRequest(request, fetchImpl)` for testing. Assert the fetch call is exactly:

```ts
expect(fetchMock).toHaveBeenCalledWith(
  "https://cnb.cool/acme/repo/-/git/head",
  {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    cache: "no-store",
  },
);
```

Also assert a `401` returns `{ ok: false, status: 401, code: "signed-out" }` without including the response body.

- [ ] **Step 3: Run bridge tests and verify failure**

Run: `npm test -- tests/bridge-client.test.ts tests/page-bridge.test.ts`

Expected: FAIL because the client and handler are not implemented.

- [ ] **Step 4: Implement the page bridge**

Listen only to the fixed request event on `window`. Validate `event.detail` structurally, call `buildAllowedRequest`, and fetch with the exact options above. Parse JSON only for successful responses and return `compatibility` for invalid JSON. Map HTTP status through `classifyHttpError`. Catch only known validation/network/abort cases and return their explicit codes. Never return `Response.text()`, headers other than a parsed numeric `Retry-After`, stack traces, request URLs, or repository metadata in errors.

Patch `history.pushState` and `history.replaceState` once, preserving `this`, arguments, return values, and property descriptors, then emit `repotreex:navigation`. Also emit on `popstate` and `hashchange`.

- [ ] **Step 5: Implement the isolated bridge client**

Use `crypto.randomUUID()` for request IDs, a map of pending resolvers, fixed response listener, optional `AbortSignal`, and timeout. Validate response shape before resolving. Convert unsuccessful responses into `RepositoryError`. `dispose()` removes the listener and rejects every pending request with `cancelled`.

- [ ] **Step 6: Run bridge validation**

Run: `npm test -- tests/bridge-client.test.ts tests/page-bridge.test.ts && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 7: Commit session transport**

```bash
git add src/page/bridge.ts src/content/bridge-client.ts tests/bridge-client.test.ts tests/page-bridge.test.ts
git commit -m "feat: reuse the active CNB web session"
```

### Task 5: Repository Provider and Response Validation

**Files:**
- Create: `src/content/provider.ts`
- Create: `tests/provider.test.ts`
- Create: `tests/fixtures/repository.ts`

**Interfaces:**
- Consumes: `BridgeClient`, bridge DTOs, and `RepositoryError`.
- Produces: `RepositoryProvider`, `createSessionProvider(client): RepositoryProvider`, `DirectoryListing`, `RefOption`.

- [ ] **Step 1: Write provider schema and pagination tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createSessionProvider } from "../src/content/provider";

describe("session provider", () => {
  it("normalizes a valid tree response", async () => {
    const request = vi.fn().mockResolvedValue({
      type: "tree",
      path: "src",
      name: "src",
      sha: "tree-sha",
      size: 0,
      entries: [{ type: "blob", path: "src/a.ts", name: "a.ts", sha: "blob-sha" }],
    });
    const provider = createSessionProvider({ request, dispose: vi.fn() });
    await expect(provider.listDirectory("acme/repo", "main", "src")).resolves.toMatchObject({
      path: "src",
      entries: [{ kind: "file", path: "src/a.ts", name: "a.ts" }],
    });
  });

  it("rejects success-shaped malformed data", async () => {
    const provider = createSessionProvider({
      request: vi.fn().mockResolvedValue({ type: "tree", entries: [{ type: "blob", path: 42 }] }),
      dispose: vi.fn(),
    });
    await expect(provider.listDirectory("acme/repo", "main", "")).rejects.toMatchObject({ code: "compatibility" });
  });
});
```

Add branch/tag tests that request pages of 100 until a short page is returned, deduplicate names, and abort when the signal fires.

- [ ] **Step 2: Run provider tests and verify failure**

Run: `npm test -- tests/provider.test.ts`

Expected: FAIL because `provider.ts` does not exist.

- [ ] **Step 3: Define and implement the provider**

```ts
export type EntryKind = "directory" | "file" | "link" | "submodule";
export type RepositoryEntry = { kind: EntryKind; name: string; path: string; sha: string };
export type DirectoryListing = { path: string; sha: string; entries: RepositoryEntry[] };
export type RefOption = { kind: "branch" | "tag"; name: string; sha: string };
export interface RepositoryProvider {
  getHead(repo: string, signal?: AbortSignal): Promise<string>;
  listDirectory(repo: string, ref: string, path: string, signal?: AbortSignal): Promise<DirectoryListing>;
  listBranches(repo: string, signal?: AbortSignal): Promise<RefOption[]>;
  listTags(repo: string, signal?: AbortSignal): Promise<RefOption[]>;
  dispose(): void;
}
```

Use explicit type guards for every response and entry field. Map CNB `tree` to `directory`, `blob` to `file`, and preserve `link`/`submodule`. Reject content responses whose `type !== "tree"`. Sort/deduplicate refs after pagination; never coerce missing names or hashes into empty strings.

- [ ] **Step 4: Run provider tests and static checks**

Run: `npm test -- tests/provider.test.ts && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit the transport-independent provider**

```bash
git add src/content/provider.ts tests/provider.test.ts tests/fixtures/repository.ts
git commit -m "feat: add typed CNB repository provider"
```

### Task 6: In-memory Tree Store and Secure Session Clearing

**Files:**
- Create: `src/content/tree-store.ts`
- Create: `tests/tree-store.test.ts`

**Interfaces:**
- Consumes: `RepositoryProvider`, `RepositoryEntry`, and `RepositoryError`.
- Produces: `createTreeStore(provider): TreeStore`, `TreeNode`, `TreeSnapshot`, and store methods `startSession`, `loadDirectory`, `toggleDirectory`, `selectPath`, `clearSensitiveData`, `subscribe`, `getSnapshot`, `dispose`.

- [ ] **Step 1: Write store behavior and privacy tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createTreeStore } from "../src/content/tree-store";

describe("tree store", () => {
  it("sorts directories before files and names naturally", async () => {
    const provider = fakeProvider([
      { kind: "file", name: "z.ts", path: "z.ts", sha: "1" },
      { kind: "directory", name: "src", path: "src", sha: "2" },
      { kind: "file", name: "a.ts", path: "a.ts", sha: "3" },
    ]);
    const store = createTreeStore(provider);
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    expect(store.getSnapshot().visibleNodes.map((node) => node.path)).toEqual(["src", "a.ts", "z.ts"]);
  });

  it("clears all repository metadata on authorization failure", async () => {
    const provider = fakeRejectingProvider({ code: "signed-out", status: 401 });
    const store = createTreeStore(provider);
    store.startSession("private/team/repo", "secret-branch");
    await expect(store.loadDirectory("")).rejects.toMatchObject({ code: "signed-out" });
    expect(store.getSnapshot()).toMatchObject({ repo: null, ref: null, nodesByPath: {}, visibleNodes: [] });
  });
});
```

Include tests for request deduplication, stale response rejection after `startSession`, nested expansion, selection, per-directory retryable error state, and `dispose()` aborting pending requests.

- [ ] **Step 2: Run store tests and verify failure**

Run: `npm test -- tests/tree-store.test.ts`

Expected: FAIL because `tree-store.ts` does not exist.

- [ ] **Step 3: Implement immutable snapshots over mutable private state**

Represent root with path `""`. Keep repo/ref, node map, child path arrays, expanded set, selected path, pending controllers, and numeric session ID private. Return frozen/copy snapshots so panel code cannot mutate store state. Use `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })` for stable natural ordering with directories first.

`startSession(repo, ref)` first calls `clearSensitiveData()`, increments session ID, then stores the new context. `loadDirectory` deduplicates concurrent path loads. It captures the session ID and ignores a late result after navigation. On `signed-out` or `forbidden`, call `clearSensitiveData()` before rethrowing. `dispose()` clears data, aborts requests, removes subscribers, and disposes the provider.

- [ ] **Step 4: Run store tests and checks**

Run: `npm test -- tests/tree-store.test.ts && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit the memory-only repository model**

```bash
git add src/content/tree-store.ts tests/tree-store.test.ts
git commit -m "feat: manage repository trees in tab memory"
```

### Task 7: Filename Search and Bounded Full-tree Loading

**Files:**
- Create: `src/content/search.ts`
- Create: `tests/search.test.ts`

**Interfaces:**
- Consumes: `TreeStore.loadDirectory`, `TreeStore.getSnapshot`, and directory nodes.
- Produces: `matchLoadedNodes(snapshot, query): TreeNode[]`, `loadFullTree(store, options): Promise<TraversalResult>`, `TraversalProgress`, and `TraversalResult`.

- [ ] **Step 1: Write matching and traversal-limit tests**

```ts
import { describe, expect, it } from "vitest";
import { loadFullTree, matchLoadedNodes } from "../src/content/search";

describe("filename search", () => {
  it("matches path substrings case-insensitively", () => {
    const snapshot = snapshotWithPaths(["src/RepoTree.ts", "docs/design.md", "README.md"]);
    expect(matchLoadedNodes(snapshot, "repo").map((node) => node.path)).toEqual(["src/RepoTree.ts"]);
  });

  it("stops traversal at the node ceiling and reports truncation", async () => {
    const store = fakeLargeTreeStore(20);
    await expect(loadFullTree(store, { concurrency: 2, maxNodes: 5 })).resolves.toMatchObject({
      truncated: true,
      loadedNodes: 5,
    });
  });
});
```

Add tests proving maximum in-flight directory loads never exceed `4`, duplicate directories are not revisited, progress is monotonic, and `AbortSignal` produces `cancelled`.

- [ ] **Step 2: Run search tests and verify failure**

Run: `npm test -- tests/search.test.ts`

Expected: FAIL because `search.ts` does not exist.

- [ ] **Step 3: Implement loaded-node matching**

Trim the query and use locale-aware lowercasing. An empty query returns no search result state rather than all nodes. Rank basename prefix matches, then basename substring matches, then full-path substring matches; break ties with path length and natural ordering. Limit rendered search results to 200 and include a `hasMoreMatches` flag.

- [ ] **Step 4: Implement cancellable breadth-first traversal**

Default to `concurrency: 4` and `maxNodes: 10_000`. Maintain a FIFO directory queue and visited set. Count every discovered non-root node; stop scheduling work at the ceiling, allow currently in-flight requests to settle, and return `truncated: true`. Propagate authorization, rate-limit, and compatibility errors; translate abort into `cancelled`. Report `{ loadedNodes, queuedDirectories, activeRequests }` after each settled directory.

- [ ] **Step 5: Run search validation**

Run: `npm test -- tests/search.test.ts && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit bounded search behavior**

```bash
git add src/content/search.ts tests/search.test.ts
git commit -m "feat: add bounded repository filename search"
```

### Task 8: Non-sensitive Preference Persistence

**Files:**
- Create: `src/content/preferences.ts`
- Create: `tests/preferences.test.ts`

**Interfaces:**
- Consumes: `chrome.storage.local`-compatible adapter.
- Produces: `Preferences`, `PreferenceStorage`, `createPreferenceStore(storage)`, `load(): Promise<Preferences>`, and `save(patch: Partial<Preferences>): Promise<Preferences>`.

- [ ] **Step 1: Write preference allowlist tests**

```ts
import { describe, expect, it } from "vitest";
import { createPreferenceStore } from "../src/content/preferences";

describe("preference store", () => {
  it("persists only non-sensitive UI keys", async () => {
    const storage = memoryStorage();
    const store = createPreferenceStore(storage);
    await store.save({ panelOpen: false, panelWidth: 412 });
    expect(storage.value).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 412 } });
  });

  it("ignores unknown and repository-shaped stored values", async () => {
    const storage = memoryStorage({
      "repotreex.preferences": { panelOpen: true, panelWidth: 320, repo: "private/repo", expandedPaths: ["secret"] },
    });
    await expect(createPreferenceStore(storage).load()).resolves.toEqual({ panelOpen: true, panelWidth: 320 });
  });
});
```

- [ ] **Step 2: Run preference tests and verify failure**

Run: `npm test -- tests/preferences.test.ts`

Expected: FAIL because `preferences.ts` does not exist.

- [ ] **Step 3: Implement strict preference serialization**

Define defaults `{ panelOpen: true, panelWidth: 300 }`. Clamp width to `240..560`. Parse stored data property-by-property and construct a fresh object containing only recognized keys. Never spread caller or stored objects into the serialized value. Provide an adapter around `chrome.storage.local.get/set` in production and dependency injection for tests.

- [ ] **Step 4: Run preference tests and checks**

Run: `npm test -- tests/preferences.test.ts && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit privacy-safe preferences**

```bash
git add src/content/preferences.ts tests/preferences.test.ts
git commit -m "feat: persist only non-sensitive panel settings"
```

### Task 9: Accessible Shadow DOM Tree Panel

**Files:**
- Create: `src/content/icons.ts`
- Create: `src/content/panel.ts`
- Create: `src/content/panel.css`
- Create: `tests/panel.test.ts`
- Modify: `scripts/build.mjs`

**Interfaces:**
- Consumes: `TreeSnapshot`, search functions, preferences, and callbacks for directory/file/ref/refresh/full-search actions.
- Produces: `mountTreePanel(options): TreePanel`, `TreePanel.render(state)`, `TreePanel.focusPath(path)`, and `TreePanel.destroy()`.

- [ ] **Step 1: Write DOM behavior and accessibility tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { mountTreePanel } from "../src/content/panel";

describe("tree panel", () => {
  it("renders an accessible selected file and opens it with Enter", () => {
    const onOpenFile = vi.fn();
    const panel = mountTreePanel({ document, onOpenFile, onToggleDirectory: vi.fn(), onRefresh: vi.fn(), onSearch: vi.fn(), onLoadFullTree: vi.fn(), onSelectRef: vi.fn(), onPreferenceChange: vi.fn() });
    panel.render(panelStateWithSelectedFile("src/app.ts"));
    const item = panel.root.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')!;
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpenFile).toHaveBeenCalledWith("src/app.ts");
  });

  it("removes its host and restores layout on destroy", () => {
    const panel = mountTreePanel(minimalOptions(document));
    const host = panel.host;
    panel.destroy();
    expect(host.isConnected).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--repotreex-panel-width")).toBe("");
  });
});
```

Add tests for one host only, folder toggle, ArrowUp/ArrowDown visible-row navigation, ArrowRight expansion, ArrowLeft collapse/parent focus, search input callback, ref selection, collapse/reopen, resize clamping, error/retry states, and `aria-busy` during loads.

- [ ] **Step 2: Run panel tests and verify failure**

Run: `npm test -- tests/panel.test.ts`

Expected: FAIL because panel modules do not exist.

- [ ] **Step 3: Implement original icons and panel shell**

Return SVG strings or DOM nodes for folder, file, link, submodule, search, refresh, close, chevron, branch, and tag icons. Use `currentColor`, a consistent 1.5px stroke, `viewBox="0 0 16 16"`, and no external asset URLs.

Mount one fixed host with ID `repotreex-root` and a closed-over ShadowRoot. Adopt bundled CSS as a string imported by the build. The panel header contains RepoTreeX name, current repository basename, ref selector, refresh, and collapse controls. The body contains search, optional full-tree search action/progress, and a `role="tree"` list. Add a narrow reopen tab while collapsed.

- [ ] **Step 4: Implement responsive layout and resizing**

Use CSS custom property `--repotreex-panel-width`. The host is fixed to the left below CNB's top chrome using a detected/safe top offset; the page gets `padding-left` only through a dedicated class on `document.documentElement`. Preserve prior inline values and restore them exactly on destroy. Use Pointer Events with pointer capture for resize; save only the final clamped width. Under an 800px viewport, render the panel as an overlay with a backdrop instead of shrinking CNB content.

Use neutral light/dark tokens selected by `color-scheme` and `[data-theme="dark"]` observation. Use a purposeful monospace UI font stack beginning with `"IBM Plex Mono"` if installed and safe fallbacks. Avoid gradients, excessive cards, and copied CNB/Octotree styling.

- [ ] **Step 5: Implement rendering and keyboard interaction**

Render only `snapshot.visibleNodes` and search results. Use event delegation with `data-path`; never inject repository names through `innerHTML`. Use `textContent`. Implement roving `tabIndex`, tree levels, expanded/selected/busy attributes, focus retention across renders, and scroll selected rows into view. Batch render through one `requestAnimationFrame`.

- [ ] **Step 6: Bundle panel CSS and run UI tests**

Update `scripts/build.mjs` with an esbuild text loader for `.css` imports.

Run: `npm test -- tests/panel.test.ts && npm run typecheck && npm run lint && npm run build`

Expected: PASS and the content bundle contains the isolated styles.

- [ ] **Step 7: Commit the usable panel**

```bash
git add src/content/icons.ts src/content/panel.ts src/content/panel.css scripts/build.mjs tests/panel.test.ts
git commit -m "feat: render accessible CNB repository tree panel"
```

### Task 10: Route Controller, Ref Synchronization, and Bootstrap

**Files:**
- Create: `src/content/controller.ts`
- Modify: `src/content/index.ts`
- Create: `tests/controller.test.ts`
- Create: `tests/bootstrap.test.ts`

**Interfaces:**
- Consumes: route parser, provider, store, search, preferences, and panel.
- Produces: `createRepoTreeController(dependencies): RepoTreeController`, `start()`, `handleNavigation(url)`, and `destroy()`; idempotent content-script bootstrap.

- [ ] **Step 1: Write controller lifecycle tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createRepoTreeController } from "../src/content/controller";

describe("RepoTree controller", () => {
  it("retains a session for file-only navigation and replaces it for a ref change", async () => {
    const deps = fakeControllerDependencies();
    const controller = createRepoTreeController(deps);
    await controller.handleNavigation(new URL("https://cnb.cool/acme/repo/-/blob/main/a.ts"));
    await controller.handleNavigation(new URL("https://cnb.cool/acme/repo/-/blob/main/b.ts"));
    expect(deps.store.startSession).toHaveBeenCalledTimes(1);
    await controller.handleNavigation(new URL("https://cnb.cool/acme/repo/-/blob/dev/b.ts"));
    expect(deps.store.startSession).toHaveBeenCalledTimes(2);
  });

  it("clears and shows signed-out state after a 401", async () => {
    const deps = fakeControllerDependencies({ rootError: { code: "signed-out", status: 401 } });
    const controller = createRepoTreeController(deps);
    await controller.handleNavigation(new URL("https://cnb.cool/private/repo"));
    expect(deps.store.clearSensitiveData).toHaveBeenCalled();
    expect(deps.panel.render).toHaveBeenLastCalledWith(expect.objectContaining({ status: "signed-out" }));
  });
});
```

Add tests for unsupported routes hiding/unmounting the panel, nested repo slugs, HEAD fallback, branch/tag ref reconciliation including slash refs, ancestor loading for the current file, file opening via canonical URL, retry, refresh, full-tree cancellation on navigation, and destroy cleanup.

- [ ] **Step 2: Run controller tests and verify failure**

Run: `npm test -- tests/controller.test.ts tests/bootstrap.test.ts`

Expected: FAIL because the controller is absent and bootstrap is empty.

- [ ] **Step 3: Implement route/session orchestration**

On a supported repository route, resolve HEAD and refs concurrently where possible. Reconcile provisional blob refs by selecting the longest known branch/tag name that prefixes the post-`/-/blob/` path; the remaining segments are the file path. Start the tree session only after repo and ref are stable. Load root, then each parent directory of the current file sequentially so it can be selected and revealed.

On file click, call `location.assign(buildBlobUrl(...).href)`. On ref selection, preserve the current file path only if opening it succeeds; first navigate canonically and let a `404` fall back to repository root for that ref with an explicit notice. Refresh clears and restarts only the current repo/ref session.

Map errors to panel states without logging metadata. Authorization errors clear sensitive store state. Rate-limit state disables full traversal until retry. Network and server errors retain already-loaded nodes and expose retry.

- [ ] **Step 4: Implement idempotent bootstrap and teardown**

Generate one random channel per content-script lifetime, create the bridge client/provider/store/preferences/panel/controller, and call `start()` after DOM readiness. Listen for `repotreex:navigation`, `pageshow`, and a development-only teardown event. Guard the global bootstrap with a `Symbol.for("repotreex.instance")`; if an older instance exists, destroy it before mounting the new one. Register cleanup for pagehide and extension context invalidation where detectable.

- [ ] **Step 5: Run controller and full automated validation**

Run: `npm test && npm run typecheck && npm run lint && npm run build && npm run package`

Expected: all checks pass and `dist/repotreex-0.1.0.zip` is produced.

- [ ] **Step 6: Commit the end-to-end extension behavior**

```bash
git add src/content/controller.ts src/content/index.ts tests/controller.test.ts tests/bootstrap.test.ts
git commit -m "feat: synchronize RepoTreeX with CNB navigation"
```

### Task 11: Privacy, Installation, OAuth Fallback, and Manual QA Documentation

**Files:**
- Create: `README.md`
- Create: `docs/privacy.md`
- Create: `docs/oauth-application.md`
- Create: `docs/manual-test.md`
- Create: `tests/privacy.test.ts`

**Interfaces:**
- Consumes: final manifest, source, build commands, and approved architecture.
- Produces: user-facing installation/privacy docs and a machine-enforced forbidden-API/content scan.

- [ ] **Step 1: Write a privacy regression scan**

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

describe("privacy boundary", () => {
  it("does not use cookie APIs or persist repository metadata", () => {
    const files = globSync("src/**/*.{ts,json}");
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/chrome\.cookies|document\.cookie|browser\.cookies/);
    expect(source).not.toMatch(/storage\.(?:local|sync).*?(?:repo|ref|path|tree|query)/s);
  });
});
```

If the Node version's `globSync` is unavailable in the test runner, use a focused recursive helper inside this test; do not add a runtime dependency.

- [ ] **Step 2: Run the privacy scan**

Run: `npm test -- tests/privacy.test.ts`

Expected: PASS with the implemented source; if it fails, treat it as a security defect and fix the source before documenting.

- [ ] **Step 3: Write installation and usage documentation**

`README.md` must include prerequisites, `npm ci`, validation commands, unpacked build path, QQ Browser/Chrome developer-mode loading steps, supported CNB routes, first-release features, known limits, and clean-room attribution boundary. Do not claim store publication or OAuth availability.

`docs/privacy.md` must state exactly: current CNB session cookies are attached by the browser to same-origin requests; RepoTreeX cannot read or export HttpOnly cookies; repository structure stays in tab memory; only panel width/open state persist; no analytics; no external service transmission.

- [ ] **Step 4: Write the OAuth application request document**

Include application name, purpose, public-client requirement, Authorization Code + PKCE preference, Device Authorization fallback, redirect URI placeholder explicitly marked as application-registration input rather than runtime config, no client secret, and minimal scopes `repo-code:r` plus optional `repo-release:r`. State that OAuth UI remains disabled until CNB supplies a real `client_id`.

- [ ] **Step 5: Write the manual verification matrix**

Use synthetic labels rather than private names. Cover install/reload, public repo, private repo, root/nested files, folder expansion, current-file reveal, branch/tag change, slash-containing refs, loaded-node search, bounded full-tree search/cancel/truncation, resize/collapse persistence, SPA/back/forward navigation, light/dark mode, keyboard tree controls, offline/5xx retry, `401`, `403`, `404`, `429`, logout, extension reload, and removal restoring CNB layout. Explicitly prohibit screenshots/logs containing private paths.

- [ ] **Step 6: Run documentation and release checks**

Run: `npm test && npm run typecheck && npm run lint && npm run package && unzip -l dist/repotreex-0.1.0.zip`

Expected: all checks pass; ZIP contains only manifest, bundled scripts, styles/assets required at runtime, and no tests, source maps, logs, or private fixtures.

- [ ] **Step 7: Commit delivery documentation**

```bash
git add README.md docs/privacy.md docs/oauth-application.md docs/manual-test.md tests/privacy.test.ts
git commit -m "docs: document RepoTreeX privacy and verification"
```

### Task 12: Chromium-compatible Browser Verification and Release Gate

**Files:**
- Modify: `docs/manual-test.md` only if observed behavior requires corrected instructions.
- Modify: implementation/test files only for defects found during this task.

**Interfaces:**
- Consumes: `dist/extension/`, QQ Browser's signed-in CNB session, and the manual verification matrix.
- Produces: a verified local build with no unresolved release-blocking defects; no private repository metadata artifact.

- [ ] **Step 1: Build from a clean dependency install**

Run: `npm ci && npm test && npm run typecheck && npm run lint && npm run package`

Expected: PASS from lockfile only.

- [ ] **Step 2: Load the unpacked extension with user confirmation at install time**

Open QQ Browser's extension-management page, enable developer mode, and select `dist/extension/`. Installing an extension through browser UI requires an action-time confirmation; request it immediately before the final install click and let the user take over if the browser requires file-picker interaction that cannot be safely automated.

- [ ] **Step 3: Verify public-repository workflow**

Use `https://cnb.cool/examples/showcase` or another public CNB repository. Confirm root load, two nested directory expansions, file navigation, selected-file reveal, branch selector, search, resize, collapse/reopen, refresh, browser back/forward, and page reload. Inspect the browser console only for RepoTreeX errors and ensure no repository metadata is logged.

- [ ] **Step 4: Verify private-repository workflow without recording metadata**

Ask the user to choose a private repository already visible in the signed-in QQ Browser session. Verify the same core workflow visually without copying paths into tools, screenshots, test fixtures, terminal output, or the final report. Confirm the browser's Network panel shows same-origin `cnb.cool` requests and that extension storage contains only `panelOpen` and `panelWidth`.

- [ ] **Step 5: Verify authorization loss and cleanup**

Use a controlled sign-out or permission-revocation scenario selected by the user. Confirm the next repository request produces signed-out/access-denied UI, removes tree rows/search results, and leaves no repository metadata in `chrome.storage.local`. Re-login and confirm a fresh session loads normally.

- [ ] **Step 6: Verify visual and responsive quality**

Check the panel at desktop width and under 800px, both CNB themes, keyboard-only tree operation, visible focus, reduced motion, long names, empty repositories, loading states, and retry states. Capture screenshots only from the public repository. Inspect screenshots for clipping, accidental page overlap, unreadable text, and unfinished controls; fix and repeat until none remain.

- [ ] **Step 7: Re-run the release gate after browser fixes**

Run: `npm test && npm run typecheck && npm run lint && npm run package && git diff --check`

Expected: PASS and no unexpected worktree changes.

- [ ] **Step 8: Commit only verified defect fixes**

If browser verification required changes:

```bash
git status --short
git diff --name-only
# Stage each verified defect-fix path explicitly after reviewing the diff.
git commit -m "fix: harden RepoTreeX browser integration"
```

If no fixes were needed, do not create an empty commit. Record the public-repository checks and private-repository result in the final handoff without disclosing private metadata.
