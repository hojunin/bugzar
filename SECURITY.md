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

- Keep the Atlassian `client_secret` on your backend service, never inlined
  into the client bundle.
- Restrict your backend's CORS origin to your own app/extension (a default `*`
  is for development convenience only).
- Captured artifacts stored by your backend can contain sensitive capture data;
  there is no end-user delete UI, so treat that storage as sensitive and limit
  access accordingly.
- The AI sanitizer redacts Authorization / Cookie / JWT before any AI call, but
  raw artifacts in storage are preserved as captured.
