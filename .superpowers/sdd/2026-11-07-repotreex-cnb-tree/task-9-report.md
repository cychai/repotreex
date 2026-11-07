# Task 9 report: accessible Shadow DOM tree panel

## Delivered scope

Implemented the exact Task 9 brief in this worktree on
`feature/repotreex-cnb-tree`, based on `9f34afc`. No subagents, push,
deployment, or live private-repository actions were used.

- `src/content/icons.ts`: ten original 16px SVG line drawings, using
  `currentColor` and a consistent 1.5px stroke. No copied product source,
  assets, identifiers, remote fonts, or asset requests.
- `src/content/panel.ts`: `mountTreePanel(options)` returns one panel per
  document with a closed ShadowRoot, `render(state)`, `focusPath(path)`,
  synchronous `clearSensitiveData()`, and idempotent `destroy()`.
- `src/content/panel.css`: isolated neutral light/dark styling, visible focus
  indicators, local-only monospace fallbacks, and reduced-motion support.
- `tests/panel.test.ts`: 44 DOM behavior, lifecycle, accessibility, callback,
  layout-restoration, resize, and privacy regression cases.

The panel consumes TreeSnapshot, ref options, preferences, query/loading/error
state, and full-tree progress/results. Actions leave the panel through callbacks
for file opening, directory expansion/retry, refresh, query changes, full-tree
loading/cancellation, ref selection, and preferences. It uses the existing
`matchLoadedNodes` search implementation for cached nodes, including hidden
loaded descendants; overflow explicitly reports the 200-result limit.

## Behavior and self-review

- Repository basename, ref groups/current-ref fallback, search, refresh,
  collapse/reopen, full-search progress/cancel, sanitized root/directory errors
  and separate retry actions are present. Empty, not-yet-loaded, failed, and
  cancelled states are distinguished.
- Tree rows expose roles, levels, set size/position, selection, directory
  expansion, and busy state. One roving tab stop supports arrows, Home/End,
  Enter, and Space. Focus survives row replacement, falls back to an ancestor
  or empty tree, honors explicit deferred focus, and does not steal search/ref
  focus. Selected rows scroll into view without animated scrolling.
- Render calls coalesce into one latest-state animation frame. Only visible
  nodes or cached-search results become rows; sibling positions are grouped
  in linear passes rather than recalculated for each row.
- Pointer capture and keyboard resizing clamp width to 240-560px. Pointer
  updates save only the final width; cancellation/lost capture rolls back.
  Mount/render do not write preferences. The real PreferenceStore test writes
  only `panelOpen` and `panelWidth`, never metadata or query state.
- Desktop padding uses one dedicated document class and two dedicated custom
  properties; original inline padding is untouched. Destroy restores prior
  property values/priorities and class ownership while preserving unrelated
  page changes. Below 800px, a backdrop overlay does not shrink page content.
  A visible fixed/sticky top header supplies a safe offset, otherwise zero.
- Theme attributes and computed color-scheme are observed, with system
  appearance fallback. Panel keyboard/click/input/ref events do not bubble
  into page action handlers. This is style/event isolation, not a security
  boundary against hostile code in the same execution context.
- Repository/ref/session replacement, null session, signed-out/forbidden
  root or full-search failures, explicit clear, and teardown scrub sensitive
  DOM synchronously, cancel queued frames, and drop retained state/path arrays.
  Old detached elements and retained text/option nodes are scrubbed too. Auth
  failures cannot re-render stale metadata passed alongside the error.
- Sensitive names/paths are inserted with DOM creation/textContent, never
  markup interpolation. The panel has no storage, network, cookie, or logging
  calls. Source scan found only the SVG namespace URL.

## TDD evidence

Initial focused RED failed because the panel module did not exist, as required
by the brief. The initial implementation brought 24 cases to GREEN. Subsequent
RED/GREEN cycles covered auth-error sources, focus fallback/selection and
explicit deferred focus, retained text-node scrubbing, page event boundaries,
teardown focus, empty/error labeling, full-search retry routing, and errors from
inactive snapshots. The final focused suite contains 44 passing cases.

## Build changes

`scripts/build.mjs` now uses esbuild's `.css` text loader. The `*.css?raw`
declaration is included in both TypeScript scopes. Vitest enables processing of
panel CSS so the raw import is not replaced by an empty test stub.

