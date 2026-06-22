// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostMessageEmitter, createPostMessageReceiver } from './postmessage-bridge';

afterEach(() => {
  vi.useRealTimers();
});

describe('postMessage bridge', () => {
  it('emitter posts a namespaced envelope, receiver unwraps it', () => {
    const received: unknown[] = [];
    const stop = createPostMessageReceiver<{ type: 'ECHO'; payload: number }>(window, (msg) =>
      received.push(msg),
    );
    const emit = createPostMessageEmitter<{ type: 'ECHO'; payload: number }>(window);
    emit({ type: 'ECHO', payload: 42 });
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(received).toEqual([{ type: 'ECHO', payload: 42 }]);
        stop();
        resolve();
      }, 10),
    );
  });

  it('ignores messages without the bugzar namespace', () => {
    const received: unknown[] = [];
    const stop = createPostMessageReceiver(window, (msg) => received.push(msg));
    window.postMessage({ type: 'OTHER', payload: 'noise' }, '*');
    // wait a microtask
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(received).toEqual([]);
        stop();
        resolve();
      }, 10),
    );
  });

  it('receiver stop() removes the listener', () => {
    const received: unknown[] = [];
    const stop = createPostMessageReceiver(window, (msg) => received.push(msg));
    stop();
    const emit = createPostMessageEmitter(window);
    emit({ type: 'X', payload: 1 });
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(received).toEqual([]);
        resolve();
      }, 10),
    );
  });
});
