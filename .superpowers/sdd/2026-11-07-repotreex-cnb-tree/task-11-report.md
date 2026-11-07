# Task 11 report: privacy, installation, OAuth request, and manual QA

## Status and scope

Implemented in the requested managed worktree on
`feature/repotreex-cnb-tree`, starting from `5f349da`. No subagents, push,
store submission, extension installation, OAuth registration, live CNB request,
or production-source change was made. Generated `dist/` artifacts remain
ignored and outside the commit.

Task steps: privacy test RED/GREEN DONE; implementation scan DONE; installation
and usage documentation DONE; OAuth request DONE; manual matrix DONE; full
suite/type/lint/package/ZIP inspection DONE; self-review DONE. The task commit
is created after this report is staged; its hash is returned in the final task
response rather than embedded recursively here.

## Delivered

- `README.md` documents Node 24 prerequisites, locked install and validation
  commands, `dist/extension/`, QQ Browser/Chrome developer-mode loading,
  supported repository/blob/commit routes, current first-release behavior,
  known limits, and the clean-room boundary. It explicitly says the extension
  is not store-published and OAuth is inactive.
- `docs/privacy.md` states the implemented boundary: current CNB session cookies
  are browser-attached only to same-origin requests; RepoTreeX cannot read or
  export HttpOnly cookies; repository structure remains in tab memory; only
  panel width/open state persist; no analytics or external service transmission
  exists.
- `docs/oauth-application.md` is a registration request, not an implementation
  claim. It requests a public client, Authorization Code + PKCE with Device
  Authorization fallback, a registration-supplied redirect and `client_id`, no
  secret, exact `repo-code:r` plus optional `repo-release:r` scopes, and keeps
  OAuth UI disabled pending real approval.
- `docs/manual-test.md` uses synthetic labels, prohibits private paths in
  screenshots/logs, and covers installation/reload, public/private/root/nested
  routes, expansion/reveal, branch/tag/slash refs, loaded/full search,
  cancellation/truncation, preference persistence, SPA/history/lifecycle,
  light/dark/reduced-motion/keyboard/accessibility, QQ Browser/Chrome, offline,
  `5xx`, `401`, `403`, `404`, `429`, logout, extension reload, and removal.
- `tests/privacy.test.ts` scans the current manifest, all production TS/JSON,
  the dedicated persistence serializer, and the current browser build. It
  fails on broadened permissions/hosts, cookie APIs, alternate persistence, known
  analytics/telemetry endpoints, sensitive storage keys, production console
  logging, and embedded OAuth credential-shaped values.

## Test-first evidence

Before creating `tests/privacy.test.ts`, the prescribed focused command under
Node 24 exited 1 with `No test files found`. The first test implementation then
failed 1 of 5 cases because the initial storage-call matcher classified the
identifier `preferences` as sensitive text. Inspection showed the real write
contained exactly `panelOpen` and `panelWidth`; the scan was corrected to test
serialized object keys rather than variable names, without changing production
code or weakening the forbidden-key list.

Focused GREEN under Node 24.11.1:

```text
$ npm test -- tests/privacy.test.ts
Test Files 1 passed (1)
Tests 5 passed (5)
```

The scan is intentionally static and denylist-based. It is a regression guard,
not proof that arbitrary future code is private or secure. Runtime preference,
store, controller, bridge, and lifecycle tests continue to provide behavioral
coverage; the manual matrix retains live acceptance as an explicit gate.

## Final validation

Authoritative commands used
`/Users/bytedance/.nvm/versions/node/v24.11.1/bin` (Node 24.11.1):

```sh
npm test
npm run typecheck
npm run lint
npm run package
unzip -l dist/repotreex-0.1.0.zip
git diff --check
```

Results: 14/14 test files and 714/714 tests passed; both TypeScript scopes and
ESLint passed; package/build exited 0; diff whitespace passed. The ZIP contains
exactly eight runtime files: four icons, `manifest.json`, bundled
`content/index.js`, bundled `content/panel.js`, and bundled `page/bridge.js`.
There are no tests, source maps, logs, docs, or fixtures in the archive.

A direct documentation checklist found all 22 required sections/claims. The
final package command supplied the build inspected by the privacy scan; direct
source/build searches found no production console logging, cookie API,
`document.cookie`, alternate web storage/IndexedDB, or credential assignment.

## Self-review and concerns

- Re-read the Task 11 brief and checked every required README, privacy, OAuth,
  and matrix item against the current manifest/source rather than design-only
  intentions. No claim of store publication, active OAuth, completed live QA,
  or private-repository validation remains.
- Verified privacy wording distinguishes browser-attached HttpOnly cookies from
  extension cookie access, tab memory from local preference storage, and CNB
  same-origin traffic from external service transmission.
- Verified the OAuth redirect placeholder is explicitly registration input,
  not runtime configuration, and no concrete `client_id` or secret is present.
- Static scans cannot establish absence of every obfuscated/dynamic API use or
  every future analytics SDK. They proportionately inspect current production
  source, manifest, persistence writes, and current build output; review and live
  manual checks remain required.
