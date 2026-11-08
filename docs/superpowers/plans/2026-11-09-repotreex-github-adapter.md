# RepoTreeX GitHub Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend RepoTreeX from CNB-only support to equivalent public and private repository-tree support on `github.com`, while preserving CNB behavior and reusing each site's current browser login session without reading credentials.

**Architecture:** Introduce an exact-origin platform registry whose CNB and GitHub adapters own route parsing, native URL construction, typed request construction, response decoding, and host-layout behavior. Keep `TreeStore`, traversal/search, preferences, and the panel interaction model platform-neutral; bind one adapter/provider/controller session to the current origin and invalidate all in-memory repository state on route, ref, repository, authorization, or lifecycle changes.

**Tech Stack:** TypeScript, Manifest V3, isolated-world and MAIN-world content scripts, same-origin `fetch`, Shadow DOM, Vitest/jsdom, esbuild, Node.js browser probes.

**Spec:** docs/superpowers/specs/2026-11-09-repotreex-github-adapter-design.md

## Global Constraints

- Product name is exactly `RepoTreeX`; supported origins are exactly `https://cnb.cool/*` and `https://github.com/*`.
- GitLab, self-hosted GitLab, GitHub Enterprise, OAuth, PATs, GitHub REST/GraphQL APIs, file-content search, mutation requests, and store publication are out of scope.
- Every network operation is typed, read-only `GET`, exact-origin, repository-scoped, uses `credentials: "include"`, and uses `cache: "no-store"`; there is no arbitrary URL or method proxy.
- The extension never requests cookie, tabs, history, webRequest, clipboard, or broad host permissions and never reads `document.cookie` or browser cookie APIs.
- Private repository access must match the active website session; signed-out/forbidden results synchronously clear repository, ref, path, query, tree, and pending DOM state.
- Persistent storage remains exactly `repotreex.preferences` with only `panelOpen` and `panelWidth`; repository data, refs, paths, expanded state, queries, HTML, screenshots, and response bodies remain tab-memory-only.
- GitHub HTML is bounded to `2_000_000` UTF-16 code units, validated by an explicit decoder version, copied into normalized scalar DTOs, then discarded; raw HTML and parser exceptions are never logged, persisted, or included in errors.
- Ref enumeration is bounded to `10` pages of `100` refs per kind, cancellable, and fails explicitly if a full tenth page indicates incomplete pagination.
- Existing CNB behavior and the `repotreex.preferences` storage key remain backward-compatible.
- Production source and built artifacts contain no `console.*`, source maps, captured live response bodies, tokens, cookies, private repository metadata, or external telemetry.
- Manual installation, extension reload, private-repository checks, sign-out, and access-revocation checks require action-time user confirmation and must not record private repository identifiers or screenshots.
- Each task follows RED-GREEN TDD, runs its focused tests, runs the full required validation before committing, and creates one independently reviewable commit.

---

### Task 1: Shared Platform Contracts and Safe Path Primitives

**Files:**
- Create: `src/shared/path.ts`
- Create: `src/platforms/types.ts`
- Create: `tests/platform-types.test.ts`
- Modify: `src/content/provider.ts`

**Interfaces:**
- Produces: `PlatformId = "cnb" | "github"`.
- Produces: `RepositoryRoute`, `RouteHints`, `UnsupportedRoute`, `PlatformRoute`, `HostLayoutAdapter`, and `RepositoryPlatformAdapter` from `src/platforms/types.ts`.
- Produces: `decodePathSegments(encoded: readonly string[]): string[] | null`, `validatePathSegments(value: string, options: SegmentValidationOptions): string[]`, and `encodePathSegments(segments: readonly string[]): string` from `src/shared/path.ts`.
- Preserves: normalized `RepositoryProvider`, `DirectoryListing`, `RepositoryEntry`, and `RefOption` contracts from `src/content/provider.ts`.

- [ ] **Step 1: Write failing contract and path-safety tests**

```ts
// tests/platform-types.test.ts
import { describe, expect, expectTypeOf, it } from "vitest";
import { decodePathSegments, encodePathSegments, validatePathSegments } from "../src/shared/path";
import type { PlatformId, RepositoryPlatformAdapter, RepositoryRoute } from "../src/platforms/types";

describe("shared platform contracts", () => {
  it("keeps platform identity on every repository route", () => {
    const route: RepositoryRoute = {
      platform: "github", view: "blob", repository: "acme/repo", ref: "release/v1", path: "src/a b.ts",
    };
    expect(route.platform satisfies PlatformId).toBe("github");
    expectTypeOf<RepositoryPlatformAdapter["parseRoute"]>().toBeFunction();
  });

  it("decodes and re-encodes only safe individual path segments", () => {
    expect(decodePathSegments(["src", "a%20b.ts"])).toEqual(["src", "a b.ts"]);
    expect(decodePathSegments(["src%2Fa.ts"])).toBeNull();
    expect(encodePathSegments(["release", "v1"])).toBe("release/v1");
  });

  it.each(["", "/main", "main/", "main//next", ".", "..", "main/../next", "main\\next", "main\nnext"])(
    "rejects unsafe segmented values %s", (value) => {
      expect(() => validatePathSegments(value, { label: "ref", minimum: 1 })).toThrow(TypeError);
    },
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/platform-types.test.ts`

Expected: FAIL because `src/shared/path.ts` and `src/platforms/types.ts` do not exist.

- [ ] **Step 3: Implement the shared contracts and primitives**