The build additionally validates and bundles `src/content/panel.ts` into
`dist/extension/content/panel.js`, containing the isolated styles. This provides
a reproducible standalone panel build while leaving the Task 10 bootstrap
untouched. `src/content/index.ts` is still its original empty entry; this task
does not mount a tree on a live CNB page. Task 10 must import the panel and wire
controller, route/auth lifecycle, and PreferenceStore callbacks.

## Direct validation (Node 24.22.2)

All commands were run before attempting the commit hook:

- `npm test -- tests/panel.test.ts`: 44/44 passed.
- `npm test`: 605/605 passed in 11 files; includes package byte-identity across
  UTC and Asia/Shanghai.
- `npm run typecheck`: both TypeScript scopes passed.
- `npm run lint`: passed; `git diff --check`: passed.
- `npm run build`: passed twice, targeting Chrome 120; both standalone panel
  outputs have SHA-256
  `badcf53babcec26f2243e9e43fef6bd3816ce0cd953a3131735c69aeb1eba69f`.
- `npm run package` and `unzip -t dist/repotreex-0.1.0.zip`: passed. Package
  SHA-256: `23da997531c1dd5c22f8cc0a39b9247b9a42a3508c6e15c050ee71dfb6cd2b6d`.

Synthetic headless Chromium checks used an existing cached Playwright/runtime,
an in-memory bundle, and no server or new dependency installation. Verified
1280x800 desktop light/dark, 390x844 and 600x844 mobile layouts, hostile page CSS
isolation, 64px top offset, preserved/restored 18px page padding, reduced-motion
zero transitions, real keyboard navigation/activation, real pointer-capture
resize from 300px to 450px, collapse/reopen, mobile backdrop/Escape, ref callback,
full-search progress/cancel, root error/retry, stale-auth scrubbing, and teardown.
There were zero network requests and no console errors/warnings.

Visually inspected the local light/dark/mobile screenshots for clipping,
overlap, page offset, and legible focus/selection. Browser-check script and
screenshots remain ignored local evidence beside this report and are not part
of the commit.

## Boundaries and concerns

- Live CNB wiring is intentionally deferred to Task 10. Real CNB chrome/theme
  variants, authenticated route transitions, and actual screen-reader output
  have not been exercised by these synthetic checks.
- Header-offset detection accepts fixed/sticky header/banner elements at the
  viewport top, up to 160px tall. Other CNB chrome arrangements need live
  integration validation.
- The exact brief requests visible-row rendering, not large-list windowing;
  no virtualized rendering was added. Large repositories need proportional
  performance checks during integration.
- Normal `git commit -F` was attempted after direct validation and failed only
  with `bash: script/pre_commit_checks.sh: No such file or directory` from the
  external pre-commit hook. The prior ruling authorizes the `--no-verify`
  fallback for this exact missing-script failure; no hook/config was modified.

## Fix round 1

Addressed all seven Important findings and the Minor tooltip finding on top of
`29023fa`, in the same worktree without subagents, push, or live CNB actions.
This section supersedes the original report's claim that inline padding is
always untouched and clarifies the ordinary-rerender privacy/focus behavior.

### Changed and regression files

- `src/content/panel.ts`: scrub outgoing repository/status descendants before
  replacement; preserve tree/empty-tree/retry focus; prioritize owned-focus
  scrolling over selected-row autoscroll; demote existing inline important
  padding only while the desktop layout class owns the adjustment and restore
  its exact value/priority on collapse, mobile transition, or destroy; contain
  keyup; align flat search keyboard behavior and Load/Cancel tooltip.
- `src/content/panel.css`: shadow-important reset and essential host geometry,
  typography/theme and collapsed-width declarations protect the host itself
  from outer page CSS while retaining mobile clamping/backdrop behavior.
- `tests/panel.test.ts`: now 60 tests (16 added executions), covering retained
  outgoing repository Text nodes through ordinary render and later clear or
  destroy, scroll-request precedence, empty-tree arrival, all three replaced
  retry sources and fallback, deferred focus precedence, literal-path retry
  matching, external focus preservation, outgoing row/ref/error scrubbing,
  flat ARIA/Left/Right behavior, keyup containment, and tooltip transitions.
- `scripts/check-panel-browser.mjs`: reusable regression probe using installed
  Playwright/Chromium, four independent in-memory synthetic pages and no HTTP
  server, network requests, or dependency installation. Checks real host
  cascade/rect/reset, desktop important-padding adjustment and restoration,
  pointer resizing, collapse/reopen, mobile/backdrop/Escape, actual bounded
  scrolling, focus replacement, and owned/external keyup delivery.
