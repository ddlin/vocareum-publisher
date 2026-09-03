import { describe, it, expect } from 'vitest';
import { uploadTimeoutForBytes, pollAttemptsForBytes } from '../../src/api/content';

const MB = 1024 * 1024;

describe('uploadTimeoutForBytes', () => {
  it('keeps the historical 60s floor for a small body', () => {
    expect(uploadTimeoutForBytes(1024)).toBe(60_000);
  });

  it('grows with size so a large body is not aborted mid-flight', () => {
    // The 60s floor is only generous for small bodies. The real case that
    // failed was ~144 MB (a 108 MB directory after zip+base64), which needs
    // 2.4 MB/s sustained to clear 60s before the server does any work at all.
    expect(uploadTimeoutForBytes(12 * MB)).toBeGreaterThan(100_000);
  });

  it('is capped so a pathological size cannot hang a run indefinitely', () => {
    expect(uploadTimeoutForBytes(10_000 * MB)).toBe(600_000);
  });
});

describe('pollAttemptsForBytes', () => {
  it('keeps the historical 30 attempts for a small body', () => {
    expect(pollAttemptsForBytes(1024)).toBe(30);
  });

  it('allows the server longer to unzip a large body', () => {
    expect(pollAttemptsForBytes(12 * MB)).toBeGreaterThan(30);
  });

  it('is capped', () => {
    expect(pollAttemptsForBytes(10_000 * MB)).toBe(300);
  });
});