```ts
// src/platforms/types.ts
import type { BridgeClient } from "../content/bridge-client";
import type { RepositoryProvider, RefOption } from "../content/provider";

export type PlatformId = "cnb" | "github";
export type RepositoryView = "root" | "tree" | "blob";
export type UnsupportedRoute = Readonly<{ kind: "unsupported" }>;
export type RepositoryRoute = Readonly<{
  platform: PlatformId;
  view: RepositoryView;
  repository: string;
  ref: string | null;
  path: string | null;
}>;
export type PlatformRoute = RepositoryRoute | UnsupportedRoute;
export type RouteHints = Readonly<{ knownRef?: string | null }>;

export interface HostLayoutAdapter {
  readonly platform: PlatformId;
  install(document: Document, panelWidth: () => number): { update(open: boolean, overlay: boolean): void; destroy(): void };
}

export interface RepositoryPlatformAdapter {
  readonly id: PlatformId;
  readonly origin: `https://${string}`;
  readonly layout: HostLayoutAdapter;
  parseRoute(url: URL, hints?: RouteHints): PlatformRoute;
  reconcileRoute(url: URL, refs: readonly RefOption[], head: string): PlatformRoute;
  buildFileUrl(route: RepositoryRoute, ref: string, path: string): URL;
  buildRefRootUrl(route: RepositoryRoute, ref: string): URL;
  createProvider(client: BridgeClient): RepositoryProvider;
}
```

Implement `src/shared/path.ts` with descriptor-free string validation: reject empty segments, `.`, `..`, backslashes, `/` inside a decoded segment, U+0000–U+001F, U+007F–U+009F, malformed percent encoding, and optional marker values. Move normalized provider model types to the top of `src/content/provider.ts` without changing provider behavior.

- [ ] **Step 4: Run focused and regression tests**

Run: `npx vitest run tests/platform-types.test.ts tests/provider.test.ts tests/route.test.ts tests/allowlist.test.ts`

Expected: PASS with no warnings.

- [ ] **Step 5: Run type and lint checks**

Run: `npm run typecheck && npm run lint`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/path.ts src/platforms/types.ts src/content/provider.ts tests/platform-types.test.ts
git commit -m "refactor: define repository platform contracts"
```

---

### Task 2: Extract the CNB Adapter Without Behavior Change

**Files:**
- Create: `src/platforms/cnb/route.ts`
- Create: `src/platforms/cnb/provider.ts`
- Create: `src/platforms/cnb/layout.ts`
- Create: `src/platforms/cnb/index.ts`
- Modify: `src/shared/route.ts`
- Modify: `src/content/provider.ts`
- Modify: `tests/route.test.ts`
- Modify: `tests/provider.test.ts`

**Interfaces:**
- Consumes: `RepositoryPlatformAdapter`, route types, path primitives, normalized provider types.
- Produces: `parseCnbRoute`, `reconcileCnbRoute`, `buildCnbFileUrl`, `buildCnbRefRootUrl`, `createCnbProvider`, `cnbLayout`, and `cnbAdapter`.
- Compatibility: `src/shared/route.ts` re-exports CNB route functions during migration; `createSessionProvider` remains a deprecated alias of `createCnbProvider` until Task 8.

- [ ] **Step 1: Update CNB tests to target the adapter boundary**

```ts
// tests/route.test.ts
import { buildCnbFileUrl, parseCnbRoute, reconcileCnbRoute } from "../src/platforms/cnb/route";

it("qualifies CNB routes with platform identity", () => {
  expect(parseCnbRoute(new URL("https://cnb.cool/acme/repo/-/blob/main/src/a.ts"), { knownRef: "main" })).toEqual({
    platform: "cnb", view: "blob", repository: "acme/repo", ref: "main", path: "src/a.ts",
  });
});

it("uses the longest discovered CNB ref", () => {
  const refs = [{ kind: "branch" as const, name: "release/v1", sha: "synthetic" }];
  expect(reconcileCnbRoute(new URL("https://cnb.cool/acme/repo/-/blob/release/v1/src/a.ts"), refs, "main"))
    .toMatchObject({ ref: "release/v1", path: "src/a.ts" });
});
```

In `tests/provider.test.ts`, replace imports/calls of `createSessionProvider` with `createCnbProvider` and retain every hostile-payload, pagination, abort, disposal, and live-schema test.

- [ ] **Step 2: Run CNB tests and verify RED**

Run: `npx vitest run tests/route.test.ts tests/provider.test.ts`

Expected: FAIL because the CNB adapter modules do not exist and route fields still use `kind/repo/filePath`.

- [ ] **Step 3: Move CNB logic behind the adapter**

Move route-specific code from `src/shared/route.ts` to `src/platforms/cnb/route.ts`, changing only normalized field names:

```ts
export function reconcileCnbRoute(url: URL, refs: readonly RefOption[], head: string): PlatformRoute {
  const candidates = [...new Set([head, ...refs.map(({ name }) => name)])]
    .sort((left, right) => right.length - left.length);
  for (const knownRef of candidates) {
    const route = parseCnbRoute(url, { knownRef });
    if (route.kind !== "unsupported" && route.view === "blob" && route.ref === knownRef) return route;
  }
  return parseCnbRoute(url);
}
```

Move CNB DTO validation and request orchestration from `src/content/provider.ts` to `src/platforms/cnb/provider.ts`. Keep array-length bounds, own-data descriptor checks, cancellation, and deduplication behavior byte-for-byte equivalent. Implement `cnbAdapter` in `src/platforms/cnb/index.ts` using the exact `https://cnb.cool` origin.

- [ ] **Step 4: Add a behavior-equivalence assertion**

```ts
it("builds the same canonical encoded CNB file URL", () => {
  const route = { platform: "cnb", view: "root", repository: "acme/platform/web", ref: null, path: null } as const;
  expect(buildCnbFileUrl(route, "release/v1", "src/a b.ts").href).toBe(
    "https://cnb.cool/acme/platform/web/-/blob/release%2Fv1/src/a%20b.ts",
  );
});
```

- [ ] **Step 5: Run the full existing regression suite**

Run: `npm test && npm run typecheck && npm run lint`

Expected: the existing CNB suite remains green with no snapshot or behavior weakening.

- [ ] **Step 6: Commit**

```bash
git add src/platforms/cnb src/shared/route.ts src/content/provider.ts tests/route.test.ts tests/provider.test.ts
git commit -m "refactor: isolate CNB repository adapter"
```

---

### Task 3: GitHub Routes, Ref Reconciliation, and Native URLs

**Files:**
- Create: `src/platforms/github/route.ts`
- Create: `tests/github-route.test.ts`

**Interfaces:**
- Consumes: shared platform route types, path primitives, and `RefOption`.
- Produces: `parseGitHubRoute(url, hints?)`, `reconcileGitHubRoute(url, refs, head)`, `buildGitHubFileUrl(route, ref, path)`, and `buildGitHubRefRootUrl(route, ref)`.
- Rule: a root route is resolved immediately; tree/blob suffixes remain provisional until longest-ref reconciliation.

