import { describe, expect, it } from 'vitest';
import { TransferService, type TransferReporter } from '../../src/sftp/TransferService';

describe('TransferService', () => {
  it('starts transfer jobs concurrently', async () => {
    const order: string[] = [];
    const service = new TransferService();
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;

    const transfers = Promise.all([
      service.run('first', async () => {
        order.push('first');
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }),
      service.run('second', async () => {
        order.push('second');
        await new Promise<void>((resolve) => {
          finishSecond = resolve;
        });
      })
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['first', 'second']);
    finishFirst?.();
    finishSecond?.();
    await transfers;
  });

  it('rejects disconnected operations with a readable error', async () => {
    const service = new TransferService();

    await expect(service.requireConnected(false)).rejects.toThrow('No connected SSH terminal is active.');
  });

  it('runs transfer jobs inside a progress reporter and notifies completion', async () => {
    const progressEvents: Array<{ transferredBytes: number; totalBytes: number }> = [];
    const messages: string[] = [];
    const labels: string[] = [];
    const reporter: TransferReporter = {
      withProgress: async (label, task) => {
        labels.push(label);
        return task({
          report: (event) => progressEvents.push(event)
        });
      },
      notifySuccess: async (message) => {
        messages.push(message);
      }
    };
    const service = new TransferService(reporter);

    const result = await service.run('Upload docker-compose.yml', async (progress) => {
      progress.report({ transferredBytes: 512, totalBytes: 1024 });
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(labels).toEqual(['Upload docker-compose.yml']);
    expect(progressEvents).toEqual([{ transferredBytes: 512, totalBytes: 1024 }]);
    expect(messages).toEqual(['Upload docker-compose.yml completed.']);
  });

  it('does not wait for completion notifications to resolve before finishing a transfer', async () => {
    const reporter: TransferReporter = {
      withProgress: async (_label, task) => task({ report: () => undefined }),
      notifySuccess: async () => new Promise<void>(() => undefined)
    };
    const service = new TransferService(reporter);

    const result = await Promise.race([
      service.run('Upload docker-compose.yml', async () => 'finished'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 20))
    ]);

    expect(result).toBe('finished');
  });
});
