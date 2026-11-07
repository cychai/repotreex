# Task 8: Strict non-sensitive preference persistence

## Status

Implemented, validated, and self-reviewed in the existing
`feature/repotreex-cnb-tree` worktree. Work stayed inside the requested managed
worktree. No subagents, dependency changes, permission changes, network calls,
or original-checkout edits were used.

## Delivered

- `src/content/preferences.ts` exports `Preferences`, `PreferenceStorage`,
  `PreferenceStore`, and `createPreferenceStore(storage?)` with `load()` and
  `save(patch)`.
- The sole storage record is `repotreex.preferences`; the serialized payload is
  always freshly constructed with exactly `panelOpen` and `panelWidth`.
- Defaults are `{ panelOpen: true, panelWidth: 300 }`; finite widths clamp to
  `240..560`. Invalid/missing field values use the stored/default value rather
  than widening the accepted types.
- Stored records and patches are read only through captured own-property
  descriptors for the two allowlisted keys. Prototype values, unknown keys,
  accessors, iteration, and spreading are excluded. Descriptor-hostile Proxies
  reject before a write instead of becoming a success-shaped default.
- The production default adapter uses the existing MV3 `chrome.storage.local`
  promise API. Storage read and write rejections propagate unchanged.
- The manifest remains limited to the existing `storage` permission and
  `https://cnb.cool/*` host permission.

No compact-display preference was added because Task 8 specifies it only if
already introduced; no such preference exists in the current UI contract.

## TDD evidence

Tests were written before production code. Initial RED under the local Node 24
wrapper (`/Users/bytedance/.nvm/versions/node/v24.11.1/bin`):

```text
$ PATH=/Users/bytedance/.nvm/versions/node/v24.11.1/bin:$PATH npm test -- tests/preferences.test.ts
FAIL tests/preferences.test.ts
Error: Failed to resolve import "../src/content/preferences"
Test Files 1 failed (1)
Tests no tests
Exit 1
```

Initial GREEN after strict serialization implementation:

```text
$ PATH=/Users/bytedance/.nvm/versions/node/v24.11.1/bin:$PATH npm test -- tests/preferences.test.ts
Test Files 1 passed (1)
Tests 9 passed (9)
Exit 0
```

The first static validation exposed compile errors in the MV3 ambient reference
and the test storage helper; after correcting those, lint exposed one unused test
parameter. No test assertion was weakened. Self-review added a tenth hostile
top-level storage result case; it passed with the existing fail-closed behavior.

## Tests and threat boundary

The focused tests prove:

- exact persistence of only panel open/closed and width;
- repository, ref, path, node, expanded-path, selection, search, session, and
  token-shaped keys are neither returned nor persisted;
- unknown sensitive accessors are never invoked;
- allowlisted accessors are treated as invalid rather than executed;
- inherited values are excluded;
- hostile stored/patch descriptor Proxies reject without writing;
- defaults, strict types, and lower/upper width clamping;
- partial-save merge against sanitized persisted state;
- unchanged propagation of storage read/write failures;
- real default-adapter calls to `chrome.storage.local.get/set`.

## Final validation

Focused and static validation after the final source/test edits used the
established Node 24 wrapper:

```text
$ npx --yes -p node@24 -c 'node --version && npm test -- tests/preferences.test.ts && npm run typecheck && npm run lint'
v24.22.2
Test Files 1 passed (1)
Tests 10 passed (10)
Both TypeScript scopes: exit 0
ESLint: exit 0
```

Full proportional validation:

```text
$ npx --yes -p node@24 -c 'npm test && npm run build && npm run package && esbuild src/content/preferences.ts --bundle --platform=browser --target=chrome120 --format=iife --log-level=info > /dev/null'
Test Files 10 passed (10)
Tests 561 passed (561)
Build: exit 0
Package: exit 0
Standalone Chrome 120 preference bundle: exit 0
```

`git diff --check` passed. A source audit found no spreading, object enumeration,
JSON serialization, alternate browser storage, logging, cookies, or network calls
in the preference module.

## Self-review

- Re-read the exact brief and compared every persistence field, default, clamp,
  adapter, failure, and permission requirement to source and focused tests.
- Confirmed save reads existing state first and does not perform a write after a
  read, descriptor, or patch-inspection failure.
- Confirmed storage failures are not caught or converted to defaults/success.
- Confirmed returned and persisted objects are fresh allowlisted objects, with no
  caller/stored object spread or unknown-key traversal.
- No blocking correctness or privacy finding remains within Task 8 scope.

## Commit evidence

The task commit includes only `src/content/preferences.ts`,
`tests/preferences.test.ts`, and this report. The normal commit is attempted only
after direct validation. If it fails solely because the configured external hook
still references missing `script/pre_commit_checks.sh`, the known authorized
`--no-verify` fallback is used and recorded in the final response.

## Concerns

1. Persistence is intentionally scoped to the preference-store boundary; the
   current placeholder bootstrap does not yet wire it into the future panel.
2. The adapter snapshots `chrome.storage.local` when the store is created; callers
   must create it in an extension context where that API exists.
3. The workstation default Node is 23.11.0. All authoritative final validation
   used the established `npx --yes -p node@24` wrapper (Node 24.22.2), which
   satisfies the repository's Node 24 engine range.
4. The configured external pre-commit hook is expected to reference missing
   `script/pre_commit_checks.sh`; direct validations above remain authoritative if
   the known fallback is required.