- [ ] **Step 1: Write failing GitHub route tests**

```ts
// tests/github-route.test.ts
import { describe, expect, it } from "vitest";
import { buildGitHubFileUrl, buildGitHubRefRootUrl, parseGitHubRoute, reconcileGitHubRoute } from "../src/platforms/github/route";

describe("GitHub routes", () => {
  it.each([
    ["https://github.com/acme/repo", { view: "root", ref: null, path: null }],
    ["https://github.com/acme/repo/tree/main/src", { view: "tree", ref: "main", path: "src" }],
    ["https://github.com/acme/repo/blob/main/src/a%20b.ts", { view: "blob", ref: "main", path: "src/a b.ts" }],
  ])("parses %s", (href, expected) => {
    expect(parseGitHubRoute(new URL(href))).toMatchObject({ platform: "github", repository: "acme/repo", ...expected });
  });

  it("resolves the longest branch or tag prefix", () => {
    const refs = ["release", "release/v1", "release/v1/patch"].map((name) => ({ kind: "branch" as const, name, sha: "synthetic" }));
    expect(reconcileGitHubRoute(
      new URL("https://github.com/acme/repo/blob/release/v1/patch/src/app.ts"), refs, "main",
    )).toMatchObject({ ref: "release/v1/patch", path: "src/app.ts" });
  });

  it.each(["issues", "pulls", "actions", "releases", "settings", "commits", "security", "insights"])(
    "rejects the non-code route %s", (section) => {
      expect(parseGitHubRoute(new URL(`https://github.com/acme/repo/${section}`))).toEqual({ kind: "unsupported" });
    },
  );

  it("builds canonical per-segment GitHub URLs", () => {
    const route = { platform: "github", view: "root", repository: "acme/repo", ref: null, path: null } as const;
    expect(buildGitHubFileUrl(route, "release/v1", "src/a b.ts").href)
      .toBe("https://github.com/acme/repo/blob/release/v1/src/a%20b.ts");
    expect(buildGitHubRefRootUrl(route, "release/v1").href)
      .toBe("https://github.com/acme/repo/tree/release/v1");
  });
});
```

Add rejection cases for HTTP, `www.github.com`, non-default ports, credentials, one-segment paths, empty segments, malformed encodings, encoded slashes in owner/repository/path, control characters, and encoded dot segments.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/github-route.test.ts`

Expected: FAIL because the GitHub route module does not exist.

- [ ] **Step 3: Implement strict parsing and longest-prefix reconciliation**

Implement exact two-segment repository ownership and this route result shape:

```ts
const unsupportedGitHubSections = new Set([
  "issues", "pulls", "actions", "projects", "wiki", "security", "pulse", "graphs",
  "settings", "releases", "commits", "branches", "tags", "network", "stargazers", "watchers", "forks", "insights",
]);

export function reconcileGitHubRoute(url: URL, refs: readonly RefOption[], head: string): PlatformRoute {
  const names = [...new Set([head, ...refs.map(({ name }) => name)])]
    .sort((left, right) => right.split("/").length - left.split("/").length || right.length - left.length);
  for (const knownRef of names) {
    const candidate = parseGitHubRoute(url, { knownRef });
    if (candidate.kind !== "unsupported" && candidate.ref === knownRef) return candidate;
  }
  return parseGitHubRoute(url);
}
```

GitHub refs are encoded one segment at a time in native URLs, unlike CNB's single encoded ref component.

- [ ] **Step 4: Run focused route suites and static checks**

Run: `npx vitest run tests/github-route.test.ts tests/route.test.ts && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platforms/github/route.ts tests/github-route.test.ts
git commit -m "feat: parse GitHub repository routes"
```

---

### Task 4: Platform-Qualified Bridge Protocol and Isolated Request Allowlists

**Files:**
- Create: `src/platforms/cnb/requests.ts`
- Create: `src/platforms/github/requests.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/page/allowlist.ts`
- Modify: `src/content/bridge-client.ts`
- Modify: `tests/allowlist.test.ts`
- Modify: `tests/bridge-client.test.ts`
- Modify: `tests/page-bridge.test.ts`

**Interfaces:**
- Produces discriminated operations with mandatory `platform`:

```ts
type CnbBridgeOperation =
  | { platform: "cnb"; type: "list-directory"; repository: string; ref: string; path: string }
  | { platform: "cnb"; type: "get-head"; repository: string }
  | { platform: "cnb"; type: "list-branches" | "list-tags"; repository: string; page: number; pageSize: number };

type GitHubBridgeOperation =
  | { platform: "github"; type: "repository-page"; repository: string; ref: string | null; path: string; view: "root" | "tree" | "blob" }
  | { platform: "github"; type: "refs-page"; repository: string; kind: "branches" | "tags"; page: number };
```

- Produces: `AllowedRequest = { url: URL; accept: "json" | "html"; maximumBodyUnits: number }` and `buildAllowedRequest(operation)`.
- Invariant: current `window.location.origin` must equal the operation platform origin before fetch.

- [ ] **Step 1: Write cross-platform allowlist tests**

```ts
it("builds isolated CNB and GitHub request shapes", () => {
  expect(buildAllowedRequest({ platform: "cnb", type: "get-head", repository: "acme/repo" })).toMatchObject({
    url: new URL("https://cnb.cool/acme/repo/-/git/head"), accept: "json",
  });
  expect(buildAllowedRequest({ platform: "github", type: "repository-page", repository: "acme/repo", ref: "main", path: "src", view: "tree" })).toMatchObject({
    url: new URL("https://github.com/acme/repo/tree/main/src"), accept: "html", maximumBodyUnits: 2_000_000,
  });
});

it("rejects cross-platform and arbitrary request confusion", () => {
  expect(() => buildAllowedRequest({ platform: "github", type: "get-head", repository: "acme/repo" } as never)).toThrow(TypeError);
  expect(() => buildAllowedRequest({ platform: "github", type: "fetch", url: "https://evil.example", method: "POST" } as never)).toThrow(TypeError);
});
```

