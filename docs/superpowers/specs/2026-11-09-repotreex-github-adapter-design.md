# RepoTreeX GitHub Adapter Design

## 1. Purpose and Scope

RepoTreeX will become a multi-platform Manifest V3 browser extension named
`RepoTreeX`. It will support repository browsing on both:

- `https://cnb.cool/*`
- `https://github.com/*`

GitHub support must be functionally equivalent to the existing CNB support:

- lazy repository-tree loading;
- file navigation and current-file reveal;
- branch and tag selection, including refs containing `/`;
- search over loaded paths and bounded, cancellable full-tree search;
- single-page-application, refresh, and browser-history synchronization;
- panel collapse and width persistence;
- public and private repositories available to the current signed-in user.

This change must preserve existing CNB behavior. GitLab, self-hosted GitLab,
GitHub Enterprise, OAuth, personal access tokens, file-content search, mutation
operations, and extension-store publication are outside this design.

## 2. Product and Privacy Contract

The extension uses the current website session for each platform. For GitHub,
a main-world bridge makes same-origin, read-only requests to `github.com` with
`credentials: "include"`; the browser attaches HttpOnly session cookies. The
extension must never:

- request browser cookie permissions;
- read, serialize, log, persist, or export cookies;
- ask the user to copy a token;
- submit forms or perform mutation requests;
- call `api.github.com` or GitHub GraphQL;
- persist repository slugs, refs, file paths, tree nodes, expanded paths,
  search queries, response HTML, or private-repository metadata.

Repository data remains in the current tab's memory. Persistent storage remains
limited to panel open/closed state, panel width, and explicitly approved
non-sensitive display preferences. CNB and GitHub share those presentation
preferences.

## 3. Architecture

### 3.1 Platform registry

The bootstrap layer selects a platform adapter from the current URL. It does
not contain host-specific route or response logic.

```text
Current URL
    |
    v
PlatformRegistry
    |-- CnbAdapter
    `-- GitHubAdapter
            |
            v
Unified RepositoryProvider
            |
            v
TreeStore -> Search -> Panel
```

The registry recognizes only exact HTTPS origins. An adapter exposes a focused
contract for:

- recognizing and parsing supported repository routes;
- reconciling ambiguous ref/path segments with discovered refs;
- building canonical native file and directory URLs;
- constructing platform-scoped, allowlisted read requests;
- decoding platform responses into normalized repository models;
- mapping platform failures into fixed RepoTreeX error categories.

The tree store, search traversal, panel, preference store, and normalized error
presentation remain platform-independent.

### 3.2 Platform context

A parsed route produces a platform-qualified repository context rather than a
bare repository string:

```ts
type PlatformId = "cnb" | "github";

interface RepositoryContext {
  platform: PlatformId;
  repository: string;
  ref?: string;
  path?: string;
  view: "root" | "tree" | "blob";
}
```

The exact implementation types may differ, but platform identity must remain
explicit at every request-building boundary. A CNB context cannot be passed to
the GitHub request builder, and a GitHub context cannot be passed to the CNB
request builder.

### 3.3 Provider boundary

The existing normalized provider behavior remains the consumer-facing
contract:

- get the default/current HEAD ref;
- list branches;
- list tags;
- list one directory for a repository, ref, and path;
- dispose or abort outstanding work.

Each platform owns its response decoder. Decoders copy only required scalar
fields and normalized tree entries. They never retain source HTML, embedded
objects, DOM nodes, accessors, proxies, or arbitrary response metadata.

## 4. GitHub Integration

### 4.1 Supported routes

The first GitHub release supports exact `https://github.com` repository routes:

- `/<owner>/<repository>`
- `/<owner>/<repository>/tree/<ref-or-ref-and-path>`
- `/<owner>/<repository>/blob/<ref-or-ref-and-path>`

Known non-code repository routes such as issues, pulls, actions, releases,
settings, commits, security, insights, and account-level pages must not mount a
repository tree unless a separately supported code route is active.

The parser validates path encoding, rejects credentials and non-default ports,
and treats owner/repository as exactly two leading path segments. It does not
infer support for GitHub Enterprise hosts.

