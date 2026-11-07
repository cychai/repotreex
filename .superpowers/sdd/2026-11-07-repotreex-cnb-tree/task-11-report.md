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

## Fix round 2

Resolved the three remaining review gaps on top of `2224f7c`, in the requested
worktree without subagents, permission expansion, live CNB access, OAuth
activation, store publication, or push.

### Safe build-output contract

- Removed the arbitrary `REPOTREEX_OUTPUT_DIR` environment override. The CLI
  default remains `dist/extension`; programmatic callers now use exported
  `validateBuildOutput`, `prepareBuildOutput`, and `buildExtension` APIs with an
  explicit safe root and strict descendant output leaf.
- Validation occurs before filesystem mutation and rejects `/`, home, `.`, the
  repository root, the safe root itself, ancestors/outside paths, the broad OS
  temp root, files, and symbolic links. Safe roots are limited to project
  `dist` or a child of the OS temp directory.
- The exported API accepts only an empty dedicated leaf and never deletes it.
  Existing non-empty directories are rejected, including previously generated
  leaves, and sentinel tests verify their contents survive. Only the unchanged
  CLI default may replace the hard-coded project `dist/extension` path.
- `scripts/package.mjs` calls the build API directly. Tests build in independent
  temporary leaves, avoiding stale ignored `dist/` and cross-test races.

### Storage and artifact invariants

- The persistence architecture guard now parses every production TypeScript
  file with the TypeScript compiler AST. It follows `chrome`/`browser` aliases,
  computed `['storage']`, assignments, storage and storage-area destructuring,
  area aliases, and calls through those references. Only
  `src/content/preferences.ts` may contain such references.
- Mutation cases prove computed, root-alias, destructured-storage,
  destructured-area, area-alias, spread-payload, destructured-method,
  method-alias, and assignment-alias forms are detected. The real adapter test
  still proves an attempted synthetic repo/query patch writes exactly
  `panelOpen` and `panelWidth`.
- Source and freshly built output scans cover cookie/credential APIs,
  alternate storage, analytics/beacon/known telemetry, console logging, and
  credential-shaped literals. Source and built manifests are asserted as the
  exact implemented two-record configuration: one isolated content script and
  one required MAIN-world bridge, each with the single nonempty
  `https://cnb.cool/*` match, exact `storage` permission, and exact host scope.
- Packaging tests inspect the ZIP itself with `unzip -Z1` and require exactly
  eight runtime entries, automatically excluding tests, source maps, logs,
  docs, and fixtures.

### RED/GREEN evidence

The first round-2 focused run under Node 24.22.2 failed as intended before the
implementation existed: `tests/privacy.test.ts` could not import the AST scan
helper, and `tests/build.test.ts` could not import the new build API. This was
the RED signal for both the bypass detector and safe-output contract. An
intermediate run also exposed the jsdom/esbuild `TextEncoder` realm mismatch;
marking build/package/privacy suites as Node-environment tests fixed the test
isolation rather than weakening assertions.

Final focused GREEN:

```text
$ npx --yes -p node@24 -c 'node --version && npm test -- tests/build.test.ts tests/privacy.test.ts tests/package.test.ts && npm run typecheck && npm run lint'
v24.22.2
Test Files 3 passed (3)
Tests 29 passed (29)
TypeScript and ESLint exited 0
```

### Clean-dist final validation

The final simulation moved the ignored project `dist/` outside the checkout,
ran tests before packaging, asserted `test ! -e dist`, then packaged and
inspected the regenerated archive:

```sh
npx --yes -p node@24 -c 'node --version && npm test'
test ! -e dist
npx --yes -p node@24 -c 'npm run typecheck && npm run lint && npm run package'
unzip -t dist/repotreex-0.1.0.zip
unzip -Z1 dist/repotreex-0.1.0.zip
git diff --check
```

