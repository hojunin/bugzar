/**
 * Tests for the host-side network body sanitizer. This protects R2 +
 * Jira-linked replay URLs from leaking captured form PII.
 *
 * The bar is: any string body that crosses the sanitizer must have no
 * cleartext password/token/secret/API key for the keys we recognize.
 * False positives (legitimate data being masked) are an acceptable cost.
 */

import { describe, expect, it } from 'vitest';
import {
  _internal,
  redactFreeText,
  sanitizeNetworkBody,
  sanitizeStorageValue,
} from './sanitize-network-body';

// A realistic three-segment JWT (each segment ≥ 8 base64url chars).
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('isSensitiveKey', () => {
  it.each([
    ['password', true],
    ['Password', true],
    ['userPassword', true],
    ['password_hash', true],
    ['passwordSalt', true],
    ['passwd', true],
    ['pwd', true],
    ['secret', true],
    ['clientSecret', true],
    ['client_secret', true],
    ['token', true],
    ['accessToken', true],
    ['access_token', true],
    ['refreshToken', true],
    ['authorization', true],
    ['Authorization', true],
    ['credential', true],
    ['credentials', true],
    ['apikey', true],
    ['apiKey', true],
    ['API_KEY', true],
    ['x-api-key', true],
    ['private_key', true],
    ['privateKey', true],
    ['session_id', true],
    ['sessionId', true],
    ['cookie', true],
    ['Cookie', true],
  ])('matches sensitive key %s', (key, expected) => {
    expect(_internal.isSensitiveKey(key)).toBe(expected);
  });

  // email / phoneNumber moved to sensitive (#3 PII) — see the PII key patterns test.
  it.each([
    ['username', false],
    ['name', false],
    ['description', false],
    ['bookmark', false],
    ['address', false],
    ['createdAt', false],
    ['locale', false],
    ['productId', false],
    ['orderId', false],
  ])('does NOT match legitimate key %s', (key, expected) => {
    expect(_internal.isSensitiveKey(key)).toBe(expected);
  });
});

describe('maskJsonValue', () => {
  it('masks values under sensitive keys, leaves others', () => {
    const input = {
      username: 'alice',
      password: 'p@ssw0rd',
      email: 'alice@example.com',
      meta: { token: 'jwt.abc.def', name: 'Alice' },
    };
    const out = _internal.maskJsonValue(input) as Record<string, unknown>;
    expect(out.username).toBe('alice');
    expect(out.password).toBe('[REDACTED]');
    expect(out.email).toBe('[REDACTED]'); // #3: email is now a PII key
    expect((out.meta as Record<string, unknown>).token).toBe('[REDACTED]');
    expect((out.meta as Record<string, unknown>).name).toBe('Alice');
  });

  it('blanket-redacts sensitive keys even when value is object/array', () => {
    const input = {
      credentials: { user: 'a', pass: 'b' },
      tokens: ['t1', 't2'],
    };
    const out = _internal.maskJsonValue(input) as Record<string, unknown>;
    expect(out.credentials).toBe('[REDACTED]');
    expect(out.tokens).toBe('[REDACTED]');
  });

  it('walks arrays of objects', () => {
    const input = {
      users: [
        { name: 'alice', password: 'a' },
        { name: 'bob', password: 'b' },
      ],
    };
    const out = _internal.maskJsonValue(input) as { users: Record<string, unknown>[] };
    expect(out.users[0]!.name).toBe('alice');
    expect(out.users[0]!.password).toBe('[REDACTED]');
    expect(out.users[1]!.password).toBe('[REDACTED]');
  });

  it('does not mutate the input', () => {
    const input = { password: 'secret' };
    _internal.maskJsonValue(input);
    expect(input.password).toBe('secret');
  });

  it('passes through primitives and null', () => {
    expect(_internal.maskJsonValue('hello')).toBe('hello');
    expect(_internal.maskJsonValue(42)).toBe(42);
    expect(_internal.maskJsonValue(null)).toBe(null);
    expect(_internal.maskJsonValue(false)).toBe(false);
  });

  // S-5: a token-shaped value must be masked even under a NON-sensitive key.
  it('masks a JWT-looking string value under a non-sensitive key', () => {
    const out = _internal.maskJsonValue({ input: JWT, note: 'hi' }) as Record<string, unknown>;
    expect(out.input).toBe('[REDACTED]');
    expect(out.note).toBe('hi');
  });

  // Over-redaction guard: a benign JWT-SHAPED value (three dotted ≥8-char
  // segments) is NOT a real JWT — its first segment doesn't decode to a JSON
  // header — so it must survive. Masking it silently corrupts the captured
  // data the report exists to show (build IDs, commit/content hashes, ETags).
  it('does NOT redact benign JWT-shaped identifiers under benign keys', () => {
    const out = _internal.maskJsonValue({
      buildId: '20240101a.build1234.commit5678',
      contentHash: 'aaaaaaaa.bbbbbbbb.cccccccc',
      name: 'Alice',
    }) as Record<string, unknown>;
    expect(out.buildId).toBe('20240101a.build1234.commit5678');
    expect(out.contentHash).toBe('aaaaaaaa.bbbbbbbb.cccccccc');
    expect(out.name).toBe('Alice');
  });
});

