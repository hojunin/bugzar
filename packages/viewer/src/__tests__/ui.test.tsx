import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../panels/tabs';
import { Tabs } from '../ui/Tabs';

afterEach(cleanup);

describe('Tabs', () => {
  const tabs: Tab[] = [
    { key: 'console', label: 'Console', count: 2 },
    { key: 'network', label: 'Network', count: 1 },
  ];
  it('renders labels + counts and fires onSelect', () => {
    const onSelect = vi.fn();
    render(<Tabs tabs={tabs} active="console" onSelect={onSelect} />);
    expect(screen.getByText('Console')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.click(screen.getByText('Network'));
    expect(onSelect).toHaveBeenCalledWith('network');
  });
});