Results: Node 24.22.2; 15/15 test files and 736/736 tests passed in the final
clean-dist run; tests left project `dist/` absent; both TypeScript scopes and
ESLint passed; package/build exited 0; `unzip -t` reported no errors; ZIP entries
were exactly four icons, `manifest.json`, `content/index.js`,
`content/panel.js`, and `page/bridge.js`; diff whitespace passed.

### Remaining concerns

The AST scan is intentionally a focused architecture guard, not whole-program
taint analysis: deliberately obfuscated global lookup or eval-generated code
would still require review. The build contract relies on path validation plus
an empty-leaf precondition; exported callers cannot delete an existing output
tree. Live browser/private-repository acceptance remains unrun and continues to
be governed by `docs/manual-test.md`.

## Fix round 3

Resolved the remaining build/package safety and storage-scan review findings on
top of `6af1f6c`, without subagents, permission expansion, live CNB access,
OAuth activation, store publication, or push.

### Build and package safety

- Default builds now preflight the manifest, all four icons and all three
  entrypoints before changing the last usable build. Inputs must be regular
  files and may not traverse symlinks. The replacement is first built in a
  fresh staging directory and moved into `dist/extension` only after the build
  succeeds.
- Before default cleanup, the project/default safe root and every output path
  component are checked with `lstat`; a `dist` symlink, intermediate symlink or
  final symlink is rejected. Canonical containment is checked for prepared
  outputs, and the safe root is rechecked immediately before replacement.
- Programmatic builds require explicit caller-created empty output and safe-root
  directories. They verify canonical containment, reject symlink root,
  intermediate and final components, and perform no recursive deletion.
- Programmatic packaging requires a caller-created empty OS-temporary directory,
  rejects symlink roots, and only cleans its own verified real `extension`
  child after an error. It never cleans through an unvalidated or symbolic-link
  root. Default package/build behavior remains `dist/extension` plus the ZIP.
- Real-temp sentinel tests cover broad/absent/nonempty outputs, symlink safe
  roots, intermediate and final symlinks, symlink source input, missing source
  input, unsafe default replacement, and package-root preservation.

### Storage architecture scan

- Replaced the unbounded global fixed-point alias map with one bounded AST walk
  and lexical scope stacks. Parameters and local declarations shadow ambient
  `chrome`/`browser`, avoiding prior scope conflation and alias-cycle hangs.
- The scanner unwraps parentheses, TypeScript assertions and non-null
  expressions; follows constant computed `storage` keys, root/storage/area/
  method aliases, assignments, nested renamed declaration and assignment
  destructuring, and spread-payload writes. Reviewer mutation cases and shadowed
  false-positive cases run with one-second per-case timeouts.
- Fresh built JavaScript is independently scanned: only `content/index.js` may
  contain browser-storage evidence, and it must contain the exact preferences
  key. Exact source/built manifest records and exact eight-file ZIP checks were
  retained unchanged.

### RED/GREEN evidence

The first round-3 focused run under Node 24.22.2 produced ten expected failures:
intermediate symlink, missing caller-created output, missing default API,
symlink default root, nonempty programmatic package root, constant-computed and
TypeScript-wrapped access, nested renamed assignment, and two shadowing cases.
After implementation, the focused command passed:

```text
$ npx --yes -p node@24 -c 'node --version && npm test -- tests/build.test.ts tests/privacy.test.ts tests/package.test.ts && npm run typecheck && npm run lint'
v24.22.2
Test Files 3 passed (3)
Tests 45 passed (45)
TypeScript and ESLint exited 0
```

### Final clean-dist validation

The final run moved ignored `dist/` outside the checkout, ran the full suite
before packaging, asserted `test ! -e dist`, then rebuilt and inspected the
archive:

```sh
npx --yes -p node@24 -c 'node --version && npm test'
test ! -e dist
npx --yes -p node@24 -c 'npm run typecheck && npm run lint && npm run package'
unzip -t dist/repotreex-0.1.0.zip
unzip -Z1 dist/repotreex-0.1.0.zip
git diff --check
```

