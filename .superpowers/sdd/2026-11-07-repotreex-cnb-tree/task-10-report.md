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

## Fix round 1

Implemented all four Important review findings on `feature/repotreex-cnb-tree`
starting from `a19d289`, in the requested worktree only, without subagents.

### Changed files and recovery behavior

- `src/content/index.ts`: separate the Symbol-owned lifecycle listeners from
  the disposable bridge/provider/store/controller lifetime. Persisted pagehide
  destroys that lifetime, removes the host, scrubs sensitive state, aborts
  pending isolated-side requests and stops the context timer. Only the lightweight
  resume owner remains. Persisted pageshow creates a fresh lifetime and channel;
  repeated pageshow does not duplicate it. Reinjection transfers the suspension
  flag before destroying the previous owner. Final pagehide, development teardown
  and invalidation permanently remove ownership/listeners. This supersedes the
  original report's BFCache concern (boundary 3).
- `src/content/controller.ts`: same-session load observers preserve late 429
  throttling after navigation or traversal detachment, independently of operation
  generation. Old sessions/lifetimes cannot throttle the replacement. Ordinary
  traversal stays disabled until explicit retry/refresh; fixed error-code privacy
  and immediate authorization clearing remain unchanged.
- `src/content/controller.ts`: keep directory errors by path and reveal errors
  by failed dependency plus navigation token, in memory only. Matching successful
  directory recovery removes only its matching error and resumes sequential
  reveal/selection if the current navigation still owns the blocked dependency.
  Other directory errors remain, and full-tree success cannot clear directory-
  or reveal-owned failures. Navigation/refresh/clearing discard outgoing owners.
- `src/content/controller.ts`: serialized saves carry cumulative intended
  open/width state instead of independent patches. A revision guard prevents an
  older successful save from hiding the failure notice while newer intent is
  still pending. A current cumulative success reconciles the normalized settings
  and clears the fixed notice; read and write failures retain it. Destroyed
  controllers skip queued saves and ignore late notice updates.
- `tests/controller.test.ts`, `tests/bootstrap.test.ts`: integration regressions
  using real controller/store/preferences/panel and bootstrap/bridge/provider
  wiring with synthetic I/O only; 14 new controller and 6 new bootstrap cases.
  Corrected the existing unrelated-directory-success fixture so its successful
  directory is actually unrelated to the blocked reveal dependency.
- `scripts/check-content-browser.mjs`: extend the production-bundle Chromium
  probe for cumulative preference failure/pending-success recovery, detached
  same-session 429 gating, matching directory retry plus resumed selection,
  search-error ownership, persisted lifecycle scrub/fresh-channel resume and
  stale old-lifetime responses observed through the actual MAIN bridge. Verify
  reinjection while suspended and exactly one resume. Advance synthetic
  `readyState` to complete at DOMContentLoaded, matching browser semantics for
  the subsequent reinjection check. Existing panel browser probe is unchanged.

No authoritative route, bridge, provider, store, search, preference or panel
interface changes. Manifest/build/package files are unchanged; production
content still bundles the real entry, and permissions remain only storage plus
the exact CNB host. No OAuth, application metadata logging or metadata storage.

### TDD evidence

With regression tests added before production edits:

```sh
export PATH=/Users/bytedance/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH
node --version
npm test -- tests/controller.test.ts tests/bootstrap.test.ts tests/panel.test.ts
```

Node reported `v24.22.2`. RED: **11 failed, 122 passed (133 total)**,
reproducing lost BFCache ownership, three detached late-429 cases, three matching
retry/reveal failures, stale directory errors, unrelated full-search error
clearing, lost cumulative preferences and premature notice clearing. The
suspended-reinjection regression was then tightened before its production
adjustment: `npm test -- tests/bootstrap.test.ts` produced **1 failed, 13 passed**
because reinjection incorrectly issued new requests while still suspended.

The updated `node scripts/check-content-browser.mjs` also failed against the
prior built entry before rebuilding, observing `panelOpen: true` instead of the
required cumulative `panelOpen: false` after the failed open-state write.
After the fixes, direct integration tests and the rebuilt-browser probe passed.

