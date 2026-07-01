import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PublishedView } from '../ReviewDrawer/PublishedView';
import { UploadedLink } from '../ReviewDrawer/UploadedLink';

afterEach(cleanup);

// #52 — the components that turn an outside URL into an <a href> must drop a
// non-http(s) value instead of rendering a clickable javascript:/data: link.
describe('URL sink guards (#52)', () => {
  it('UploadedLink renders an anchor for https but nothing for javascript:', () => {
    const { container: ok } = render(<UploadedLink url="https://x.test/r/1" mode="bug" />);
    expect(ok.querySelector('a')?.getAttribute('href')).toBe('https://x.test/r/1');

    const { container: bad } = render(<UploadedLink url="javascript:alert(1)" mode="bug" />);
    expect(bad.querySelector('a')).toBeNull();
  });

  it('PublishedView links a safe issueUrl but falls back to a plain key for javascript:', () => {
    const { container: ok } = render(
      <PublishedView
        published={{ issueKey: 'BUG-1', issueUrl: 'https://jira.test/BUG-1', stubbed: false }}
        onClose={() => {}}
      />,
    );
    expect(ok.querySelector('a')?.getAttribute('href')).toBe('https://jira.test/BUG-1');

    const { container: bad } = render(
      <PublishedView
        published={{ issueKey: 'BUG-2', issueUrl: 'javascript:alert(1)', stubbed: false }}
        onClose={() => {}}
      />,
    );
    expect(bad.querySelector('a')).toBeNull();
    expect(bad.textContent).toContain('BUG-2');
  });
});
