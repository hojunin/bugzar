import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LoadError, Loading, NeedParams, VersionMismatch } from '../ui/states';

afterEach(cleanup);

describe('view states', () => {
  it('NeedParams explains the endpoint/id params', () => {
    render(<NeedParams />);
    expect(screen.getByText(/endpoint/i)).toBeTruthy();
  });
  it('Loading shows a loading indicator', () => {
    render(<Loading />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });
  it('LoadError shows the attempted URL', () => {
    render(<LoadError url="https://w.dev/reports/x" />);
    expect(screen.getByText(/w\.dev\/reports\/x/)).toBeTruthy();
  });
  it('VersionMismatch surfaces the incompatibility', () => {
    render(<VersionMismatch reported={2} supported={1} />);
    expect(screen.getByText(/version/i)).toBeTruthy();
  });
});