Add exact expected URLs for GitHub root, tree/blob page, `/branches/all?page=2`, and `/tags?after=<cursor>` only if Task 6's observed contract requires a cursor; until then the typed tags request must stay on the documented page-number contract and be rejected by the provider if observation proves it invalid.

- [ ] **Step 2: Run bridge/allowlist tests and verify RED**

Run: `npx vitest run tests/allowlist.test.ts tests/bridge-client.test.ts tests/page-bridge.test.ts`

Expected: FAIL because bridge operations lack `platform`, GitHub operations, and bounded response metadata.

- [ ] **Step 3: Split request builders and harden envelope validation**

Implement platform dispatch with no default URL fallback:

```ts
export function buildAllowedRequest(operation: BridgeOperation): AllowedRequest {
  switch (operation.platform) {
    case "cnb": return buildCnbAllowedRequest(operation);
    case "github": return buildGitHubAllowedRequest(operation);
    default: throw new TypeError("Unsupported bridge platform");
  }
}
```

Every operation validator must require only the exact own keys for its discriminant and reject accessors, inherited fields, non-finite pagination, invalid segments, caller-provided origins, URLs, methods, headers, credentials, redirect modes, and body limits.

- [ ] **Step 4: Update all CNB callers without changing request URLs**

Change CNB provider calls from `{ type, repo }` to `{ platform: "cnb", type, repository }`. Update bridge-client typing and tests to ensure the correlation envelope still accepts only exact own scalar fields.

- [ ] **Step 5: Run focused and full validation**

Run: `npx vitest run tests/allowlist.test.ts tests/bridge-client.test.ts tests/page-bridge.test.ts tests/provider.test.ts && npm test && npm run typecheck && npm run lint`

Expected: PASS and every CNB URL remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/platforms/cnb/requests.ts src/platforms/github/requests.ts src/shared/protocol.ts src/page/allowlist.ts src/content/bridge-client.ts tests/allowlist.test.ts tests/bridge-client.test.ts tests/page-bridge.test.ts tests/provider.test.ts
git commit -m "refactor: qualify bridge requests by platform"
```

---

### Task 5: Bounded JSON/HTML MAIN-World Transport

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/page/bridge.ts`
- Modify: `tests/page-bridge.test.ts`

**Interfaces:**
- Produces successful envelopes with `data: unknown` for CNB JSON and `text: string` for GitHub HTML; the variants remain discriminated by `format: "json" | "text"`.
- Enforces exact active-origin matching and `2_000_000` maximum text units before a successful GitHub response leaves MAIN world.
- Maps oversized, redirected cross-origin, login-page, malformed-body, and unexpected content-type results to fixed metadata-free errors.

- [ ] **Step 1: Write failing bounded-transport tests**

```ts
it("fetches GitHub HTML with the active session and returns bounded text", async () => {
  const html = '<html><script type="application/json" data-target="react-app.embeddedData">{}</script></html>';
  fetchMock.mockResolvedValue(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  await expect(handleBridgeRequest({
    channel: "c", requestId: "r",
    operation: { platform: "github", type: "repository-page", repository: "acme/repo", ref: null, path: "", view: "root" },
  }, fetchMock, "https://github.com")).resolves.toEqual({
    channel: "c", requestId: "r", ok: true, status: 200, format: "text", text: html,
  });
  expect(fetchMock).toHaveBeenCalledWith("https://github.com/acme/repo", {
    method: "GET", credentials: "include", headers: { Accept: "text/html" }, cache: "no-store", redirect: "follow",
  });
});

it("rejects an oversized GitHub page without returning any prefix", async () => {
  fetchMock.mockResolvedValue(new Response("x".repeat(2_000_001), { headers: { "Content-Type": "text/html" } }));
  await expect(handleBridgeRequest(githubRequest, fetchMock, "https://github.com"))
    .resolves.toMatchObject({ ok: false, code: "compatibility" });
});
```

Also test active-origin mismatch, `response.url` crossing origin after redirect, non-HTML GitHub success, CNB JSON preservation, 401/403/404/429/5xx body non-reading, and sanitized body-read errors.

- [ ] **Step 2: Run the page bridge suite and verify RED**

Run: `npx vitest run tests/page-bridge.test.ts`

Expected: FAIL because the handler supports only JSON and has no active-origin/body-size contract.

- [ ] **Step 3: Implement the bounded response reader**

Use `Response.body.getReader()` with `TextDecoder` when a stream is present; increment decoded UTF-16 length and cancel the reader as soon as the limit is exceeded. Fall back to `response.text()` only when no stream exists, then check length before constructing a success envelope. Never include body fragments or caught messages in failures.

```ts
async function readBoundedText(response: Response, maximumBodyUnits: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (text.length > maximumBodyUnits) throw new RepositoryError("compatibility");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maximumBodyUnits) throw new RepositoryError("compatibility");
    }
    text += decoder.decode();
    if (text.length > maximumBodyUnits) throw new RepositoryError("compatibility");
    return text;
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 4: Keep installation exact-origin and idempotent**

Install bridge/history hooks only when `window.location.origin` is `https://cnb.cool` or `https://github.com`. Pass that origin into `handleBridgeRequest`; reject operations for the other platform before calling fetch.

- [ ] **Step 5: Run full validation**

Run: `npm test && npm run typecheck && npm run lint`

Expected: PASS with no raw body output.

- [ ] **Step 6: Commit**

```bash
git add src/shared/protocol.ts src/page/bridge.ts tests/page-bridge.test.ts
git commit -m "feat: add bounded GitHub page transport"
```

---

### Task 6: Observe Public GitHub Response Shapes and Create Synthetic Fixtures

**Files:**
- Create: `docs/research/2026-11-09-github-public-page-contract.md`
- Create: `tests/fixtures/github.ts`
- Create: `tests/github-fixture.test.ts`
- Modify: `src/platforms/github/requests.ts`

**Interfaces:**
- Produces: a source-free schema record naming the exact public selectors/JSON property paths used by decoder version `github-html-v1`.
- Produces: hand-authored synthetic fixtures `githubRootHtmlFixture`, `githubTreeHtmlFixture`, `githubBranchesHtmlFixture`, `githubTagsHtmlFixture`, `githubLoginHtmlFixture`, and `githubNotFoundHtmlFixture`.
- Prohibits: committing downloaded HTML, response headers, cookies, public account data beyond the fixed synthetic `acme/repo`, or any private repository data.

