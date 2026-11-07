# RepoTreeX privacy statement

This statement describes RepoTreeX 0.1.0 as implemented today.

## Authentication and requests

Current CNB session cookies are attached by the browser to same-origin
`https://cnb.cool` requests. RepoTreeX cannot read or export HttpOnly cookies.
It does not use the browser cookies API or read `document.cookie`. Its page
bridge permits only fixed, read-only CNB repository request shapes and does not
send repository data to another origin.

## Data handling

Repository structure stays in tab memory. Repository slugs, refs, paths, tree
nodes, expanded paths, selections, search queries, response bodies, and
authentication material are not written to browser storage. Repository or ref
replacement, authorization failure, tab lifecycle teardown, extension reload,
or removal makes the outgoing in-memory session unavailable to RepoTreeX.

Only panel width/open state persist in `chrome.storage.local`. No other
preference or repository metadata is persisted.

RepoTreeX has no analytics. There is no external service transmission: runtime
network requests are same-origin requests to CNB for the repository page being
viewed. Production code does not log repository metadata, response bodies,
cookies, or tokens.

The extension manifest requests only `storage` and host access to
`https://cnb.cool/*`; it does not request cookies, web-request interception,
browsing-history, clipboard, or broad tab permissions.

## Current boundary

RepoTreeX does not register an OAuth application, contain a `client_id` or
client secret, or expose active OAuth controls. The current implementation also
does not provide analytics, crash reporting, telemetry, or a remote update
service of its own. Browser and CNB platform behavior remain governed by their
respective products and policies.
