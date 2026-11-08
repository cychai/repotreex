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
Tests       100 passed (100)
```

Full validation:

```text
npm test
Test Files  17 passed (17)
Tests       988 passed (988)

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