### Final direct validation commands and results

All commands ran from the requested worktree with this Node 24 PATH:

```sh
export PATH=/Users/bytedance/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH
npm test -- tests/controller.test.ts tests/bootstrap.test.ts tests/panel.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run package
unzip -t dist/repotreex-0.1.0.zip
git diff --check
shasum -a 256 dist/extension/content/index.js dist/repotreex-0.1.0.zip
```

- Focused: **138/138 passed** (62 controller, 16 bootstrap, 60 panel).
- Full: **699/699 passed in 13 files**, including reproducible package-byte
  identity across UTC and Asia/Shanghai; no unhandled test errors.
- Both TypeScript scopes and ESLint passed, with no diagnostics.
- Production build passed (content entry 89.0 kb); package passed and all eight
  archive entries passed ZIP integrity. Diff whitespace check passed.
- Content entry SHA-256:
  `50704859be4a7f5ed78f23227bf47f94e407fdd44eff6f7ca9adb43b021d65f7`.
- Package SHA-256:
  `dafa117be5ed199dd7c2c3a7371d098bfe0103a4a6d8cddb442564e4e92bca6b`.

```sh
export PATH=/Users/bytedance/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH
export PLAYWRIGHT_MODULE_PATH=/Users/bytedance/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs
export CHROMIUM_EXECUTABLE_PATH=/Users/bytedance/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell
node scripts/check-content-browser.mjs
node scripts/check-panel-browser.mjs
```

Both probes passed against the final built artifacts. Content runs in a real
Chromium isolated world, bridge in MAIN, with all HTTP locally intercepted and
storage/runtime shims. No application console errors/warnings; exactly six
expected browser resource diagnostics for synthetic 401/429/503 responses.
All four existing panel browser regressions passed: hostile desktop/mobile
cascade, important-padding restoration, focused-row visibility and empty/retry
focus plus keyup isolation.

### Self-review and remaining boundaries

Reviewed the complete production/test/browser diff and manifest. Confirmed
session guards, matching path/operation recovery, replacement listener ownership,
no duplicate remounts, current-intent preference notice reconciliation, queued
save teardown, fixed errors and unchanged canonical navigation/security contracts.
All four requested fixes and their validations are complete.

BFCache coverage dispatches real Chromium `PageTransitionEvent` objects with
`persisted: true`; it verifies the built handlers, not eligibility or actual
browser back/forward-cache admission. Live authenticated CNB and an installed
extension remain untested. Shared same-session requests may finish into retained
cache after file-only navigation; the unchanged bridge does not cancel MAIN-world
fetches. Final teardown drops their isolated-side results. PreferenceStore has
no abort contract: an already-issued open/width write may finish after teardown,
but queued writes are dropped and late failures cannot revive UI/metadata.

After the direct checks, the normal `git commit -F` attempt exited 1 with exactly
`bash: script/pre_commit_checks.sh: No such file or directory`. The authorized
`git commit --no-verify -F` retry uses the same reviewed six-file scope and
message. No hook/config changes or push.

## Fix round 2

Fixed both Important fix-induced regressions from `7e0917d` on
`feature/repotreex-cnb-tree`. All changes/checks stay in the requested worktree;
no subagents, push, permission expansion, metadata logging or metadata storage.

### Root causes, changed files and regressions

- `src/content/controller.ts`: a successful toggle previously treated an already
  loaded directory as recovered even when the operation only collapsed it.
  Capture whether the operation invokes directory loading (explicit load/retry
  or expansion) before toggling, and gate both error reconciliation and reveal
  resumption on that fact plus successful loaded state. Collapse-only operations
  preserve user collapse and retain directory/reveal errors. Explicit matching
  retry still resumes selection, including dependencies cached by full search.
- `src/content/controller.ts`: full preference snapshots previously replayed
  stale fields that this tab never changed. Track only local dirty open/width
  intentions and their per-field revisions. Save dirty patches through the
  existing `PreferenceStore.save` merge against current storage. Filter out
  fields already persisted by an earlier queued operation; failed intentions
  remain in later cumulative patches. Reconcile only matching dirty revisions,
  so older successes cannot clear newer same-valued intentions or prematurely
  remove the failure notice. Teardown still drops queued work safely.