GitHub tree/blob URLs are ambiguous when refs contain `/`. Initial parsing may
produce an unresolved suffix. After branch and tag discovery, the adapter uses
the longest valid discovered ref prefix and treats the remaining segments as
the repository path. A canonical ref supplied by GitHub's structured page data
may resolve the ambiguity earlier, but untrusted page text alone must not.

### 4.2 Same-origin read transport

The GitHub main-world bridge accepts typed operations, not arbitrary URLs. It
constructs requests itself and permits only:

- method `GET`;
- exact origin `https://github.com`;
- the current parsed repository's owner/repository prefix;
- explicit repository-root, tree/blob, branches, and tags page shapes required
  by the adapter;
- `credentials: "include"`;
- `cache: "no-store"` unless a later verified GitHub behavior requires a
  narrower change.

Page input cannot choose an origin, method, repository, redirect target, or
arbitrary pathname. Requests for one platform are rejected by the other
platform's builder. The bridge returns a bounded response envelope suitable for
decoding; it never logs a URL, body, repository, ref, or path.

The implementation must set a conservative maximum accepted HTML payload size
and fail with a fixed compatibility error if that limit is exceeded. It must
not cache raw pages between requests.

### 4.3 Response decoding

GitHub has no approved, stable same-session repository API for this design.
The adapter therefore decodes GitHub repository pages as a versioned
compatibility layer:

1. Prefer narrowly identified structured data embedded in the returned page.
2. Validate the complete envelope and required fields before normalization.
3. Use narrowly scoped semantic HTML only as an explicit decoder version, not
   a broad scan of arbitrary scripts, text, or the current live DOM.
4. Copy only ref names, entry names, entry kinds, paths, and identifiers needed
   by the normalized provider.
5. Discard the source page and intermediate structures after each decode.

The decoder must have fixture-based tests for every accepted response version.
If GitHub changes its page structure, RepoTreeX shows a fixed compatibility
error. It must not include response snippets, HTML, repository metadata, or
parser exceptions in user-visible messages or production logs.

Before implementation chooses a concrete embedded-data selector or page
schema, it must verify the current public GitHub response using public
repositories only. That observation becomes a synthetic, de-identified test
fixture; captured account, session, and private-repository data are forbidden.

### 4.4 Native navigation

Selecting a GitHub file navigates to GitHub's canonical
`/<owner>/<repository>/blob/<encoded-ref>/<encoded-path>` URL. Directory
navigation uses the corresponding `/tree/` URL when navigation is required;
ordinary expansion remains lazy and in-panel.

The adapter preserves GitHub browser history and sharing semantics. It does not
replace GitHub's code viewer or synthesize extension-owned content URLs.

### 4.5 Branches, tags, and search

The adapter obtains branch and tag choices from the allowlisted same-origin
GitHub pages and normalizes them into the shared ref model. Pagination is
bounded and cancellable. A failure to enumerate optional additional pages must
be explicit rather than silently presenting an apparently complete list.

Loaded-node search remains immediate and local to tab memory. Full-tree search
uses the existing bounded traversal, concurrency limits, cancellation, and
truncation behavior while loading directories through the selected platform
provider. It never searches file contents.

## 5. Lifecycle and Error Handling

Navigation, repository changes, ref changes, teardown, extension reload, and
authorization failures invalidate the active platform session. The controller
must abort pending work, make late responses unreachable, clear tree/search
state, and then start a fresh session only when the new route is supported.

Platform results map to shared, metadata-free errors:

| Result | RepoTreeX behavior |
|---|---|
| Signed out or expired session | Clear data and ask the user to sign in |
| Private-repository access denied | Clear data and show access denied |
| Repository or path not found | Clear stale data and show not found |
| Rate limited or temporarily unavailable | Show a fixed retryable error |
| GitHub page schema changed | Show a fixed compatibility error |
| Network failure | Show a fixed retryable network error |

Raw response text, redirect pages, parser errors, and repository identifiers
must not be interpolated into errors. An authorization-shaped HTML login page
must be distinguished from a valid repository page without extracting account
details.

## 6. Manifest and User Interface

The product name and description become platform-neutral: `RepoTreeX` and a
repository-tree description that names CNB and GitHub only where useful.

Manifest scope expands precisely to:

```json
{
  "host_permissions": [
    "https://cnb.cool/*",
    "https://github.com/*"
  ]
}
```

Both isolated content code and required main-world bridge code match only those
two origins. No broad tab, cookies, web-request, browsing-history, clipboard,
or external-host permission is added.

