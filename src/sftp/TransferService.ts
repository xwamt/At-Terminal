export type TransferJob<T> = () => Promise<T>;

export class TransferService {
  private queue = Promise.resolve();

  async requireConnected(connected: boolean): Promise<void> {
    if (!connected) {
      throw new Error('No connected SSH terminal is active.');
    }
  }

  run<T>(_label: string, job: TransferJob<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
