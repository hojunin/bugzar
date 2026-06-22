/**
 * `/jira/draft` is report-less: the SDK posts capture artifacts INLINE (no
 * reportId / R2 read) and the issue links to the consumer's R2/S3 `url`.
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

const noAiEnv = () => ({}) as Env; // no AI binding → deterministic stub path

describe('POST /jira/draft — inline artifacts (report-less)', () => {
  it('drafts from inline artifacts and links to the provided url', async () => {
    const res = await worker.fetch(
      new Request('https://w/jira/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'bug',
          userInput: 'login button does nothing',
          url: 'https://cdn.example.com/r/abc.html',
          artifacts: {
            meta: { url: 'https://app.test', startedAt: 1000, durationMs: 500 },
            console: [{ level: 'error', args: ['boom'] }],
            network: [{ status: 500, url: 'https://app.test/api' }],
            events: [],
            storage: [],
          },
        }),
      }),
      noAiEnv(),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { mode: string; description: unknown };
    expect(data.mode).toBe('bug');
    expect(JSON.stringify(data.description)).toContain('https://cdn.example.com/r/abc.html');
  });

  it('omits the replay link when no url is provided', async () => {
    const res = await worker.fetch(
      new Request('https://w/jira/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'bug', userInput: 'something broke', artifacts: {} }),
      }),
      noAiEnv(),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { description: unknown };
    // No empty-href link node leaked into the ADF.
    expect(JSON.stringify(data.description)).not.toContain('"href":""');
  });
});