- [ ] **Step 1: Run a public-only, no-cookie observation in a temporary directory**

Use only `https://github.com/octocat/Hello-World`, with no browser profile, Cookie header, token, or authenticated endpoint:

```bash
OBS_DIR=$(mktemp -d)
curl --fail --silent --show-error --location --max-filesize 3000000 \
  -H 'Accept: text/html' -H 'Cookie:' \
  'https://github.com/octocat/Hello-World' -o "$OBS_DIR/root.html"
curl --fail --silent --show-error --location --max-filesize 3000000 \
  -H 'Accept: text/html' -H 'Cookie:' \
  'https://github.com/octocat/Hello-World/branches/all' -o "$OBS_DIR/branches.html"
```

Inspect only selector names and JSON key paths with `rg`; do not print or copy full script bodies. Remove the temporary directory after recording the schema summary. If GitHub blocks unauthenticated curl, use the already-open public browser page only after action-time confirmation and still record no response body.

- [ ] **Step 2: Record the accepted decoder contract without raw samples**

The research note must contain:

```markdown
## github-html-v1
- Observation target: public `octocat/Hello-World`, no cookies or token.
- Repository page selector: write the literal selector verified by the observation.
- Required JSON paths: write the literal property paths for current ref, tree entries, and entry kind.
- Branch selector/paths: write the literal selector and normalized field paths.
- Tag selector/paths: write the literal selector and normalized field paths.
- Login/not-found discriminators: write the HTTP status and literal metadata-free marker.
- Request URLs: write the literal root, tree, branches, and tags pathname/query shapes.
- Bounds: 2,000,000 HTML units; 10 pages; 100 normalized refs per page.
- Raw pages were stored only under a temporary directory and deleted.
```

Every instruction line above is replaced by its observed literal selector/path before the research note is committed. If no stable selector supports one required operation, stop Task 6 with `BLOCKED` and the missing operation; do not invent a decoder contract.

- [ ] **Step 3: Write synthetic fixtures and a failing fixture-shape test**

Hand-author minimal HTML using only `acme/repo`, `main`, `release/v1`, `src`, `a.ts`, and synthetic hashes. The test must assert that fixtures contain no observed target repository name and no authentication material:

```ts
it("keeps GitHub fixtures synthetic and credential-free", () => {
  const joined = githubFixtures.join("\n");
  expect(joined).not.toContain("octocat");
  expect(joined).not.toMatch(/cookie|authorization|bearer|user[_-]?login/i);
  expect(joined).toContain("acme/repo");
});
```

- [ ] **Step 4: Align the typed request builder to the observed public routes**

If observation proves GitHub uses cursor-based tag pagination, change only the GitHub `refs-page` operation to a discriminated cursor field and update Task 4 tests/callers in the same commit. Do not introduce a generic query map.

- [ ] **Step 5: Run fixture, allowlist, privacy, and static checks**

Run: `npx vitest run tests/github-fixture.test.ts tests/allowlist.test.ts tests/privacy.test.ts && npm run typecheck && npm run lint && git diff --check`

Expected: PASS; `rg -n 'octocat|Hello-World|<html' docs/research tests/fixtures/github.ts` finds no live response body or public target identifier outside the research note's single observation-target line.

- [ ] **Step 6: Commit**

```bash
git add docs/research/2026-11-09-github-public-page-contract.md tests/fixtures/github.ts tests/github-fixture.test.ts src/platforms/github/requests.ts tests/allowlist.test.ts
git commit -m "test: capture synthetic GitHub page contract"
```

---

### Task 7: Strict GitHub HTML Decoder and Provider

**Files:**
- Create: `src/platforms/github/decoder.ts`
- Create: `src/platforms/github/provider.ts`
- Create: `tests/github-decoder.test.ts`
- Create: `tests/github-provider.test.ts`

**Interfaces:**
- Consumes: Task 6's exact `github-html-v1` selectors/paths and fixtures, `BridgeClient`, and normalized provider types.
- Produces: `decodeGitHubRepositoryPage(html, expected)`, `decodeGitHubRefsPage(html, kind)`, and `createGitHubProvider(client)`.
- Decoder output contains only copied strings and arrays: `{ head, listing }` for repository pages and `{ refs, hasNextPage, nextCursor? }` for ref pages.

- [ ] **Step 1: Write failing decoder tests against all synthetic versions**

```ts
it("decodes a repository page into copied normalized scalars", () => {
  const decoded = decodeGitHubRepositoryPage(githubTreeHtmlFixture, {
    repository: "acme/repo", ref: "main", path: "src", view: "tree",
  });
  expect(decoded).toEqual({
    head: "main",
    listing: {
      path: "src", sha: "synthetic-tree-sha",
      entries: [{ kind: "file", name: "a.ts", path: "src/a.ts", sha: "synthetic-blob-sha" }],
    },
  });
});

it.each([
  "", "<html></html>", githubLoginHtmlFixture, githubNotFoundHtmlFixture,
  githubTreeHtmlFixture.replace("synthetic-blob-sha", ""),
])("fails closed on unsupported GitHub HTML %#", (html) => {
  expect(() => decodeGitHubRepositoryPage(html, expectedTree)).toThrowErrorMatchingObject({ code: "compatibility" });
});
```

Add tests for duplicate keys, wrong repository/ref/path, malformed JSON, accessors/proxies passed through exported low-level snapshot helpers, path escape, unsupported entry kind, more than 10,000 entries, and no retention/mutation of intermediate data.

- [ ] **Step 2: Run decoder tests and verify RED**

Run: `npx vitest run tests/github-decoder.test.ts`

Expected: FAIL because the decoder does not exist.

- [ ] **Step 3: Implement the versioned fail-closed decoder**

Use `DOMParser` in isolated world; select only Task 6's exact node; use `textContent`; `JSON.parse`; then own-data descriptor validation copied into a small local snapshot layer. Do not use `innerHTML`, broad `script` scans, regex parsing of arbitrary HTML, live page DOM, dynamic property walking, or exception interpolation.