describe('looksLikeJwt', () => {
  it('accepts a real JWT (first segment decodes to a JSON header with alg)', () => {
    expect(_internal.looksLikeJwt(JWT)).toBe(true);
  });

  it('rejects JWT-shaped but non-JWT identifiers (build/commit/hash IDs)', () => {
    expect(_internal.looksLikeJwt('20240101a.build1234.commit5678')).toBe(false);
    expect(_internal.looksLikeJwt('aaaaaaaa.bbbbbbbb.cccccccc')).toBe(false);
  });

  it('rejects non-JWT-shaped strings', () => {
    expect(_internal.looksLikeJwt('1.2.3')).toBe(false);
    expect(_internal.looksLikeJwt('hello world')).toBe(false);
  });
});

describe('maskUrlEncoded', () => {
  it('masks password=value', () => {
    const out = _internal.maskUrlEncoded('username=alice&password=secret');
    // Order is preserved.
    expect(out).toBe('username=alice&password=%5BREDACTED%5D');
  });

  it('masks multiple sensitive params', () => {
    const out = _internal.maskUrlEncoded('user=a&token=xyz&api_key=abc&safe=ok');
    const params = new URLSearchParams(out);
    expect(params.get('user')).toBe('a');
    expect(params.get('token')).toBe('[REDACTED]');
    expect(params.get('api_key')).toBe('[REDACTED]');
    expect(params.get('safe')).toBe('ok');
  });

  it('preserves percent-encoded keys/values', () => {
    const out = _internal.maskUrlEncoded('name=Mr%20Smith&password=hello%26world');
    const params = new URLSearchParams(out);
    expect(params.get('name')).toBe('Mr Smith');
    expect(params.get('password')).toBe('[REDACTED]');
  });
});