Results: Node 24.22.2; 15/15 test files and 752/752 tests passed; tests left
project `dist/` absent; both TypeScript scopes and ESLint passed; package/build
exited 0; ZIP integrity passed and entries remained exactly the four icons,
`manifest.json`, `content/index.js`, `content/panel.js`, and `page/bridge.js`;
diff whitespace passed.

### Remaining concerns

Filesystem validation minimizes but cannot eliminate a hostile same-user local
TOCTOU race between the final `lstat`/`realpath` checks and filesystem mutation;
the project/default output root must not be concurrently modified during build.
The AST scan is a bounded conservative architecture guard, not whole-program
taint analysis against eval-generated or deliberately obfuscated access. Live
browser/private-repository acceptance remains governed by `docs/manual-test.md`.

## Fix round 4

Takeover completed on top of `5942261` in the requested worktree, without
subagents, push, dependency changes, production-source changes, live CNB
access, extension installation, OAuth activation, or permission expansion.
All six requested finding groups are addressed and validated below.

### Replacement authority and canonical paths

- `buildDefaultExtension()` and `buildDefaultProject()` now take no arguments
  in both runtime and declarations. Passing options is rejected before any
  preflight or mutation. Recursive replacement is private to the hard-coded
  project `dist/extension`; caller-selected siblings or temporary paths cannot
  reach it. Programmatic builds still require caller-created empty leaves.
- Default-replacement tests copy the real source/build scripts into fresh OS
  temporary projects and run their fixed defaults, rather than exporting
  destructive source/output overrides for tests. Successful replacement,
  sentinel sibling preservation, missing-input preflight, symlink-source/root
  rejection, and failed-compilation staging cleanup all execute real builds.
- Shared path validation normalizes only verified macOS `/var` and `/tmp`
  system aliases. All other ancestors and components are checked with `lstat`,
  and prepared temporary roots must remain inside the canonical OS temporary
  root. Both normal `/var/...` and canonical `/private/var/...` paths build and
  package successfully. Symlink ancestors are rejected whether they redirect
  within temporary storage or outside it; real non-temporary roots are rejected
  before output writes.
- Programmatic packaging no longer recursively cleans caller-owned output on
  errors, and only default packaging may remove the fixed archive. Partial
  temporary output is left to its caller, consistent with non-destructive
  programmatic builds. Preflight and staged default build-before-replacement
  behavior are retained.

### Conservative persistence architecture

- Removed custom alias/constant/assignment execution-state tracking entirely.
  The guard inspects every executable AST node once with an iterative stack,
  and uses the existing TypeScript compiler binder for lexical identity.
  No fixed-point dataflow, callback execution simulation, external imports,
  type diagnostics, or file emission occurs.
- Unshadowed `chrome`/`browser` references and exact root-name string literals
  are evidence even for benign aliases outside `preferences.ts`. The narrow
  exceptions are direct `typeof`/`.runtime` identity checks already required
  by `content/index.ts`; no production behavior change was needed. Local
  declarations/parameters/imports/classes/named functions/loops/catches are
  distinguished from ambient roots, and property/type names are not references.
  Direct aliases of ambient global holders are also conservative evidence;
  nested `globalThis.window.browser` access cannot bypass the root check.
- Regressions cover parameter/binding initializers, assignment targets,
  constant-computed destructuring, assertions/non-null/satisfies wrappers,
  optional access, shorthand capture, deferred callback/function reassignment,
  var/function/loop/named-function scope, global holders, escaped identifiers,
  and a 2,000-iteration alias-cycle fixture with one-second scan limits.
- Exact default-adapter serialization remains behavior-tested: a synthetic
  repo/query patch writes only `panelOpen` and `panelWidth`. Fresh bundles must
  keep storage evidence solely in `content/index.js`, with exactly one direct
  Chrome local-storage reference and one preferences key. Exact source/built
  manifest records and the exact eight-runtime-file archive are preserved.

