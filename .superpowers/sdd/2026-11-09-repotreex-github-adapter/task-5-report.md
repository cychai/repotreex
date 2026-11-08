# Task 5 Report: Bounded JSON/HTML MAIN-World Transport

## Status

Implemented with RED-GREEN TDD. The bridge now carries successful CNB JSON and GitHub HTML in
explicit `format: "json" | "text"` envelopes while preserving the caller-facing CNB values.

## Delivered

- Added bounded streaming body reads with a 2,000,000 UTF-16-unit ceiling. Oversized streams are
  cancelled and return only the fixed `compatibility` envelope.
- Enforced the built request origin against the active origin and the final response origin after
  redirects before reading successful bodies.
- Enforced `application/json` for CNB and `text/html` for GitHub, with active-session credentials,
  `no-store`, and explicit redirect following.
- Left non-ok response bodies unread and retained fixed sanitization for known fetch/body failures;
  unexpected implementation errors still reject.
- Installed the bridge and idempotent history hooks only on exact `https://cnb.cool` and
  `https://github.com` origins.
- Preserved hostile accessor/proxy/revoked-envelope handling in both page bridge and isolated client.
- Kept bounded HTTP-200 login HTML as metadata-free text for Task 7 decoder classification; no
  speculative login-page scanning was added.

## TDD Evidence

RED: `npx vitest run tests/page-bridge.test.ts` failed with 13 expected transport-contract failures
before implementation (missing format discriminants, HTML success, bounds, redirect option, final
origin/content-type checks, and body-read policy).

GREEN focused validation:

```text
npx vitest run tests/page-bridge.test.ts tests/bridge-client.test.ts
Test Files  2 passed (2)
Tests       102 passed (102)
```

Full validation:

```text
npm test
Test Files  17 passed (17)
Tests       990 passed (990)

npm run typecheck
exit 0

npm run lint
exit 0

git diff --check
exit 0
```

## Scope Note

The protocol migration necessarily updated `src/content/bridge-client.ts` and synthetic successful
bridge responses in existing tests so the new success discriminant is validated end to end. No
decoder/provider HTML semantics from Task 7 were introduced.

## Fix Round 1

Resolved the P2 review finding that a shared catch classified unrelated body and implementation
failures as transport or compatibility results.

- Replaced `RepositoryError` oversize signaling with a private sentinel that cannot collide with
  reader/cancellation failures.
- Limited body-read sanitization to `transportFailure`; unexpected `Error`, `RepositoryError`, and
  fallback `SyntaxError` values now reject unchanged.
- Isolated `JSON.parse` so only JSON parse `SyntaxError` maps to `compatibility`.
- Preserved fixed oversize classification even when cancellation has a known transport failure;
  unexpected cancellation failures remain observable.

RED:

```text
npx vitest run tests/page-bridge.test.ts
Test Files  1 failed (1)
Tests       3 failed | 70 passed (73)

Failures: GitHub fallback SyntaxError resolved as compatibility; RepositoryError from stream read
and cancellation resolved as forbidden.
```

GREEN focused validation:

```text
npx vitest run tests/page-bridge.test.ts tests/bridge-client.test.ts
Test Files  2 passed (2)
Tests       110 passed (110)
```

Full validation:

```text
npm test
Test Files  17 passed (17)
Tests       998 passed (998)

npm run typecheck
exit 0

npm run lint
exit 0

git diff --check
exit 0
```

The requested multibyte byte-split/finalization and direct GitHub-origin install/idempotence minor
coverage remains deferred to final review.