```ts
export function decodeGitHubRepositoryPage(html: string, expected: GitHubExpectedPage): GitHubRepositoryPage {
  if (typeof html !== "string" || html.length === 0 || html.length > GITHUB_MAX_HTML_UNITS) {
    throw new RepositoryError("compatibility");
  }
  try {
    return decodeGitHubHtmlV1(html, expected);
  } catch {
    throw new RepositoryError("compatibility");
  }
}
```

- [ ] **Step 4: Write provider RED tests for exact operations, pagination, cancellation, and partial failure**

```ts
it("loads a GitHub directory through the exact repository-page operation", async () => {
  const request = vi.fn().mockResolvedValue({ format: "text", text: githubTreeHtmlFixture });
  const provider = createGitHubProvider({ request, dispose: vi.fn() });
  await expect(provider.listDirectory("acme/repo", "main", "src")).resolves.toMatchObject({ path: "src" });
  expect(request).toHaveBeenCalledExactlyOnceWith({
    platform: "github", type: "repository-page", repository: "acme/repo", ref: "main", path: "src", view: "tree",
  }, { signal: undefined });
});

it("fails explicitly when the bounded last ref page is still full", async () => {
  const provider = createGitHubProvider(clientReturningTenFullPages);
  await expect(provider.listBranches("acme/repo")).rejects.toMatchObject({ code: "compatibility" });
});
```

- [ ] **Step 5: Implement provider orchestration and run focused tests**

`getHead` requests the repository root and decodes its canonical current/default ref. `listDirectory` selects root/tree view by path. Ref methods request at most 10 pages, deduplicate by name, sort, honor abort before and after decode, and throw `RepositoryError("compatibility")` rather than return a partial list when pagination is incomplete.

Run: `npx vitest run tests/github-decoder.test.ts tests/github-provider.test.ts tests/provider.test.ts`

Expected: PASS.

- [ ] **Step 6: Run full validation and commit**

Run: `npm test && npm run typecheck && npm run lint`

```bash
git add src/platforms/github/decoder.ts src/platforms/github/provider.ts tests/github-decoder.test.ts tests/github-provider.test.ts
git commit -m "feat: decode GitHub repository pages"
```

---

### Task 8: Platform Registry, Bootstrap Selection, and Neutral Controller

**Files:**
- Create: `src/platforms/github/index.ts`
- Create: `src/platforms/registry.ts`
- Modify: `src/platforms/cnb/index.ts`
- Modify: `src/content/controller.ts`
- Modify: `src/content/index.ts`
- Modify: `tests/controller.test.ts`
- Modify: `tests/bootstrap.test.ts`
- Create: `tests/platform-registry.test.ts`

**Interfaces:**
- Produces: `platformForUrl(url): RepositoryPlatformAdapter | null` and `supportedOrigins` in exact order `cnb`, `github`.
- Controller dependency changes to `{ adapter, provider, store, preferences, ... }`.
- Bootstrap creates one bridge/provider/store/controller session for the exact current origin; unsupported origins create no controller.

- [ ] **Step 1: Write registry and GitHub controller RED tests**

```ts
it.each([
  ["https://cnb.cool/acme/repo", "cnb"],
  ["https://github.com/acme/repo", "github"],
])("selects the adapter for %s", (href, id) => {
  expect(platformForUrl(new URL(href))?.id).toBe(id);
});

it.each(["http://github.com/acme/repo", "https://www.github.com/acme/repo", "https://gitlab.com/acme/repo"])(
  "rejects unsupported origin %s", (href) => expect(platformForUrl(new URL(href))).toBeNull(),
);

it("opens a GitHub file through its adapter", async () => {
  const t = setup({ platform: "github", href: "https://github.com/acme/repo/blob/main/a.ts" });
  await t.navigate();
  t.actions.onOpenFile("a.ts");
  expect(t.nativeNavigate).toHaveBeenCalledWith("https://github.com/acme/repo/blob/main/a.ts");
});
```

Duplicate the platform-neutral controller matrix over both adapters for root load, same-ref file navigation, ref replacement, longest slash ref, missing path fallback, refresh, loaded search, full-tree traversal, auth clearing, repository replacement, back/forward, late response suppression, and destroy.

- [ ] **Step 2: Run registry/controller/bootstrap tests and verify RED**

Run: `npx vitest run tests/platform-registry.test.ts tests/controller.test.ts tests/bootstrap.test.ts`

Expected: FAIL because the controller imports CNB route functions directly and bootstrap always constructs the CNB provider.

- [ ] **Step 3: Implement exact-origin registry and GitHub adapter**

```ts
const adapters = Object.freeze([cnbAdapter, githubAdapter] as const);
export const supportedOrigins = Object.freeze(adapters.map(({ origin }) => origin));
export function platformForUrl(url: URL): RepositoryPlatformAdapter | null {
  return adapters.find(({ origin }) => url.origin === origin && url.username === "" && url.password === "") ?? null;
}
```

`githubAdapter` wires route, provider, and layout modules only; it contains no controller state.

- [ ] **Step 4: Generalize controller route and URL behavior**

Replace direct `parseCnbRoute`, `buildBlobUrl`, provisional route, and reconciliation calls with adapter methods. Rename state fields from `repo/filePath` to `repository/path`. Keep generation, abort, synchronous auth scrub, traversal cancellation, preference serialization, and late-result suppression unchanged.

Store sessions continue to use the display-safe repository string because the adapter-bound provider and controller carry platform identity; every bridge operation still includes `platform`.

- [ ] **Step 5: Generalize bootstrap lifecycle**

At controller creation, call `platformForUrl(new URL(target.location.href))`; create the adapter's provider and a matching store. If an event reports an origin different from the active adapter, destroy the session before any new work. Preserve DOMContentLoaded, BFCache suspend/resume, interval validity checks, re-injection replacement, and teardown behavior.

- [ ] **Step 6: Run lifecycle and full validation**

Run: `npx vitest run tests/platform-registry.test.ts tests/controller.test.ts tests/bootstrap.test.ts tests/tree-store.test.ts tests/search.test.ts && npm test && npm run typecheck && npm run lint`

Expected: PASS on both platform matrices.

- [ ] **Step 7: Commit**

