import { describe, expect, it } from 'vitest';
import { TransferService } from '../../src/sftp/TransferService';

describe('TransferService', () => {
  it('serializes transfer jobs', async () => {
    const order: string[] = [];
    const service = new TransferService();

    await Promise.all([
      service.run('first', async () => {
        order.push('first');
      }),
      service.run('second', async () => {
        order.push('second');
      })
    ]);

    expect(order).toEqual(['first', 'second']);
  });

  it('rejects disconnected operations with a readable error', async () => {
    const service = new TransferService();

    await expect(service.requireConnected(false)).rejects.toThrow('No connected SSH terminal is active.');
  });
});