The same Shadow DOM panel is used on both platforms. Platform-specific layout
integration is isolated behind a small host-layout adapter so GitHub fixes do
not alter CNB padding or positioning. The panel retains visible focus,
keyboard-only tree operation, reduced-motion behavior, light/dark compatibility,
and narrow viewport behavior.

## 7. Code Organization

The implementation should evolve toward these responsibilities without
forcing exact filenames where the current structure suggests a cleaner split:

- platform registry and platform-qualified context types;
- shared normalized provider and error types;
- CNB route, request, decoder, and native-URL adapter;
- GitHub route, request, decoder, and native-URL adapter;
- platform-neutral controller/bootstrap orchestration;
- per-platform host-layout integration;
- unchanged shared tree store, search, panel, and preference behavior.

Low-level segment/control-character validation should be shared where the
rules are genuinely platform-independent. Endpoint allowlists and response
decoders remain separate because their trust boundaries differ.

## 8. Testing Strategy

### 8.1 Automated tests

Existing CNB tests remain the regression baseline. New or generalized tests
must cover:

- exact-origin platform selection and rejection of unsupported hosts;
- GitHub root/tree/blob route parsing and unsupported repository routes;
- encoded paths, malformed input, and slash-containing ref reconciliation;
- cross-platform request confusion and arbitrary-URL rejection;
- exact same-origin credentialed `GET` request construction;
- public synthetic GitHub embedded-data and semantic-HTML decoder versions;
- malformed, accessor-backed, proxy, oversized, and login/error responses;
- branch/tag pagination, cancellation, and partial-failure behavior;
- directory normalization and lazy expansion;
- file navigation, current-file reveal, and native URL encoding;
- SPA, refresh, back/forward, repository/ref changes, BFCache, and teardown;
- `401`/`403`/`404`, rate limit, network, server, and compatibility cleanup;
- loaded and bounded full-tree search on both platforms;
- storage architecture proving only approved presentation preferences persist;
- build/package tests proving the manifest contains only the two approved
  origins and no source maps, logs, or captured response fixtures.

GitHub parser tests use synthetic fixtures derived from public response shapes.
No live response body, account data, Cookie, token, private repository name,
private path, or private page is committed.

### 8.2 Browser acceptance

Run the shared workflow on a public CNB repository and a public GitHub
repository:

- root load and at least two directory expansions;
- file navigation and selected-file reveal;
- branch and tag changes, including a slash ref when available;
- loaded-node and bounded full-tree search;
- resize, collapse/reopen, refresh, reload, and browser back/forward;
- desktop/narrow width, light/dark appearance, keyboard operation, focus,
  reduced motion, long names, loading, empty, and retry states;
- no application console output containing repository metadata;
- no cross-origin or mutation request.

Private GitHub acceptance requires action-time user coordination. The user
selects an already accessible private repository in a signed-in browser. The
test confirms equivalent behavior, same-origin `github.com` requests, and
storage limited to presentation preferences without recording repository
names, refs, paths, screenshots, response bodies, or network exports.

A separately authorized sign-out or access-revocation test confirms the next
request clears tree/search memory, shows a fixed authorization error, persists
no repository metadata, and reloads only after a fresh signed-in session.

## 9. Migration and Compatibility

Existing users keep the same preference storage key and values so panel state
survives the rename. No repository state is migrated because none is
persisted. The CNB adapter must pass its existing automated and browser
acceptance suite before GitHub support is considered complete.

The installed extension ID may remain stable for unpacked development only if
the browser retains it for the same directory. This design does not promise a
store identity, update channel, or migration from another extension.

## 10. Delivery Criteria

The GitHub expansion is complete only when:

1. The extension is named `RepoTreeX` and activates only on approved CNB and
   GitHub routes.
2. CNB behavior remains green in automated and browser regression checks.
3. GitHub public repositories pass the equivalent functional and visual flow.
4. A user-coordinated private GitHub repository passes without metadata
   capture.
5. The extension reads no Cookie, requests no token, and performs no mutation.
6. Storage contains only approved non-sensitive panel preferences.
7. All tests, type checks, lint, package/privacy checks, and Chromium-compatible
   browser probes pass from a clean dependency install.
8. No unresolved Critical or Important review finding remains.

