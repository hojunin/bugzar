import { describe, expect, it } from 'vitest';
import { checkSchemaVersion, SCHEMA_VERSION } from '../report/schema-version';

describe('checkSchemaVersion', () => {
  it('matches the current version → ok', () => {
    expect(checkSchemaVersion(SCHEMA_VERSION)).toBe('ok');
  });
  it('undefined (pre-versioning report) → unknown', () => {
    expect(checkSchemaVersion(undefined)).toBe('unknown');
  });
  it('a lower version → older', () => {
    expect(checkSchemaVersion(SCHEMA_VERSION - 1)).toBe('older');
  });
  it('a higher version → newer', () => {
    expect(checkSchemaVersion(SCHEMA_VERSION + 1)).toBe('newer');
  });
});
