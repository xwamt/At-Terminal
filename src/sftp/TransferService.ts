export interface TransferProgress {
  report(event: { transferredBytes: number; totalBytes: number }): void;
}

export type TransferJob<T> = (progress: TransferProgress) => Promise<T>;

export interface TransferReporter {
  withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T>;
  notifySuccess(message: string): Promise<void>;
}

const noopProgress: TransferProgress = {
  report: () => undefined
};

export class TransferService {
  constructor(private readonly reporter?: TransferReporter) {}

  async requireConnected(connected: boolean): Promise<void> {
    if (!connected) {
      throw new Error('No connected SSH terminal is active.');
    }
  }

  run<T>(label: string, job: TransferJob<T>): Promise<T> {
    return this.runWithReporter(label, job);
  }

  private async runWithReporter<T>(label: string, job: TransferJob<T>): Promise<T> {
    const runner = this.reporter
      ? this.reporter.withProgress(label, job)
      : job(noopProgress);
    const result = await runner;
    void this.reporter?.notifySuccess(`${label} completed.`);
    return result;
  }
}
