/**
 * Assignment API Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitForAssignmentObjId } from '../../src/api/assignments';
import { VocareumClient } from '../../src/api/client';

describe('waitForAssignmentObjId', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = {
      request: requestMock,
    } as unknown as VocareumClient;
  });

  it('should return objid when transaction succeeds immediately', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'success',
      objid: '12345',
    });

    const result = await waitForAssignmentObjId(mockClient, 'txn-123');

    expect(result).toBe('12345');
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith({
      method: 'GET',
      url: '/api/v2/transaction/txn-123',
    });
  });

  it('should poll until transaction succeeds', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 'success', state: 'pending' })
      .mockResolvedValueOnce({ status: 'success', state: 'pending' })
      .mockResolvedValueOnce({ status: 'success', state: 'success', objid: '67890' });

    const result = await waitForAssignmentObjId(mockClient, 'txn-456', {
      delayMs: 10, // Speed up test
    });

    expect(result).toBe('67890');
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it('should throw when transaction fails', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'failed',
      message: 'Copy operation failed',
    });

    await expect(waitForAssignmentObjId(mockClient, 'txn-fail')).rejects.toThrow(
      'Copy operation failed'
    );
  });

  it('should use default error message when transaction fails without message', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'failed',
    });

    await expect(waitForAssignmentObjId(mockClient, 'txn-fail-no-msg')).rejects.toThrow(
      'Copy assignment transaction failed (txn=txn-fail-no-msg)'
    );
  });

  it('should timeout after max attempts', async () => {
    requestMock.mockResolvedValue({ status: 'success', state: 'pending' });

    await expect(
      waitForAssignmentObjId(mockClient, 'txn-timeout', {
        maxAttempts: 3,
        delayMs: 10,
      })
    ).rejects.toThrow('Timed out after 30ms waiting for assignment copy (txn=txn-timeout)');

    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it('should return undefined when success but no objid', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'success',
      // No objid
    });

    const result = await waitForAssignmentObjId(mockClient, 'txn-no-objid');

    expect(result).toBeUndefined();
  });

  it('should use custom polling options', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 'success', state: 'pending' })
      .mockResolvedValueOnce({ status: 'success', state: 'success', objid: 'custom' });

    const startTime = Date.now();
    const result = await waitForAssignmentObjId(mockClient, 'txn-custom', {
      maxAttempts: 5,
      delayMs: 50,
    });
    const elapsed = Date.now() - startTime;

    expect(result).toBe('custom');
    expect(elapsed).toBeGreaterThanOrEqual(45); // At least one delay
    expect(elapsed).toBeLessThan(200); // But not too long
  });
});