describe('sanitizeNetworkBody', () => {
  it('returns null for null input', () => {
    expect(sanitizeNetworkBody(null)).toBe(null);
  });

  it('returns empty string unchanged', () => {
    expect(sanitizeNetworkBody('')).toBe('');
  });

  it('returns host-patch placeholders unchanged', () => {
    expect(sanitizeNetworkBody('<Blob 1234B>')).toBe('<Blob 1234B>');
    expect(sanitizeNetworkBody('<ArrayBuffer 50B>')).toBe('<ArrayBuffer 50B>');
    expect(sanitizeNetworkBody('<File photo.jpg>')).toBe('<File photo.jpg>');
  });

  describe('JSON path', () => {
    it('masks JSON when declared application/json', () => {
      const body = JSON.stringify({ user: 'a', password: 'b' });
      const out = sanitizeNetworkBody(body, 'application/json; charset=utf-8');
      const parsed = JSON.parse(out as string);
      expect(parsed.user).toBe('a');
      expect(parsed.password).toBe('[REDACTED]');
    });

    it('masks JSON sniffed by shape (no Content-Type)', () => {
      const body = JSON.stringify({ token: 'xyz', safe: 'ok' });
      const out = sanitizeNetworkBody(body);
      const parsed = JSON.parse(out as string);
      expect(parsed.token).toBe('[REDACTED]');
      expect(parsed.safe).toBe('ok');
    });

    it('handles deeply nested objects', () => {
      const body = JSON.stringify({
        a: { b: { c: { password: 'x', d: { token: 'y' } } } },
      });
      const out = sanitizeNetworkBody(body, 'application/json');
      const parsed = JSON.parse(out as string);
      expect(parsed.a.b.c.password).toBe('[REDACTED]');
      expect(parsed.a.b.c.d.token).toBe('[REDACTED]');
    });

    it('falls through on malformed JSON without throwing', () => {
      const body = '{this is not json';
      const out = sanitizeNetworkBody(body, 'application/json');
      // Falls through to plain — returns untouched (no key-value shape).
      expect(out).toBe(body);
    });

    it('handles JSON arrays at root', () => {
      const body = JSON.stringify([{ password: 'a' }, { name: 'b' }]);
      const out = sanitizeNetworkBody(body, 'application/json');
      const parsed = JSON.parse(out as string) as Record<string, unknown>[];
      expect(parsed[0]!.password).toBe('[REDACTED]');
      expect(parsed[1]!.name).toBe('b');
    });
  });

  describe('URL-encoded path', () => {
    it('masks declared application/x-www-form-urlencoded', () => {
      const out = sanitizeNetworkBody(
        'username=alice&password=secret',
        'application/x-www-form-urlencoded',
      );
      const params = new URLSearchParams(out ?? '');
      expect(params.get('password')).toBe('[REDACTED]');
    });

    it('masks URL-encoded sniffed without Content-Type', () => {
      const out = sanitizeNetworkBody('user=a&password=b');
      const params = new URLSearchParams(out ?? '');
      expect(params.get('password')).toBe('[REDACTED]');
      expect(params.get('user')).toBe('a');
    });
  });

  describe('plain text path', () => {
    it('leaves ordinary free-form prose untouched (no false positives)', () => {
      const body = 'just a free-form sentence with the word password inside it';
      expect(sanitizeNetworkBody(body)).toBe(body);
    });

    it('leaves GraphQL-ish queries untouched (no key-value boundary)', () => {
      const body = 'query { user { id name } }';
      expect(sanitizeNetworkBody(body)).toBe(body);
    });

    // S-5: free-form bodies are best-effort scrubbed for token-shaped secrets.
    it('redacts a Bearer token embedded in free text', () => {
      const out = sanitizeNetworkBody(`Authorization is Bearer ${JWT} for this call`);
      expect(out).not.toContain(JWT);
      expect(out).toContain('[REDACTED]');
    });

    it('redacts sensitive XML elements (SOAP/SAML bodies)', () => {
      const out = sanitizeNetworkBody('<root><password>secret</password><user>a</user></root>');
      expect(out).not.toContain('secret');
      expect(out).toContain('<user>a</user>');
    });
  });

  describe('the threat scenario this fixes', () => {
    it('login form POST body has no cleartext password after sanitization', () => {
      // What the host-script captures from a real Mock login form.
      const captured = JSON.stringify({
        email: 'qa-tester@musinsa.com',
        password: 'TestPassword123!',
        rememberMe: true,
      });
      const sanitized = sanitizeNetworkBody(captured, 'application/json');
      expect(sanitized).not.toContain('TestPassword123!');
      const parsed = JSON.parse(sanitized as string);
      expect(parsed.email).toBe('[REDACTED]'); // #3: email is now redacted (PII)
      expect(parsed.rememberMe).toBe(true);
    });

    it('OAuth token exchange URL-encoded body has no cleartext code/secret', () => {
      const captured =
        'grant_type=authorization_code&code=AUTH_CODE_xyz&client_id=bugzar&client_secret=SUPER_SECRET';
      const sanitized = sanitizeNetworkBody(captured, 'application/x-www-form-urlencoded');
      expect(sanitized).not.toContain('SUPER_SECRET');
      // `client_secret` matches; `code` (= authorization_code grant) is not
      // currently on our sensitive list — that's a known gap documented in
      // the threat model (intentional false-negative to avoid masking
      // every URL param literally named `code`).
      const params = new URLSearchParams(sanitized ?? '');
      expect(params.get('client_secret')).toBe('[REDACTED]');
      expect(params.get('grant_type')).toBe('authorization_code');
    });
  });
});

