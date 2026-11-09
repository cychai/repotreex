# GitHub Public Page Contract

## github-html-v1

- Observation target: public `octocat/Hello-World`, no cookies or token. The fixed tagged public repository `git/git` was used only for the tag-item selector and property paths because the primary target has no tags. Public `/login` was used only for the metadata-free login discriminator.
- Repository page selector: `script[type="application/json"][data-target="react-app.embeddedData"]`.
- Required JSON paths: root current ref and tree are `payload.codeViewRepoRoute.refInfo.name`, `payload.codeViewRepoRoute.refInfo.currentOid`, `payload.codeViewRepoRoute.path`, `payload.codeViewRepoRoute.tree.items[].name`, `payload.codeViewRepoRoute.tree.items[].path`, and `payload.codeViewRepoRoute.tree.items[].contentType`; tree pages use `payload.codeViewTreeRoute.refInfo.name`, `payload.codeViewTreeRoute.refInfo.currentOid`, `payload.codeViewTreeRoute.path`, `payload.codeViewTreeRoute.tree.items[].name`, `payload.codeViewTreeRoute.tree.items[].path`, and `payload.codeViewTreeRoute.tree.items[].contentType`.
- Branch selector/paths: `script[type="application/json"][data-target="react-app.embeddedData"]`; normalized fields use `payload.branches[].name` and `payload.branches[].path`, with pagination from `payload.current_page`, `payload.has_more`, and `payload.per_page`.
- Tag selector/paths: rows use `rails-partial[data-partial-name="tagsIndexRoute.Results"] .Box-row`; the normalized tag name is the row's `h2 a.Link--primary` `textContent`, the commit identifier is the `attributes.href.value` of the row link whose prefix matches the requested repository plus `/commit/`, and the next cursor is the `after` search parameter in `a[rel="next"][href*="after="]` `attributes.href.value`. Repository-specific href prefixes are validated against the requested repository rather than hard-coded by the decoder.
- Login/not-found discriminators: login is HTTP 200 with `form[action="/session"] input[name="login"]`; not found is HTTP 404 at the transport boundary.
- Request URLs: root `/<owner>/<repository>`; tree `/<owner>/<repository>/tree/<ref-or-ref-and-path>`; branches `/<owner>/<repository>/branches/all?page=<positive-integer>`; tags first page `/<owner>/<repository>/tags` and subsequent pages `/<owner>/<repository>/tags?after=<cursor>`.
- Bounds: 2,000,000 HTML units; 10 pages; 100 normalized refs per page.
- Raw pages were stored only under a temporary directory and deleted.

The contract records selectors and property paths only. It contains no downloaded response body,
headers, cookies, account metadata, or private repository data.
