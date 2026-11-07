# Task 10 report: route/ref controller and content lifetime

## Status and scope

Implemented in `/Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex`
on `feature/repotreex-cnb-tree`, starting at `bd9e10f`. All edits and generated
artifacts stayed in this worktree. No subagents, push, merge, deployment, OAuth,
permission expansion, or live repository requests were used.

Task steps: controller/bootstrap tests DONE; initial RED DONE; orchestration
DONE; bootstrap/cleanup DONE; focused/full/type/lint/build/package/browser
validation DONE; self-review DONE. Commit follows validation with the requested
title; Git's resulting commit identifier is returned separately rather than
embedded self-referentially in this report.

## Implementation and authoritative interfaces

- Added `src/content/controller.ts`: `createRepoTreeController(dependencies)`,
  `start()`, `handleNavigation(url)`, and idempotent `destroy()`.
- Replaced the empty `src/content/index.ts` with the actual isolated-world
  entry. It creates one UUID channel per lifetime, bridge client, provider,
  in-memory store, preference store, panel/controller, and Symbol-guarded
  bootstrap. Storage adaptation resolves Chrome storage per operation.
- Added 48 controller and 10 bootstrap integration cases. Controller tests use
  the real store, preferences and panel with synthetic provider I/O. Bootstrap
  tests exercise the real bridge client/provider/store/panel chain through
  synthetic response events; no component modules are mocked.
- Added `scripts/check-content-browser.mjs`, a repeatable built-artifact probe
  using installed Playwright and Chromium, CDP isolated world plus actual MAIN
  world bridge, and locally fulfilled synthetic HTTP/document routes.
- The test environment uses the CNB origin so real history navigation is
  exercised without creating a second untyped jsdom instance.
- `route.ts`, `bridge-client.ts`, `provider.ts`, `tree-store.ts`, `search.ts`,
  `preferences.ts`, protocol, manifest and build/package contracts are unchanged.

The panel needed three additive, optional adapters required by the brief:
fixed notice identifiers for path fallback/HEAD/storage failure;
`fullTreeDisabled` for rate-limit/load gating; and `onRetryFullTree` to distinguish
an explicit retry from a blocked ordinary traversal click. Existing callers
retain their original defaults and full-search retry callback fallback. Error
states use the existing `error.code` contract, not the brief's illustrative
`status: "signed-out"` property, which the authoritative panel does not expose.

## Route/session behavior

- HEAD/branches/tags discovery starts concurrently before preference I/O. No
  tree session starts until discovery and route reconciliation succeed. HEAD
  404 alone falls back to the literal `HEAD` ref with a fixed notice; auth,
  network, server, compatibility and rate errors are surfaced instead.
- Nested slugs are preserved. Raw slash-ref URLs select the longest discovered
  branch/tag prefix. Canonical encoded slash refs are provisionally parsed only
  to identify the repository and must then match independently discovered
  ref/HEAD evidence. Unknown encoded slash boundaries and malformed file
  encodings fail closed. A simple unlisted ref remains valid for SHA navigation.
- Repository and commit pages use resolved HEAD. File-only navigation retains
  the current store session/cache, clears selection, cancels traversal and
  sequentially reveals the new path. Ref/repository replacement clears the old
  panel/store synchronously and aborts outstanding store/discovery work.
- Unsupported routes destroy the panel, restore page layout, clear data and
  leave only the content-lifetime navigation listener active for supported
  routes later. Ref options are cached only for the current repository in memory.
- Root loads precede each parent directory, loaded sequentially; ancestors are
  expanded without collapsing already-expanded parents. Blob directory paths
  are selected and expanded, but not preserved as files on ref selection.
- File clicks require a loaded non-directory node and use only
  `location.assign(buildBlobUrl(...).href)`. Ref selection navigates canonically
  first, preserving the URL file even if its ancestors are not yet loaded. The
  destination session verifies the path; only not-found/missing path falls back
  to that ref root, with `#repotreex-path-not-found` carrying a metadata-free
  notice across a document reload. Network/server/auth failures do not trigger
  a false missing-path fallback. Ref-root URLs are a narrow adapter derived
  from the canonical builder because its public path argument rejects empty paths.
