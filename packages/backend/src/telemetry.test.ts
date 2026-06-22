/**
 * /telemetry/event endpoint tests (Phase 2 Task 27).
 *
 * The worker module exports `default.fetch`; we drive it directly here, with
 * a minimal Env stub (no R2 / AI / Analytics Engine — telemetry route does
 * not need any of those when the AE binding is absent).
 */

import { describe, expect, it, vi } from 'vitest';
import worker from './worker';

const makeRequest = (body: unknown): Request =>
  new Request('https://example.com/telemetry/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const stubEnv = (overrides: Record<string, unknown> = {}) =>
  ({
    ARTIFACTS: {} as unknown,
    ...overrides,
  }) as unknown as Parameters<typeof worker.fetch>[1];

describe('POST /telemetry/event', () => {
  it('accepts a well-formed event and returns 202', async () => {
    const res = await worker.fetch(
      makeRequest({
        name: 'mode_picked',
        props: { mode: 'bug' },
        extVersion: '1.0.0',
        ts: 1700000000000,
      }),
      stubEnv(),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('writes to Analytics Engine when the binding is bound', async () => {
    const writeDataPoint = vi.fn();
    await worker.fetch(
      makeRequest({
        name: 'submit_succeeded',
        props: { mode: 'bug', durationMs: 4200 },
        sessionIdHash: 'abcdef1234567890',
        accountIdHash: 'fedcba0987654321',
        extVersion: '1.0.0',
      }),
      stubEnv({ BUGZAR_ANALYTICS: { writeDataPoint } }),
    );
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point.indexes).toEqual(['submit_succeeded']);
    expect(point.blobs[0]).toBe('bug'); // mode
    expect(point.blobs[3]).toBe('1.0.0'); // extVersion
    expect(point.blobs[4]).toBe('abcdef1234567890'); // sessionIdHash
    expect(point.doubles[1]).toBe(4200); // durationMs
  });

  it('rejects unknown event names', async () => {
    const res = await worker.fetch(
      makeRequest({ name: 'totally_made_up', extVersion: '1.0.0' }),
      stubEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON body', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/telemetry/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
      stubEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('strips overlong / unsupported props but keeps the event', async () => {
    const writeDataPoint = vi.fn();
    const longString = 'x'.repeat(500);
    await worker.fetch(
      makeRequest({
        name: 'mode_picked',
        props: {
          mode: 'bug',
          rogueLong: longString,
          // biome-ignore lint/suspicious/noExplicitAny: testing rejection
          rogueObject: { foo: 'bar' } as any,
        },
        extVersion: '1.0.0',
      }),
      stubEnv({ BUGZAR_ANALYTICS: { writeDataPoint } }),
    );
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point.blobs[0]).toBe('bug'); // mode kept
    // The rogue long string + object never appear in the blobs.
    expect(point.blobs.some((b: string) => b === longString)).toBe(false);
  });

  it('rejects sessionIdHash values that are not short hex', async () => {
    const writeDataPoint = vi.fn();
    await worker.fetch(
      makeRequest({
        name: 'mode_picked',
        props: { mode: 'bug' },
        sessionIdHash: 'totally not a hash with spaces',
        extVersion: '1.0.0',
      }),
      stubEnv({ BUGZAR_ANALYTICS: { writeDataPoint } }),
    );
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const point = writeDataPoint.mock.calls[0]?.[0];
    // The bad hash is dropped (becomes empty string), event still accepted.
    expect(point.blobs[4]).toBe('');
  });

  it('logs to console when the Analytics Engine binding is absent', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.fetch(
      makeRequest({
        name: 'oauth_succeeded',
        extVersion: '1.0.0',
      }),
      stubEnv(),
    );
    expect(logSpy).toHaveBeenCalled();
    const firstArg = logSpy.mock.calls[0]?.[0];
    expect(firstArg).toBe('[telemetry]');
    logSpy.mockRestore();
  });

  it('PR-13: accepts ai_fallback and surfaces reason in blob3', async () => {
    const writeDataPoint = vi.fn();
    const res = await worker.fetch(
      makeRequest({
        name: 'ai_fallback',
        props: { reason: 'timeout' },
        extVersion: '1.0.0',
      }),
      stubEnv({ BUGZAR_ANALYTICS: { writeDataPoint } }),
    );
    expect(res.status).toBe(202);
    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point.indexes).toEqual(['ai_fallback']);
    expect(point.blobs[2]).toBe('timeout'); // reason → errorType slot
  });

  it('PR-13: accepts recording_started with mode prop', async () => {
    const writeDataPoint = vi.fn();
    await worker.fetch(
      makeRequest({
        name: 'recording_started',
        props: { mode: 'design' },
        extVersion: '1.0.0',
      }),
      stubEnv({ BUGZAR_ANALYTICS: { writeDataPoint } }),
    );
    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point.indexes).toEqual(['recording_started']);
    expect(point.blobs[0]).toBe('design');
  });

  it('PR-13: accepts recording_completed with durationMs', async () => {
    const writeDataPoint = vi.fn();
    await worker.fetch(
      makeRequest({
        name: 'recording_completed',
        props: { durationMs: 125000 },
        extVersion: '1.0.0',
      }),
      stubEnv({ BUGZAR_ANALYTICS: { writeDataPoint } }),
    );
    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point.indexes).toEqual(['recording_completed']);
    expect(point.doubles[1]).toBe(125000);
  });
});

describe('POST /telemetry/ai-quality', () => {
  const buildReq = (body: unknown): Request =>
    new Request('https://example.com/telemetry/ai-quality', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('PR-19: marks 3+ steps with ≥10 char avg as pass', async () => {
    const res = await worker.fetch(
      buildReq({
        reproSteps: [
          '열 글자 이상 한국어 스텝',
          '두 번째 스텝도 충분히 길다',
          '세 번째 스텝 역시 마찬가지',
        ],
      }),
      stubEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { qualityPass: boolean; count: number };
    expect(body.qualityPass).toBe(true);
    expect(body.count).toBe(3);
  });

  it('PR-19: fewer than 3 steps fails', async () => {
    const res = await worker.fetch(
      buildReq({ reproSteps: ['한 줄짜리 스텝일 뿐'], mode: 'bug' }),
      stubEnv(),
    );
    const body = (await res.json()) as { qualityPass: boolean };
    expect(body.qualityPass).toBe(false);
  });

  it('PR-19: short steps fail even when count ≥ 3', async () => {
    const res = await worker.fetch(buildReq({ reproSteps: ['a', 'b', 'c'] }), stubEnv());
    const body = (await res.json()) as { qualityPass: boolean; avgLen: number };
    expect(body.qualityPass).toBe(false);
    expect(body.avgLen).toBe(1);
  });

  it('PR-19: emits ai_quality_check data point when TELEMETRY is bound', async () => {
    const writeDataPoint = vi.fn();
    await worker.fetch(
      buildReq({
        reproSteps: [
          '열 글자 이상 한국어 스텝',
          '두 번째 스텝도 충분히 길다',
          '세 번째 스텝 역시 마찬가지',
        ],
        mode: 'design',
      }),
      stubEnv({ BUGZAR_ANALYTICS: { writeDataPoint } }),
    );
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point.indexes).toEqual(['ai_quality_check']);
    expect(point.blobs[0]).toBe('design');
    expect(point.blobs[1]).toBe('pass');
  });

  it('PR-19: rejects non-JSON body with 400', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/telemetry/ai-quality', {
        method: 'POST',
        body: 'not json',
      }),
      stubEnv(),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /telemetry/summary', () => {
  it('reports console mode when AE binding is absent', async () => {
    const res = await worker.fetch(new Request('https://example.com/telemetry/summary'), stubEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { telemetryMode: string; events: string[] };
    expect(body.telemetryMode).toBe('console');
    expect(body.events).toContain('ai_fallback');
    expect(body.events).toContain('recording_started');
    expect(body.events).toContain('recording_completed');
  });

  it('reports analytics-engine mode when binding is bound', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/telemetry/summary'),
      stubEnv({ BUGZAR_ANALYTICS: { writeDataPoint: () => {} } }),
    );
    const body = (await res.json()) as { telemetryMode: string };
    expect(body.telemetryMode).toBe('analytics-engine');
  });
});
