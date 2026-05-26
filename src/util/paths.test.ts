import { describe, it, expect } from 'vitest';
import { safeSegment, getPidFile, getActiveAccountsFile } from './paths.js';

describe('safeSegment', () => {
  it('should return encoded segment for normal string', () => {
    expect(safeSegment('hello world')).toBe('hello%20world');
  });

  it('should return underscore for empty string', () => {
    expect(safeSegment('')).toBe('_');
  });
});

describe('getPidFile', () => {
  it('should return path ending with bridge.pid', () => {
    expect(getPidFile()).toMatch(/bridge\.pid$/);
  });
});

describe('getActiveAccountsFile', () => {
  it('should return path ending with active_accounts.json', () => {
    expect(getActiveAccountsFile()).toMatch(/active_accounts\.json$/);
  });
});