### RED/GREEN and final validation

The initial test-first run under Node 24.22.2 failed 25/81 cases, including
18 scanner failures and canonical-path/symlink-ancestor failures. The initial
P1 test was masked by the old canonical-temp rejection; it was corrected to
use the old API's accepted project-dist sibling. An independent reproduction
using the original `5942261` build script confirmed the unrelated nonempty
sibling sentinel was recursively deleted, exclusively in a fresh temporary
fixture. The revised API rejects that request and preserves the sentinel.
Additional shorthand/wrapped-global cases first failed 2 tests before their
AST reference handling was corrected; global-holder aliases/nesting likewise
failed two targeted cases before the conservative capture rule was added.

Final authoritative validation pinned Node **24.22.2**:

```text
Focused build/privacy/package: 3/3 files, 97/97 tests passed
Full suite from absent project dist: 15/15 files, 804/804 tests passed
Tests left project dist absent; original ignored dist was restored by rename
Both TypeScript scopes: passed
ESLint: passed
npm run package: passed
unzip -t / unzip -l / exact unzip -Z1 eight-entry assertion: passed
Built/source full manifest equality and single storage/key counts: passed
git diff --check: passed
```

The prior ignored build was preserved and restored, not deleted by the clean
test simulation. Packaging then replaced only the intended project default.
The configured normal commit hook is attempted first; only its known missing
`script/pre_commit_checks.sh` failure permits the authorized `--no-verify`
fallback. The commit hash and actual hook outcome are returned in the task
response.

### Remaining concerns

The architecture guard deliberately rejects benign ambient browser aliases
and exact root-name string literals outside the adapter. It is not a proof
against eval/generated names or intentionally obfuscated globals. A hostile
same-user process can still race filesystem checks; build roots must not be
concurrently redirected. Failed programmatic builds/packages may leave partial
output for callers to inspect and remove. Live QQ Browser/Chrome/private-CNB QA
remains unrun and governed by the existing manual matrix.

## Fix round 5

Final implementer takeover on top of `7355668`, in the existing
`feature/repotreex-cnb-tree` worktree. All three open findings are addressed.
No subagents, new Git worktree, push, dependency change, production-source
change, permission expansion, live CNB request, OAuth activation, or browser
installation was performed.

### Runtime-expression coverage and lexical identity

- Global-holder capture is recognized in every initializer-bearing AST node,
  including function/arrow parameters, nested object/array binding defaults,
  class fields, object properties, and destructuring-assignment shorthand
  defaults. Parentheses, assertions, non-null and satisfies wrappers preserve
  capture evidence. The exact reviewer `(holder = globalThis) => ...` form is
  now a regression case.
- Type erasure is decided by position for `ExpressionWithTypeArguments`, not
  its kind alone. Executable class extends and TypeScript instantiation
  expressions are traversed, while class implements, interface heritage,
  generic constraints/defaults, type arguments, assertions' type operands,
  and type-only imports/exports remain ignored.
- Corrected shorthand symbol resolution so only the shorthand name uses its
  captured-value symbol; the default initializer resolves its own identifier.
  This prevents a local assignment target from incorrectly shadowing an
  ambient global holder or browser root in the default expression.
- Added exact reviewer and nearby cases for generic/class-expression heritage,
  decorators (class, method and legacy parameter syntax), computed class
  method/field names, static blocks/fields and enum initializers. Matching
  local-holder/browser shadowing and pure-type cases remain silent. Existing
  direct runtime/typeof identity exceptions are unchanged.
- The scan is still an iterative AST walk with compiler-bound lexical identity,
  no execution simulation or alias fixed point. Per-case one-second timeouts
  and the existing 2,000-iteration alias-cycle regression passed without hangs.