```bash
git add src/platforms/github/index.ts src/platforms/registry.ts src/platforms/cnb/index.ts src/content/controller.ts src/content/index.ts tests/platform-registry.test.ts tests/controller.test.ts tests/bootstrap.test.ts
git commit -m "feat: select repository platform adapters"
```

---

### Task 9: Platform-Specific Host Layout and Shared Panel UX

**Files:**
- Create: `src/platforms/github/layout.ts`
- Modify: `src/platforms/cnb/layout.ts`
- Modify: `src/content/panel.ts`
- Modify: `src/content/panel.css`
- Modify: `tests/panel.test.ts`
- Modify: `scripts/check-panel-browser.mjs`

**Interfaces:**
- `PanelOptions` gains `layout: HostLayoutAdapter` and `platform: PlatformId`.
- CNB layout preserves current root-padding behavior and restoration.
- GitHub layout offsets only verified fixed/sticky GitHub chrome and the main content container through reversible CSS variables/classes; mobile remains overlay-only.
- Panel messages become platform-neutral and metadata-free.

- [ ] **Step 1: Write failing layout-isolation and error-copy tests**

```ts
it("delegates desktop layout to the active host adapter", () => {
  const install = vi.fn(() => ({ update: vi.fn(), destroy: vi.fn() }));
  const { panel } = setup({ layout: { platform: "github", install }, platform: "github" });
  panel.render(state()); flush();
  expect(install).toHaveBeenCalledOnce();
  expect(document.documentElement.classList.contains("repotreex-panel-open")).toBe(false);
});

it.each([
  ["signed-out", "Sign in to view the repository."],
  ["forbidden", "Repository access denied."],
  ["compatibility", "Repository page format is not supported."],
])("uses platform-neutral %s copy", (code, message) => {
  const { panel } = setup(); panel.render(state({ error: { code } as TreeDirectoryError })); flush();
  expect(panel.root.textContent).toContain(message);
  expect(panel.root.textContent).not.toMatch(/CNB|GitHub/);
});
```

- [ ] **Step 2: Run panel tests and verify RED**

Run: `npx vitest run tests/panel.test.ts`

Expected: FAIL because panel owns CNB-specific page padding and strings.

- [ ] **Step 3: Extract reversible host-layout ownership**

Move page DOM mutations, prior-value capture, width updates, overlay decisions, and exact restoration into each layout adapter. `panel.ts` owns only the Shadow DOM host, panel controls, top offset measurement, and calls `layoutSession.update(open, overlay)`.

The GitHub layout must target only selectors confirmed by the public current page in Task 6 and must no-op if those containers are absent. It must never rewrite GitHub content, hide site controls, or retain repository text.

- [ ] **Step 4: Extend the real-browser panel probe**

Add a synthetic GitHub host fixture and assertions for desktop open/resize/collapse/restore, 799px overlay, fixed header top offset, dark/light/reduced-motion, keyboard tree operation, long names, focus retention, and no page-key interception when focus is outside the panel.

- [ ] **Step 5: Run panel and browser checks**

Run: `npx vitest run tests/panel.test.ts && node scripts/check-panel-browser.mjs && npm run typecheck && npm run lint`

Expected: PASS for both CNB and GitHub fixtures.

- [ ] **Step 6: Commit**

```bash
git add src/platforms/github/layout.ts src/platforms/cnb/layout.ts src/content/panel.ts src/content/panel.css tests/panel.test.ts scripts/check-panel-browser.mjs
git commit -m "feat: isolate platform host layouts"
```

---

### Task 10: Manifest Rename, Exact Permissions, and Privacy Gates

**Files:**
- Modify: `src/manifest.json`
- Modify: `tests/manifest.test.ts`
- Modify: `tests/build.test.ts`
- Modify: `tests/package.test.ts`
- Modify: `tests/privacy.test.ts`

**Interfaces:**
- Manifest name: `RepoTreeX`.
- Description: `A fast repository tree for CNB and GitHub code pages.`
- Exact host permissions and both content-script matches: `https://cnb.cool/*`, `https://github.com/*`.
- Permissions remain exactly `["storage"]`.

- [ ] **Step 1: Write failing exact-manifest and privacy assertions**

```ts
const approvedOrigins = ["https://cnb.cool/*", "https://github.com/*"];

it("uses the platform-neutral name and exact two-origin scope", () => {
  expect(manifest.name).toBe("RepoTreeX");
  expect(manifest.description).toBe("A fast repository tree for CNB and GitHub code pages.");
  expect(manifest.permissions).toEqual(["storage"]);
  expect(manifest.host_permissions).toEqual(approvedOrigins);
  for (const script of manifest.content_scripts) expect(script.matches).toEqual(approvedOrigins);
});
```

Extend forbidden production scans with `api.github.com`, `/graphql`, `Authorization`, `Cookie`, `document.cookie`, cookies APIs, mutation methods (`POST|PUT|PATCH|DELETE` in fetch initializers), raw HTML persistence, and broad host patterns such as `https://*/*`.

- [ ] **Step 2: Run manifest/build/package/privacy tests and verify RED**

Run: `npx vitest run tests/manifest.test.ts tests/build.test.ts tests/package.test.ts tests/privacy.test.ts`

Expected: FAIL because the manifest is still CNB-only.

- [ ] **Step 3: Update the manifest and test expectations**

Use identical ordered match arrays for isolated and MAIN-world scripts. Add no permissions. Keep build entries and archive entries unchanged.

- [ ] **Step 4: Prove storage and artifact boundaries**

Ensure built output contains one `chrome.storage.local` reference only in `content/index.js`, the one `repotreex.preferences` key, no `.map` files, no `docs/research`, no test fixtures, and no runtime `console.*` calls.

- [ ] **Step 5: Run complete artifact validation**

Run: `npm test && npm run typecheck && npm run lint && npm run build && npm run package && git diff --check`

Expected: PASS; archive entries remain exactly manifest, four icons, `content/index.js`, `content/panel.js`, and `page/bridge.js`.

- [ ] **Step 6: Commit**

```bash
git add src/manifest.json tests/manifest.test.ts tests/build.test.ts tests/package.test.ts tests/privacy.test.ts
git commit -m "feat: enable RepoTreeX on GitHub"
```

---

### Task 11: Multi-Platform Chromium Probe and Verification Documentation

