# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report privately via [GitHub Security Advisories][advisory] (the
"Report a vulnerability" button on the repository's **Security** tab). We'll
acknowledge within a reasonable timeframe and coordinate a fix and disclosure.

[advisory]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

## Scope notes for self-hosters

Bugzar captures DOM, console, network, and storage from pages under QA —
this can include sensitive data from authenticated pages. When you self-host:

- Keep the Atlassian `client_secret` server-side: set `VITE_OAUTH_VIA_WORKER=1`
  and store credentials via `wrangler secret put`, rather than inlining the
  secret into the extension bundle. See [`docs/SETUP.md`](./docs/SETUP.md) §1.3.
- Restrict the Worker CORS origin to your own extension ID (the default `*` is
  for development convenience).
- R2 artifacts are retained until the retention cron expires them; there is no
  end-user delete UI. Treat the bucket as containing potentially sensitive
  capture data and limit access accordingly.
- The AI sanitizer redacts Authorization / Cookie / JWT before sending to
  Workers AI, but raw artifacts in R2 are preserved as captured.