- Refresh clears/restarts only the current repo/ref tree session. Failed
  discovery exposes a working retry that repeats discovery without inventing a
  session. Directory retry loads the failed directory without toggling expansion.
- Authorization clears DOM/store immediately through synchronous store
  subscription, then shows the fixed login/permission message. A separate
  session generation preserves current-session auth failures across file-only
  navigation while ignoring old-session failures. Root/ancestor and traversal
  loaders observe auth before scheduler/navigation observers detach.
- Full traversal uses the existing bounded loader/progress/result contracts.
  Navigation/destroy cancel its scheduler, suppress late progress, and replace
  sessions when appropriate. Rate limiting keeps traversal disabled even across
  file-only navigation until explicit retry/refresh. Non-auth errors keep loaded
  nodes; unrelated directory success does not erase a current-path error.
- Navigation waits settle promptly on replacement/destroy even when a synthetic
  provider ignores abort; late data cannot select/render into newer sessions.

## Bootstrap and preferences

- `Symbol.for("repotreex.instance")` owns one content lifetime. Reinjection
  destroys the older instance, including one still waiting for DOM readiness,
  before mounting a replacement. Old destroy calls cannot delete the newer key.
- Initial work waits for DOMContentLoaded when necessary. Navigation/pageshow
  use the current location only, ignoring event payload metadata. Duplicate URL
  events do not reload the session. Development teardown is opt-in and is not
  registered in production.
- Pagehide and explicit teardown remove all owned readiness/navigation/pagehide/
  development listeners, abort work, unsubscribe, dispose the provider/bridge,
  cancel the context timer, clear state and destroy panel/layout ownership.
  Panel-cleanup failures still allow store/provider disposal, then propagate.
- Extension validity is checked before ready/navigation work and once per second
  via `chrome.runtime.id`; inaccessible/absent runtime destroys the lifetime.
- Preferences load once per lifetime; load failure uses defaults with a fixed
  visible notice. Saves are serialized through the unchanged PreferenceStore
  read/modify/write contract. Only boolean open/numeric width patches are passed;
  no repo/ref/path/query/sha enters storage. Save failures show a fixed tab-only
  notice and leave live tab settings intact across panel unmount/remount. Queued
  saves after destruction are dropped; already-issued Chrome storage writes are
  not cancellable, and late outcomes cannot recreate UI.
- Production content has no console logging, OAuth, cookie access, metadata
  persistence or new fetch surface. Error rendering retains only fixed codes.

## TDD and self-review evidence

Initial `npm test -- tests/controller.test.ts tests/bootstrap.test.ts` under
Node 24 exited 1: controller import absent and all nine original bootstrap cases
failed because the original entry exported no bootstrap function, as specified.
The first implementation produced 35 passing / 2 failing cases, identifying
the cached-ref clearing/reconciliation integration defect (and a corrected
snapshot-identity test assumption). jsdom's absent scrollIntoView was adapted
only in tests; browser verification uses the native implementation.

Additional RED/GREEN cycles reproduced and fixed discovery sibling abort while
preferences are pending, rate gating across file navigation, stale current-path
error clearing, initially invalid context, abandoned navigation/ancestor waits,
auth errors from same-session old-navigation loaders, directory-ref navigation,
ref selection before ancestor completion, and disposal fan-out. Tests also cover
late old root data, refresh abort, serialized persistence, failed-save remount,
queued-save teardown, and unpublished partial discovery.

Self-review checked generation versus session ownership, all async error routes,
immediate sensitive DOM clearing, canonical navigation, narrow fallback behavior,
full-search retry/cancel gating, late storage callbacks, listener disposal and
production bundle contents. Existing 60 panel regressions remain green. No
unresolved implementation finding remains; external boundaries follow below.

## Final direct validation

All authoritative final commands used Node **24.22.2**, not the workstation's
default Node 23. The runtime was selected once with:

```sh
export PATH=/Users/bytedance/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH
node --version
npm test -- tests/controller.test.ts tests/bootstrap.test.ts tests/panel.test.ts
npm test
npm run typecheck
npm run lint
npm run build
npm run package
unzip -t dist/repotreex-0.1.0.zip
git diff --check
```

