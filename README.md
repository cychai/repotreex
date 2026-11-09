# RepoTreeX

RepoTreeX is an unpacked Manifest V3 extension that adds a repository tree to
supported CNB and GitHub repository pages. It reuses the current website login
session for read-only, same-origin requests without reading, exporting, or
persisting cookies and access tokens.

Version 0.1.0 is an initial development release. CNB repository browsing is
available; GitHub route and same-origin transport support is under active
development, while its repository provider and user-interface integration are
not complete yet. RepoTreeX is not published in the Chrome Web Store or QQ
Browser store, and OAuth is not required or active.

## Prerequisites

- Node.js 24.15 or later in the Node 24 release line
- npm
- `zip` and `unzip` for release packaging and inspection
- QQ Browser or Chrome with extension developer mode available
- CNB or GitHub access appropriate for each repository being viewed

Install the locked development dependencies and validate the checkout:

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run package
unzip -l dist/repotreex-0.1.0.zip
```

`npm run package` rebuilds the extension and writes both the unpacked extension
to `dist/extension/` and the release archive to
`dist/repotreex-0.1.0.zip`. The ZIP is a release artifact for inspection or
controlled distribution; it is not evidence of store publication.

## Load the unpacked extension

1. Run `npm run build` or `npm run package`.
2. Open QQ Browser's extension-management page or Chrome's
   `chrome://extensions` page.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the absolute `dist/extension/` directory from this checkout.
6. Open or reload a supported repository page. Version 0.1.0 currently mounts
   the complete tree interface on `https://cnb.cool/`; GitHub mounting remains
   under development.

After rebuilding, use the extension page's **Reload** action and then reload
the CNB tab. Installation and removal are user actions; the project does not
perform them automatically.

## Supported routes and usage

RepoTreeX currently activates on CNB repository roots, blob/file routes, and
single-commit routes for nested repository slugs. Repository roots and commit
routes resolve the repository HEAD. Blob routes synchronize the current ref and
file, including discovered branch or tag names that contain slashes. Other CNB
routes stay untouched. GitHub root, tree, and blob route parsing plus bounded
same-origin page transport are implemented, but the GitHub decoder, provider,
panel integration, and final manifest enablement are still in progress.

The first release provides:

- a left-side, resizable and collapsible repository tree;
- lazy directory expansion and current-file reveal;
- file navigation through canonical CNB blob URLs;
- branch and tag selection;
- case-insensitive search across nodes already loaded in the tab;
- optional bounded full-tree loading for search, with progress, cancellation,
  a 10,000-node ceiling, and explicit truncation;
- keyboard tree controls, light/dark appearance, and retryable error states;
- persistence of only panel open/closed state and panel width.

The primary data path calls only allowlisted, read-only, same-origin routes.
Current website session cookies are attached by the browser; RepoTreeX does not
read or export cookies. See [Privacy](docs/privacy.md) and the
[manual verification matrix](docs/manual-test.md).

## Known limits

- Live CNB endpoint schema, private-repository access, logout behavior, QQ
  Browser compatibility, and CNB layout variants require manual acceptance in
  the target browser.
- GitHub repository decoding, tree loading, panel integration, manifest access,
  and public/private browser acceptance are not complete in version 0.1.0.
- OAuth controls are absent and remain disabled until CNB approves and supplies
  a real public-client registration. See
  [OAuth application request](docs/oauth-application.md).
- Search matches file/path names, not file contents. Only loaded nodes are
  searched unless the user starts bounded full-tree loading.
- Full-tree loading is capped and can report a truncated result; large
  repositories are not promised to be fully indexed.
- A browser request already sent before navigation or cancellation may finish,
  but late results are ignored and repository structure is not persisted.
- Store publication, automatic updates, full-text search, multiple file tabs,
  bookmarks, file history, and merge-request change trees are not implemented.

## Clean-room boundary

RepoTreeX is an independent implementation based on CNB and GitHub public or
documented interfaces and observed product behavior. It does not include copied,
decompiled, transformed, or derived Octotree source code, assets, identifiers,
or proprietary protocols. Octotree is only a user-experience reference.
