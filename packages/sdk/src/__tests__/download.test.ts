import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadReplay } from '../download';
import type { ExportMeta } from '../public-types';

const meta: ExportMeta = {
  url: 'https://app.example.com',
  userAgent: 'test',
  viewport: { width: 800, height: 600 },
  startedAt: 1717000000000,
  endedAt: 1717000005000,
  durationMs: 5000,
  mode: 'session',
};

afterEach(() => vi.restoreAllMocks());

describe('downloadReplay', () => {
  it('saves the blob via a synthetic anchor and revokes the object URL', async () => {
    const blob = new Blob(['<!doctype html>'], { type: 'text/html' });
    const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const revokeURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let downloaded: string | null = null;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });

    await downloadReplay(blob, meta);

    expect(createURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(downloaded).toBe('bugzar-session-1717000000000.html');
    // The revoke is deferred one tick (avoids racing large saves on old Safari).
    await new Promise((r) => setTimeout(r, 0));
    expect(revokeURL).toHaveBeenCalledWith('blob:mock'); // no leaked object URL
  });

  it('names the file by capture mode', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let name: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      name = this.download;
    });

    await downloadReplay(new Blob([]), { ...meta, mode: 'design' });

    expect(name).toBe('bugzar-design-1717000000000.html');
  });
});
