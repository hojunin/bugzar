import { z } from 'zod';

/**
 * Per-session manifest. Single source of truth for what files exist for a
 * session and what time axis they share. M1 uses this in IndexedDB only
 * (cloud version arrives in M4).
 *
 * NOTE: schemaVersion is a literal — bump and add a migration when the
 * shape changes. Future readers should branch on this value.
 */
export const SessionManifestSchema = z
  .object({
    sessionId: z.string().uuid(),
    schemaVersion: z.literal(1),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    url: z.string().url(),
    userAgent: z.string(),
    viewport: z.object({
      w: z.number().int().positive(),
      h: z.number().int().positive(),
      dpr: z.number().positive(),
    }),
    // M4+ populates user.email from Atlassian token; M1 leaves it null.
    user: z
      .object({
        email: z.string().email().nullable(),
        name: z.string().nullable(),
      })
      .default({ email: null, name: null }),
    stats: z.object({
      // M1 sets rrwebEvents + consoleErrors; networkRequests, userActions stay 0 until M3.
      rrwebEvents: z.number().int().nonnegative(),
      networkRequests: z.number().int().nonnegative(),
      consoleErrors: z.number().int().nonnegative(),
      userActions: z.number().int().nonnegative(),
    }),
    // M3+ populates redactions; M1 leaves defaults.
    redactions: z
      .object({
        passwordFieldsMasked: z.number().int().nonnegative(),
        headersStripped: z.array(z.string()),
        manualRedactionsCount: z.number().int().nonnegative(),
      })
      .default({ passwordFieldsMasked: 0, headersStripped: [], manualRedactionsCount: 0 }),
  })
  .superRefine((m, ctx) => {
    const start = Date.parse(m.startedAt);
    const end = Date.parse(m.endedAt);
    if (end < start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: `endedAt (${m.endedAt}) is before startedAt (${m.startedAt})`,
      });
    }
    const computed = Math.max(0, end - start);
    if (m.durationMs !== computed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationMs'],
        message: `durationMs (${m.durationMs}) does not match endedAt-startedAt (${computed})`,
      });
    }
  });

export type SessionManifest = z.infer<typeof SessionManifestSchema>;
