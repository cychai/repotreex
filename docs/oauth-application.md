# CNB OAuth application request

This document is a registration request for a possible fallback. RepoTreeX
0.1.0 does not implement or expose OAuth, and this document is not evidence of
approval or registration.

## Application

- **Application name:** RepoTreeX for CNB
- **Purpose:** Allow the installed RepoTreeX browser extension to read the
  current user's accessible repository tree if same-origin CNB web-session
  requests are no longer available.
- **Client type:** Public client. Browser extensions cannot keep a client
  secret, so no client secret may be issued, embedded, distributed, or required.
- **Preferred grant:** OAuth 2.0 Authorization Code with PKCE.
- **Fallback grant:** Device Authorization Grant when CNB cannot support a safe
  installed-application redirect for Authorization Code with PKCE.

## Registration inputs required from CNB

- `client_id`: **SUPPLIED BY CNB DURING APPLICATION REGISTRATION**. RepoTreeX
  contains no placeholder runtime value and must not invent one.
- Redirect URI: `<CNB-REGISTRATION-SUPPLIED-EXTENSION-REDIRECT-URI>`. This is an
  **application-registration input**, not user-editable runtime configuration.
  CNB must confirm the exact installed-extension redirect form before any OAuth
  implementation is enabled.
- Client secret: none. RepoTreeX is a public client and cannot protect one.
- Grant approval: Authorization Code + PKCE, with Device Authorization as the
  fallback only if CNB supports it.

## Minimal requested scopes

- `repo-code:r` — required for read-only repository contents, refs, and branch
  navigation used by the tree.
- `repo-release:r` — optional; request it only when tag enumeration requires
  release read access.

No write, account-administration, organization-administration, webhook,
workflow, or broad user-data scopes are requested. If CNB documents a narrower
read scope for any current operation, use that narrower scope before enabling
the fallback.

## Enablement gate

OAuth UI remains disabled until CNB supplies a real `client_id`, confirms the
registered redirect URI or Device Authorization support, and approves the exact
minimal scopes. Approval would authorize a separate implementation and security
review; it would not retroactively make OAuth active in version 0.1.0.
