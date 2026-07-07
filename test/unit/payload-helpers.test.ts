import { describe, it, expect } from 'vitest';
import { isHttp400, describeApiError } from '../../src/core/payload-helpers';
import { APIError } from '../../src/api/client';

describe('isHttp400', () => {
  it('detects APIError statusCode 400', () => {
    expect(isHttp400(new APIError('bad', 400))).toBe(true);
  });
  it('detects axios-shaped response.status 400', () => {
    expect(isHttp400({ response: { status: 400 } })).toBe(true);
  });
  it('is false for non-400 / non-error', () => {
    expect(isHttp400(new APIError('nope', 500))).toBe(false);
    expect(isHttp400({ response: { status: 404 } })).toBe(false);
    expect(isHttp400(null)).toBe(false);
    expect(isHttp400('x')).toBe(false);
  });
});

describe('describeApiError', () => {
  it('surfaces the API message from an APIError', () => {
    const err = new APIError('No valid parameters to update the assignment', 400);
    expect(describeApiError(err)).toContain('No valid parameters to update the assignment');
  });

  it('appends the raw response body when it adds detail beyond the message', () => {
    const err = new APIError('Bad Request', 400, { error: { field: 'labtype', reason: 'not writable' } });
    const out = describeApiError(err);
    expect(out).toContain('Bad Request');
    expect(out).toContain('labtype');
    expect(out).toContain('not writable');
  });

  it('does not duplicate the body when the message already contains it', () => {
    const err = new APIError('boom', 400, 'boom');
    // message and stringified body are the same → not repeated
    expect(describeApiError(err)).toBe('boom');
  });

  it('does not echo a { error: { message } } wrapper of the same message (P2)', () => {
    // The common Vocareum shape: wrapError already extracted the nested message.
    const err = new APIError('No valid parameters to update', 400, {
      error: { message: 'No valid parameters to update' },
    });
    expect(describeApiError(err)).toBe('No valid parameters to update');
  });

  it('does not echo a { message } wrapper of the same message', () => {
    const err = new APIError('No valid parameters', 400, { message: 'No valid parameters' });
    expect(describeApiError(err)).toBe('No valid parameters');
  });

  it('still appends the body when the wrapper carries extra fields', () => {
    const err = new APIError('Bad Request', 400, {
      error: { message: 'Bad Request', field: 'labtype' },
    });
    const out = describeApiError(err);
    expect(out).toContain('Bad Request');
    expect(out).toContain('labtype'); // extra field is informative → kept
  });

  it('reads an axios-shaped error (response.data)', () => {
    const out = describeApiError({ message: 'Request failed', response: { data: { message: 'container_image invalid' } } });
    expect(out).toContain('Request failed');
    expect(out).toContain('container_image invalid');
  });

  it('flattens whitespace and truncates long detail', () => {
    const long = 'x'.repeat(500);
    const out = describeApiError(new APIError('line1\n\n   line2', 400, long));
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles empty/absent detail gracefully', () => {
    expect(describeApiError(new APIError('', 400, {}))).toBe('no error detail');
    expect(describeApiError(null)).toBe('null');
  });
});
