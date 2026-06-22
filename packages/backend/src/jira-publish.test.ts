/**
 * Report-less SDK publish: `POST /jira/publish` creates a Jira issue server-side
 * (service account) from a title/description/projectKey — no reportId, no R2.
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

const env = (over: Partial<Env> = {}): Env => ({ ...over }) as Env;

const post = (path: string, body: unknown, e: Env) =>
  worker.fetch(
    new Request(`https://w.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    e,
  );

describe('POST /jira/publish (report-less)', () => {
  it('stubs with stubbed:true when Jira is unconfigured', async () => {
    const res = await post('/jira/publish', { title: 'Bug: login', projectKey: 'BUGZAR' }, env());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stubbed: boolean }).stubbed).toBe(true);
  });

  it('400 without a title', async () => {
    const res = await post('/jira/publish', { projectKey: 'BUGZAR' }, env());
    expect(res.status).toBe(400);
  });
});
