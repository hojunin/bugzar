import { describe, expect, it } from 'vitest';
import { epicProjectPrefix, normalizeEpicQuery } from '../ReviewDrawer/epic-input';

describe('epicProjectPrefix', () => {
  it('pulls the project key out of an issue key (uppercased)', () => {
    expect(epicProjectPrefix('CBPFE-3991')).toBe('CBPFE');
    expect(epicProjectPrefix('bugzar-12')).toBe('BUGZAR');
  });

  it('returns undefined for non-key input', () => {
    expect(epicProjectPrefix(undefined)).toBeUndefined();
    expect(epicProjectPrefix('')).toBeUndefined();
    expect(epicProjectPrefix('3991')).toBeUndefined();
    expect(epicProjectPrefix('Checkout epic')).toBeUndefined();
  });
});

describe('normalizeEpicQuery', () => {
  it('extracts the key from a pasted Jira browse URL', () => {
    expect(normalizeEpicQuery('https://jira.team.musinsa.com/browse/CBPFE-3991')).toBe(
      'CBPFE-3991',
    );
    // query string / hash after the key is ignored
    expect(normalizeEpicQuery('https://jira.example.com/browse/CBPFE-3991?focusedId=9#c')).toBe(
      'CBPFE-3991',
    );
    // case-normalized to the canonical key
    expect(normalizeEpicQuery('http://jira/browse/cbpfe-3991')).toBe('CBPFE-3991');
  });

  it('qualifies a bare issue number with the known project prefix', () => {
    expect(normalizeEpicQuery('3991', 'CBPFE')).toBe('CBPFE-3991');
    expect(normalizeEpicQuery('  3991  ', 'CBPFE')).toBe('CBPFE-3991');
  });

  it('leaves a bare number untouched when no project prefix is known', () => {
    expect(normalizeEpicQuery('3991')).toBe('3991');
  });

  it('passes through an already-shaped key and partial titles unchanged (trimmed)', () => {
    expect(normalizeEpicQuery('CBPFE-3991', 'CBPFE')).toBe('CBPFE-3991');
    expect(normalizeEpicQuery('  checkout  ', 'CBPFE')).toBe('checkout');
  });
});