- Live QQ Browser/Chrome install, authenticated public/private CNB behavior,
  accessibility tooling, logout/revocation, and injected HTTP failures were not
  performed in this documentation task. The matrix records them without
  treating synthetic automation as completion evidence.
- The configured pre-commit hook is known to reference missing
  `script/pre_commit_checks.sh`. Normal commit is attempted first after direct
  validation; the previously authorized `--no-verify` fallback is used only for
  that exact hook failure and is reported in the final response.

## Fix round 1

Addressed the P1/P2 privacy-scan findings and P3 validation requirement on top
of `cc47e2a`, in the requested worktree without subagents, live CNB access,
permission expansion, dependency changes, or push.

### Clean-checkout build and scan

- `scripts/build.mjs` now accepts an optional `REPOTREEX_OUTPUT_DIR`. The normal
  default remains `dist/extension`; privacy tests supply a fresh OS temporary
  directory, so they neither depend on stale ignored output nor race package
  tests over shared `dist/` deletion/copy operations.
- `tests/privacy.test.ts` asynchronously builds the current entries into that
  isolated directory in `beforeAll`, reads only those fresh JS/JSON artifacts,
  and recursively removes the temporary directory in `afterAll`.
- The built scan checks the exact eight runtime files, forbidden cookie APIs,
  alternate browser storage, analytics/beacon/known telemetry, production
  console logging, credential-shaped assignments and bearer literals. It also
  parses the built manifest and reasserts exact `storage` permission,
  `https://cnb.cool/*` host access and content-script match scope.
- Package exclusion remains covered by the existing package tests and the final
  `unzip -l`/entry allowlist inspection. The archive contains only the same
  eight runtime files and excludes tests, source maps, logs, docs and fixtures.

### Persistence architecture

- Removed the duplicate `chrome.storage.local` adapter from
  `src/content/index.ts`. Production bootstrap now passes the optional injected
  test storage directly to `createPreferenceStore`; without injection, only
  `src/content/preferences.ts` resolves the Chrome storage API.
- The static invariant scans every production TypeScript file and requires
  `src/content/preferences.ts` to be the sole direct browser-storage user. This
  makes indirect, aliased, computed and spread-payload writes outside the
  adapter fail the architecture check rather than relying on payload-key regexes.
- A real default-adapter execution saves a patch containing synthetic
  repository/query fields and asserts the one browser write is exactly
  `{ "repotreex.preferences": { panelOpen, panelWidth } }`. Existing preference
  tests continue to cover hostile descriptors, unknown keys, partial merges,
  clamping and storage failures.

### RED/GREEN evidence

The first revised focused run used supported Node 24.22.2 and exited 1 with two
expected failures: it detected direct persistence outside `preferences.ts`, and
the unmodified build ignored the isolated output destination. After narrowing
the architecture and adding output-directory support, one test still failed
because the artifact inventory included directories; changing the inventory to
select real files produced GREEN without changing the privacy boundary.

```text
$ npx --yes -p node@24 -c 'node --version && npm test -- tests/privacy.test.ts'
v24.22.2
Test Files 1 passed (1)
Tests 5 passed (5)
```

Clean-dist simulation moved the existing ignored `dist/` completely outside the
checkout, ran the same focused command, asserted that no project `dist/` was
created, and restored the ignored artifacts. It passed 5/5 under Node 24.22.2.
The focused bootstrap/preferences/privacy integration run passed 31/31, and the
package/privacy concurrency regression run passed 7/7.

### Fix-round validation and concerns

Final authoritative validation uses `npx --yes -p node@24`, resolving Node
24.22.2 and satisfying `>=24.15.0 <25`. The package reproducibility test now
uses an exported packaging function with independent temporary output roots,
so it cannot recreate or mutate project `dist/` while the privacy test scans
its own build. The normal CLI still packages to `dist/`; the added declaration
keeps the test/tool boundary typed.

The final clean-dist simulation moved the existing ignored `dist/` outside the
checkout, then ran:

```sh
npx --yes -p node@24 -c 'node --version && npm test'
test ! -e dist
npx --yes -p node@24 -c 'npm run typecheck && npm run lint && npm run package'
unzip -l dist/repotreex-0.1.0.zip
unzip -Z1 dist/repotreex-0.1.0.zip  # compared to the exact eight-file allowlist
git diff --check
```

Results: Node 24.22.2; 14/14 files and 714/714 tests passed; `npm test` left
project `dist/` absent; both TypeScript scopes and ESLint passed; package/build
exited 0; ZIP listing matched the exact eight runtime files; diff whitespace
passed. This evidence supersedes the original Node 24.11.1 validation for Fix
round 1.

Static pattern scans remain bounded regression checks rather than a proof
against deliberately obfuscated code or unknown telemetry vendors. The stricter
single-adapter invariant makes persistence review tractable, while behavioral
tests prove the current serializer output. Live browser/private-repository QA
remains governed by the manual matrix and was not performed in this round.
