export interface TransferProgress {
  report(event: { transferredBytes: number; totalBytes: number }): void;
}

export type TransferJob<T> = (progress: TransferProgress) => Promise<T>;

export interface TransferReporter {
  withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T>;
  notifySuccess(message: string): Promise<void>;
  notifyFailure(message: string): Promise<void>;
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
    try {
      const result = this.reporter
        ? await this.reporter.withProgress(label, job)
        : await job(noopProgress);
      void this.reporter?.notifySuccess(`${label} completed.`);
      return result;
    } catch (error) {
      void this.reporter?.notifyFailure(`${label} failed.`);
      throw error;
    }
  }
}