- This report records fix-round results. No build configuration, dependency,
  icon, controller/bootstrap, storage, or preference interface changes.

### RED/GREEN and direct validation

Node runtime: 24.22.2. Before implementation,
`npx --yes -p node@24 -c 'npm test -- tests/panel.test.ts'` exited 1:
12 failed / 45 passed (57 total), reproducing the review's DOM defects.
The browser command below also exited 1 before implementation for all four
checks: host geometry, inline important padding, focused-row visibility, and
empty-tree focus transfer. The scroll fixture deliberately omits hostile host
geometry CSS so unbounded layout cannot mask the independent scroll defect.

After implementation the first required validation run passed 57 focused tests
and typecheck but failed ESLint on test non-null assertions and undeclared
browser globals in the probe. Those test-only issues were corrected without
disabling lint rules. Three additional boundary/retention guards were added.
Final commands/results before commit:

```sh
npx --yes -p node@24 -c 'npm test -- tests/panel.test.ts && npm run typecheck && npm run lint'
```

Exit 0: 60/60 focused tests, both TypeScript scopes and ESLint passed.

```sh
npx --yes -p node@24 -c 'npm test && npm run build && shasum -a 256 dist/extension/content/panel.js && npm run build && shasum -a 256 dist/extension/content/panel.js && npm run package && unzip -t dist/repotreex-0.1.0.zip'
```

Exit 0: 621/621 full tests in 11 files; two Chrome 120 builds produced identical
standalone-panel SHA-256
`0a9f5681b6ac1e4c4e617ff9a573e1ce32dc64249a583d8ec19aa9448174577f`;
packaging and all ZIP integrity checks passed. Existing CSS text loading is
sufficient and reproducible; the Task 10 bootstrap remains unchanged.

```sh
PLAYWRIGHT_MODULE_PATH=/Users/bytedance/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs CHROMIUM_EXECUTABLE_PATH=/Users/bytedance/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell PATH=/Users/bytedance/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH node scripts/check-panel-browser.mjs
PATH=/Users/bytedance/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH node .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-9-browser-check.mjs
git diff --check
```

All exited 0. New probe: 4/4 checks passed; verified 1280x800 desktop and
390x844 mobile, host fixed at left 0/top 64 with zero margin/padding/transform,
300px expanded and 32px collapsed width, page padding 318px then 468px after
real resize and exactly 18px important on restoration. The scroll probe asserts
a genuinely overflowing tree, fully visible focused final row after rerender,
and distant selected row above its viewport. Both browser probes observed no
console errors/warnings or network requests. Existing smoke also passed themes,
reduced-motion, keyboard/pointer actions, 600px overlay, ref/full-search/retry,
authorization scrubbing and teardown. Browser plugin not available; installed
Playwright was used for the requested Chromium validation. Refreshed local
light desktop and dark mobile screenshots were inspected for clipping, page
offset and legibility; ignored screenshots/smoke script are not staged.

### Self-review and remaining boundaries

Outgoing repository Text references are scrubbed before ordinary replacement,
not merely during later lifecycle calls. Existing row/option/error scrubbing
remains intact. Retry identity is captured before scrub, matched by literal
action/path without sensitive selector interpolation, and released after the
render. Focus restores only when the panel owned it or explicit focus was
requested; missing retry controls fall back to a valid roving row or empty
tree, with directory/ancestor preference. Selected autoscroll cannot undo
owned-focus scrolling. Search results have level-one leaf semantics, no
expansion affordance, and no hierarchical Left/Right actions; Enter/Space
directory activation still uses the existing callback contract.

Only open/width callbacks persist preferences, and no metadata storage/logging
or remote assets were added. Keyup containment performs no activation and its
listener is removed during teardown. Page CSS reset is scoped to the host;
desktop padding still depends on the dedicated document class and restores
original priority without replacing unrelated style/class state. This is not
a security boundary against same-page hostile JavaScript.

Live CNB integration and actual screen-reader output remain untested and are
deferred to Task 10. No unresolved self-review finding remains in this round.

### Commit validation/hook handling

After direct validation, the normal
`git commit -F .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-9-fix-1-commit.txt`
was attempted and exited 1 only with
`bash: script/pre_commit_checks.sh: No such file or directory`.
The authorized fallback is
`git commit --no-verify -F .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-9-fix-1-commit.txt`.
No hook file or Git configuration is modified; all scoped validation was run
directly beforehand.