**Files:**
- Modify: `scripts/check-content-browser.mjs`
- Create: `docs/testing/github-acceptance.md`
- Modify: `README.md`
- Modify: `tests/build.test.ts`

**Interfaces:**
- Browser probe runs fully synthetic pages for both exact origins with intercepted same-origin responses; it never contacts CNB or GitHub.
- Acceptance document separates automated public checks, user-coordinated private checks, and separately authorized sign-out/access-revocation checks.

- [ ] **Step 1: Add a failing build expectation for GitHub verification docs**

```ts
it("documents public, private, and authorization-lifecycle GitHub acceptance", () => {
  const guide = readFileSync("docs/testing/github-acceptance.md", "utf8");
  expect(guide).toContain("Public GitHub repository");
  expect(guide).toContain("Private GitHub repository");
  expect(guide).toContain("Action-time confirmation");
  expect(guide).toContain("Do not record repository names, refs, paths, screenshots, or response bodies");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/build.test.ts`

Expected: FAIL because the GitHub acceptance guide does not exist.

- [ ] **Step 3: Extend the synthetic Chromium content probe**

For each platform, verify root mount, two directory expansions, file navigation, selected reveal, slash-ref selection, loaded search, bounded traversal, resize/collapse persistence, refresh, pushState/replaceState/popstate/hashchange, BFCache pagehide/pageshow, authorization clearing, late-response suppression, unsupported-route unmount, and destroy/re-injection. Intercept every request and assert method `GET`, credentials behavior where observable, approved origin, approved path shape, and zero mutation requests.

- [ ] **Step 4: Write the privacy-preserving acceptance guide and README**

Document unpacked build location, exact permissions, same-origin HttpOnly-cookie behavior, no OAuth/token requirement, public workflows, action-time confirmation boundary, and fixed commands:

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run package
node scripts/check-content-browser.mjs
node scripts/check-panel-browser.mjs
```

The private checklist records only PASS/FAIL for function classes, never repository identifiers or screenshots.

- [ ] **Step 5: Run automated browser and documentation validation**

Run: `node scripts/check-content-browser.mjs && node scripts/check-panel-browser.mjs && npx vitest run tests/build.test.ts tests/privacy.test.ts && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-content-browser.mjs docs/testing/github-acceptance.md README.md tests/build.test.ts
git commit -m "test: verify GitHub extension workflows"
```

---

### Task 12: Clean-Install Release Gate and User-Coordinated Live Acceptance

**Files:**
- Create: `.superpowers/sdd/2026-11-09-repotreex-github-adapter/task-12-release-report.md` (git-ignored execution evidence)
- Modify: no production files unless a verified defect enters the normal fix/re-review loop.

**Interfaces:**
- Produces: a release report containing only commands, aggregate counts, PASS/FAIL categories, archive hash, and approved action outcomes.
- Does not produce: live repository names, refs, paths, screenshots, HTML, response bodies, network exports, cookies, tokens, or account identifiers.

- [ ] **Step 1: Verify a clean dependency installation in a disposable copy**

Create a temporary checkout/copy outside the repository, run `npm ci`, then:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run package
node scripts/check-content-browser.mjs
node scripts/check-panel-browser.mjs
```

Record only command exit status and aggregate test counts in the release report. Delete the disposable copy after validation.

- [ ] **Step 2: Inspect the packaged artifact without extracting private data**

Run:

```bash
unzip -Z1 dist/repotreex-0.1.0.zip
shasum -a 256 dist/repotreex-0.1.0.zip
```

Verify exact archive entries, exact two-origin manifest scope, no source maps, no fixtures/research files, and no forbidden runtime APIs. Record only the archive hash and PASS/FAIL gates.

- [ ] **Step 3: Request action-time confirmation before browser installation or reload**

Stop and ask the user to approve reloading/installing the unpacked extension in the already-open browser. Do not infer approval from earlier design approval. After approval, use the built `dist/extension` directory and make no other browser changes.

- [ ] **Step 4: Run public CNB and GitHub live acceptance**

On user-selected public repositories, run the shared workflow from the acceptance guide. Record only category outcomes such as `root load: PASS`, `slash ref: NOT AVAILABLE`, or `keyboard navigation: PASS`; do not record repository identifiers, URLs, paths, screenshots, or response bodies.

- [ ] **Step 5: Run private GitHub acceptance with user coordination**

Ask the user to open an already accessible private GitHub repository. Verify equivalent tree behavior and exact same-origin requests. Record only PASS/FAIL categories. Do not use browser export, HAR, screenshot, clipboard, cookies API, DevTools cookie view, or token copy.

- [ ] **Step 6: Separately request authorization for sign-out/access-revocation testing**

Only after explicit approval, verify that the next request clears tree/search/ref/path DOM state, shows the fixed authorization error, persists only panel preferences, and reloads after sign-in. If the user declines, mark this gate `NOT RUN — user authorization not granted`; do not treat it as passed.

- [ ] **Step 7: Run final repository validation**

Run: `git status --short && git diff --check && npm test && npm run typecheck && npm run lint`

Expected: clean worktree except the git-ignored SDD report; all commands pass.

- [ ] **Step 8: Commit only if live acceptance required a reviewed code/document change**

If no tracked files changed, create no empty commit. If a defect was fixed through the normal subagent review loop, commit those exact reviewed files with a scoped `fix:` message and rerun Steps 1–7.

---

## Plan Self-Review Checklist

- [ ] **Spec coverage:** Map design sections 1–10 to Tasks 1–12; confirm exact origins, same-session private access, GitHub decoder observation, bounded HTML, ref pagination, native navigation, lifecycle clearing, layout isolation, privacy, packaging, and browser acceptance each have an owning task.
- [ ] **Placeholder scan:** Search this plan case-insensitively for the standard unfinished-work markers named by the writing-plans skill; expected result is no matches.
- [ ] **Type consistency:** Verify `repository/path/view/platform`, `RepositoryPlatformAdapter`, bridge operation discriminants, `AllowedRequest`, provider methods, and panel layout fields use the same names and signatures in every task.
- [ ] **Task boundaries:** Confirm each task has a RED test, focused GREEN validation, full proportional validation, and an independent commit; Task 12 creates no empty commit.