describe('redactFreeText', () => {
  it('masks Bearer tokens', () => {
    expect(redactFreeText(`call Bearer ${JWT} now`)).not.toContain(JWT);
  });

  it('masks bare JWTs embedded in text', () => {
    expect(redactFreeText(`prefix ${JWT} suffix`)).not.toContain(JWT);
  });

  it('masks sensitive XML/SOAP elements', () => {
    expect(redactFreeText('<clientSecret>abc123</clientSecret>')).toBe(
      '<clientSecret>[REDACTED]</clientSecret>',
    );
  });

  it('leaves ordinary text untouched (no false positives)', () => {
    expect(redactFreeText('the password field is required')).toBe('the password field is required');
  });

  it('does NOT redact benign dotted identifiers in free text (over-redaction guard)', () => {
    const s = 'loaded chunk aaaaaaaa.bbbbbbbb.cccccccc at build 20240101a.build1234.commit5678';
    expect(redactFreeText(s)).toBe(s);
  });

  // A regex lookbehind literal is a parse-time SyntaxError on Safari < 16.4 /
  // old WebKit; because these regexes are module-scope literals eagerly evaluated
  // through @bugzar/sdk's static import chain, it would abort the whole SDK at import.
  it('uses no regex lookbehind (Safari < 16.4 / old WebKit parse crash)', () => {
    for (const re of _internal.freeTextRegexes) {
      expect(re.source).not.toMatch(/\(\?<[!=]/);
    }
  });
});

describe('sanitizeStorageValue', () => {
  it('redacts the whole value when the KEY is sensitive', () => {
    expect(sanitizeStorageValue('sb-xyz-auth-token', '{"a":1}')).toBe('[REDACTED]');
    expect(sanitizeStorageValue('accessToken', 'whatever')).toBe('[REDACTED]');
  });

  it('redacts a bare JWT value under a benign key', () => {
    expect(sanitizeStorageValue('cache', JWT)).toBe('[REDACTED]');
  });

  it('masks token sub-keys inside a JSON value (Supabase/Auth0-shaped)', () => {
    const v = JSON.stringify({ access_token: JWT, refresh_token: 'r', user: { id: 1 } });
    const out = sanitizeStorageValue('session', v);
    expect(out).not.toContain(JWT);
    expect(out).toContain('"id":1');
  });

  it('leaves a benign value untouched', () => {
    expect(sanitizeStorageValue('theme', 'dark')).toBe('dark');
  });
});

// ── PR-1 shared foundation (#3/#5/#6) ──
describe('PII key patterns (#3) — narrow, no over-redaction', () => {
  const { isSensitiveKey } = _internal;
  it('matches compound PII field names', () => {
    expect(isSensitiveKey('email')).toBe(true);
    expect(isSensitiveKey('firstName')).toBe(true);
    expect(isSensitiveKey('user_last_name')).toBe(true);
    expect(isSensitiveKey('creditCard')).toBe(true);
    expect(isSensitiveKey('postal_code')).toBe(true);
  });
  it('does NOT match benign look-alikes (bare name/address/tel avoided)', () => {
    expect(isSensitiveKey('filename')).toBe(false);
    expect(isSensitiveKey('name')).toBe(false);
    expect(isSensitiveKey('ip_address')).toBe(false);
    expect(isSensitiveKey('mac_address')).toBe(false);
    expect(isSensitiveKey('telemetry')).toBe(false);
    expect(isSensitiveKey('description')).toBe(false);
  });
});

describe('redactPiiText (#3) — email / phone / Luhn card', () => {
  const { redactPiiText } = _internal;
  it('masks email, preserving the boundary', () => {
    expect(redactPiiText('mail me at a.b+x@corp.co.uk please')).toBe(
      'mail me at [REDACTED] please',
    );
  });
  it('masks E.164 and delimited phones, not bare digit runs', () => {
    expect(redactPiiText('call +14155550123')).toBe('call [REDACTED]');
    expect(redactPiiText('tel 415-555-0123')).toBe('tel [REDACTED]');
    expect(redactPiiText('order 12345678 shipped')).toBe('order 12345678 shipped');
  });
  it('masks a Luhn-valid card but leaves non-card digit runs', () => {
    expect(redactPiiText('card 4111 1111 1111 1111 end')).toBe('card [REDACTED] end');
    expect(redactPiiText('id 1234567812345678')).toBe('id 1234567812345678'); // fails Luhn
  });
  it('is idempotent on [REDACTED]', () => {
    expect(redactPiiText('[REDACTED]')).toBe('[REDACTED]');
  });
});

describe('maskJsonValue PII under benign keys (#3)', () => {
  const { maskJsonValue } = _internal;
  it('scrubs email in a value even when the key is benign', () => {
    const out = maskJsonValue({ note: 'ping a@b.com', profile: { email: 'x@y.io' } });
    expect(JSON.stringify(out)).not.toContain('a@b.com'); // value-level scrub
    expect(JSON.stringify(out)).not.toContain('x@y.io'); // key-level (email key)
  });
});

describe('isSensitiveHeader (#6) — substring, deny-by-default', () => {
  const { isSensitiveHeader } = _internal;
  it('catches custom auth/session/csrf headers incl. IANA standard ones', () => {
    for (const h of [
      'authorization',
      'x-access-token',
      'x-csrf-token',
      'x-session-id',
      'authentication',
      'proxy-authorization',
      'x-amz-security-token',
    ]) {
      expect(isSensitiveHeader(h)).toBe(true);
    }
  });
  it('leaves benign headers intact (content-type must survive)', () => {
    expect(isSensitiveHeader('content-type')).toBe(false);
    expect(isSensitiveHeader('content-length')).toBe(false);
    expect(isSensitiveHeader('accept')).toBe(false);
  });
});

describe('sanitizeUrl (#5) — credential query params only', () => {
  const { sanitizeUrl } = _internal;
  it('redacts credential param values, keeps host/path and benign params', () => {
    expect(sanitizeUrl('https://api.x/v1?token=abc&page=2')).toBe(
      'https://api.x/v1?token=[REDACTED]&page=2',
    );
    expect(sanitizeUrl('https://x/cb?code=AUTHZ&state=s')).toBe(
      'https://x/cb?code=[REDACTED]&state=[REDACTED]',
    );
  });
  it('does NOT redact benign / PII-but-not-credential params', () => {
    expect(sanitizeUrl('https://x/y?q=1')).toBe('https://x/y?q=1');
    expect(sanitizeUrl('https://x/y?postal_code=90210')).toBe('https://x/y?postal_code=90210');
  });
  it('redacts implicit-flow token in the URL fragment', () => {
    expect(sanitizeUrl('https://x/#access_token=xyz&scope=read')).toBe(
      'https://x/#access_token=[REDACTED]&scope=read',
    );
  });
  it('leaves URLs with no query/fragment untouched (relative ok)', () => {
    expect(sanitizeUrl('/r/abc')).toBe('/r/abc');
    expect(sanitizeUrl('https://x/path')).toBe('https://x/path');
  });
});