- `tests/controller.test.ts`: eight new regressions with real panel controls,
  controller, store and preferences. Cover collapse after search-loaded reveal
  and directory failures, both directions of untouched cross-tab settings,
  successful dirty-field retirement, failed local intent plus external changes,
  queued-success filtering and repeated same-valued intent with pending recovery.
  The independent second PreferenceStore shares synthetic storage, representing
  another tab without mocking the preference merge behavior.
- `scripts/check-content-browser.mjs`: assert built-browser collapse-only
  preservation after search recovery and width-only preservation of a completed
  external open-state write; retain cumulative failure recovery and the entire
  existing bootstrap/BFCache/rate/auth/ref integration probe.

No bootstrap, panel, PreferenceStore, provider, tree-store, route or protocol
contract changes; manifest and build/package configuration remain unchanged.
This supersedes round 1's full-state preference-save approach, retaining its
cumulative recovery and fixed failure-notice guarantees with dirty-only patches.

### TDD and direct validation

Before production edits, the new regressions produced **6 failed, 138 passed**
in the focused controller/bootstrap/panel run. Failures directly reproduced
collapse re-expansion/error clearing and stale open/width overwrites. After the
fixes and two additional queued-intent regressions, **146/146 passed**.
The updated Chromium probe also failed against the previous built artifact:
width-only save restored `panelOpen: true` instead of preserving external false.
It passed after building the corrected entry.

Exact commands from the target worktree:

```sh
export PATH=/Users/bytedance/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH
node --version
npm test -- tests/controller.test.ts tests/bootstrap.test.ts tests/panel.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run package
unzip -t dist/repotreex-0.1.0.zip
git diff --check
export PLAYWRIGHT_MODULE_PATH=/Users/bytedance/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs
export CHROMIUM_EXECUTABLE_PATH=/Users/bytedance/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell
node scripts/check-content-browser.mjs
node scripts/check-panel-browser.mjs
shasum -a 256 dist/extension/content/index.js dist/repotreex-0.1.0.zip
```

- Node **v24.22.2**; focused **146/146** (70 controller, 16 bootstrap, 60 panel).
- Full **707/707 in 13 files**, including UTC/Shanghai reproducible packaging.
- Both TypeScript scopes, ESLint and diff whitespace checks passed.
- Production build passed (90.4 kb content entry); package passed and all eight
  ZIP entries passed integrity checks.
- Built Chromium content/MAIN-bridge probe and all four panel browser regressions
  passed. Synthetic intercepted traffic only; no application console warnings
  or errors, exactly six expected injected HTTP resource diagnostics.
- Content SHA-256:
  `dbcf063c9aaa3536c294b8ad7c380fbe01d9e454ec04cc1627e7820071e21fab`.
- ZIP SHA-256:
  `4dc4962d28abd3af53abe4d2278e0c9dee429487d1316c5bd705e90553e4e77d`.

### Self-review and boundaries

Reviewed the complete diff for load-versus-collapse ownership, matching error
guards, dirty-field retirement, failed/newer/queued intention ordering, fixed
notices, teardown and untouched storage fields. Both fixes and validations are
complete. Cross-tab storage remains read/merge/write, not a transaction: this
fix preserves changes completed before the save reads storage, but cannot promise
atomic handling of simultaneous interleaved tab writes under the unchanged
PreferenceStore contract. Real installed-extension/live CNB and actual BFCache
admission remain untested; the existing synthetic persisted-event and isolated/
MAIN-world checks pass. Already-issued fetch/storage work is non-abortable under
the authoritative contracts; queued saves are still dropped on destroy.

After direct validation, the normal `git commit -F` failed only with
`bash: script/pre_commit_checks.sh: No such file or directory`. The authorized
`git commit --no-verify -F` retry uses the same reviewed four-file scope/message.
No hook/config modifications or push.