- Focused: **118/118** passed (48 controller, 10 bootstrap, 60 panel).
- Full: **679/679** passed in 13 files, including timezone-independent package
  byte identity. No unhandled test errors.
- Both TypeScript scopes, ESLint and diff whitespace checks passed.
- Chrome 120 build and package succeeded; ZIP integrity passed for every entry.
  Build now includes actual controller/provider/store/search/preferences/panel
  wiring in `content/index.js` through the existing esbuild import graph;
  no build-script or permission change was necessary.
- Content entry SHA-256:
  `e1834768ee15ca52c3551f8d6a1be9c3b92080228f82e6b7b445ed2bf6072cba`.
- Package: `dist/repotreex-0.1.0.zip`, SHA-256:
  `d2a6cdf2f71322bea94e3375d7c7561d76c5342e2f777cff437e406c39b3f0c9`.

Synthetic Chromium commands (Node 24, cached tools, no installations/server):

```sh
export PLAYWRIGHT_MODULE_PATH=/Users/bytedance/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs
export CHROMIUM_EXECUTABLE_PATH=/Users/bytedance/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell
node scripts/check-content-browser.mjs
node scripts/check-panel-browser.mjs
```

Both passed against the final bundle. The new probe runs production content in
an isolated world and production bridge in MAIN, including document-start
content-before-bridge ordering with DOM readiness released after bridge setup.
It verifies nested/raw/encoded slash refs, sequential ancestors, file-only SPA
cache, loaded search, open-only serialized storage, refresh, 429 retry/gating,
traversal/navigation cancellation and late response, real Location.assign ref
change and missing-path fallback/reload notice, 401 clearing, reinjection,
context invalidation, and no remount after destruction.

All HTTP traffic is intercepted and locally fulfilled; no CNB network or private
session access occurs. No application console errors/warnings occurred. Chromium
itself emits the two expected resource diagnostics for injected 401/429, which
the probe distinguishes and asserts. Existing four panel browser regressions
also passed desktop/mobile hostile cascade, important-padding restoration,
real pointer resize, focused-row scrolling, empty/retry focus and keyup isolation.

## Boundaries and concerns

1. Live authenticated CNB API/schema/chrome behavior and an actually installed
   extension are not tested. The browser probe uses real Chromium isolation and
   built artifacts, with a synthetic Chrome storage/runtime shim and intercepted
   HTTP. Real authenticated acceptance remains necessary without metadata logging.
2. TreeStore does not expose per-directory cancellation. File-only navigation
   and explicit full-search cancel stop traversal scheduling/progress immediately,
   but already-issued same-session shared directory loads can finish into the
   retained cache. Ref/repo replacement, unsupported routes and teardown abort
   every store request. The unchanged MAIN bridge has no fetch-abort protocol;
   isolated-side abort drops pending correlation and ignores late replies, not
   necessarily the browser's already-issued network GET. No contract was broadened
   to claim stronger network cancellation.
3. Pagehide destroys the lifetime, including BFCache pagehide; subsequent pageshow
   cannot revive that destroyed instance. A new content-script execution is required
   to restore it, consistent with explicit pagehide cleanup. Runtime invalidation
   detection is immediate on navigation and otherwise up to one second.
4. A path is verified by successful ancestor directory listings and presence in
   the resulting tree; the provider/bridge has no file-content request contract.
   Same-repository ref options remain lifetime-memory cached until repository
   change/retry discovery; refresh intentionally refreshes only the current tree.
5. Cold refs discovery waits for complete paginated branches and tags to establish
   the longest boundary. Large live ref catalogs and repository rendering scale
   need performance acceptance beyond these bounded synthetic fixtures.
6. No sensitive metadata is persisted or logged. The fixed fallback hash conveys
   only a notice flag, not a repository path or ref payload.

## Commit/hook handling

The reviewed scope includes this requested report plus controller, content entry,
optional panel adapters, integration tests, test origin configuration and the
repeatable synthetic Chromium probe. Generated dist files remain ignored.
After the direct checks above, the normal `git commit -F` attempt exited 1
only with `bash: script/pre_commit_checks.sh: No such file or directory`.
The user-authorized `git commit --no-verify -F` retry uses the same reviewed
scope/message. No hook or Git configuration is modified; branch/worktree are
preserved without push.