### Location-independent build/package fixtures

- Removed assumptions that the project checkout or `.superpowers` is outside
  OS temp. Tests create real canonical `os-temp` and `outside-temp` sibling
  directories inside one exclusively owned fixture and run the unchanged
  build/package scripts in a child process with TMPDIR/TMP/TEMP pinned to
  `os-temp`. This tests actual validation and filesystem effects without
  mocking guards or adding production test hooks.
- Positive cases build/package within the selected root and check the manifest
  or exact eight-entry ZIP. Negative cases reject the root itself, a real
  sibling outside it, and symlink ancestors redirecting to that sibling before
  creating artifacts. All fixture cleanup targets are dedicated generated
  directories, never broad roots.
- Default replacement remains no-argument and hard-coded; programmatic APIs
  remain caller-created empty-leaf operations with no recursive replacement.
  No build/package implementation or safety check was weakened or changed.

### RED/GREEN evidence

The initial privacy regression run failed 17 cases: global-holder initializer
capture, executable heritage/instantiation, and type-only import/export false
positives. Decorators/computed names/static blocks already walked correctly
and their added regressions passed. Reproducing the original path tests with
TMPDIR equal to the checkout failed two cases because both supposedly
non-temporary roots were legitimately temporary. The corrected fixture model
passes those cases in the same environment. An intermediate shorthand-default
case exposed the symbol-resolution defect described above before correction.

Final Node **24.22.2** focused validation: **147/147 tests**, 3/3 files passed;
both TypeScript scopes and ESLint passed. This adds 50 tests to round 4.

### Final validation

Final full suite: **854/854 tests**, 15/15 files, in every configuration:

1. Existing worktree, default TMPDIR, from absent `dist`; prior ignored dist
   preserved/restored by rename and tests left dist absent.
2. Existing worktree, fresh workspace-owned alternate TMPDIR.
3. Existing worktree, TMPDIR exactly equal to the checkout (the original
   location-assumption failure reproduction).
4. Fresh temporary source checkout copy, default TMPDIR, no `.superpowers`
   directory or prior dist.
5. Same temporary checkout, sibling alternate TMPDIR.
6. Same temporary checkout, ancestor TMPDIR containing the checkout.

The copy is a disposable source fixture, not a new Git worktree. All three
temporary-checkout runs left dist absent. Dedicated temporary fixture trees
and an npm compile cache generated by the initial TMPDIR reproduction were
removed; the pre-existing ignored dist was restored, then normally packaged.

Commands were pinned with `npx --yes -p node@24.22.2`. The ignored local
`task-11-round-5-check.mjs` driver records the clean-dist/alternate/checkouts
setup and assertions. Final `npm run typecheck`, `npm run lint`,
`npm run package`, `unzip -t`, `unzip -l`, an exact `unzip -Z1` eight-entry
assertion, complete built/source manifest equality and `git diff --check`
all passed. Existing reproducibility across UTC/Asia-Shanghai timezones,
exact preference serialization, fresh bundle storage-user/key counts and
manifest records passed in every full run.

### Completion and remaining concerns

Scanner fixes DONE; location-independent fixtures DONE; focused/full/environment
matrix DONE; type/lint/package/archive checks DONE; report DONE. Commit is made
after these checks; its identifier and actual hook outcome are returned in the
final response. Normal hook is attempted first, with only the documented
missing `script/pre_commit_checks.sh` failure eligible for `--no-verify`.

The scanner remains a conservative architecture regression guard, not
whole-program taint analysis or proof against eval/generated/obfuscated names.
Filesystem TOCTOU races against a hostile same-user process remain outside the
build contract; output roots must not be concurrently redirected. Validation
was on macOS with the locked toolchain and an available `zip`/`unzip`; Linux
and Windows were not exercised. Live QQ Browser/Chrome/private-CNB acceptance
remains unrun under the existing manual matrix.
