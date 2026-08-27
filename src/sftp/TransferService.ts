import { isSftpConflictError } from './SftpErrors';

export interface TransferProgress {
  report(event: { transferredBytes: number; totalBytes: number }): void;
}

export type TransferJob<T> = (progress: TransferProgress) => Promise<T>;

export interface TransferReporter {
  withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T>;
  notifySuccess(message: string): Promise<void>;
  notifyFailure(message: string): Promise<void>;
}

export interface TransferRunOptions {
  /**
   * `quiet` is for tiny metadata operations (mkdir/rename/delete/create): no progress
   * notification and no success toast -- the tree refresh already shows the result.
   * Failures still notify. Real byte transfers stay `full`.
   */
  notification?: 'full' | 'quiet';
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

  run<T>(label: string, job: TransferJob<T>, options?: TransferRunOptions): Promise<T> {
    return this.runWithReporter(label, job, options?.notification ?? 'full');
  }

  private async runWithReporter<T>(label: string, job: TransferJob<T>, notification: 'full' | 'quiet'): Promise<T> {
    try {
      const result =
        this.reporter && notification === 'full'
          ? await this.reporter.withProgress(label, job)
          : await job(noopProgress);
      if (notification === 'full') {
        void this.reporter?.notifySuccess(`${label} completed.`);
      }
      return result;
    } catch (error) {
      // A conflict is not a failure: the caller maps it to an overwrite/skip prompt, so a
      // "failed" toast right before that dialog would only mislead.
      if (!isSftpConflictError(error)) {
        void this.reporter?.notifyFailure(`${label} failed.`);
      }
      throw error;
    }
  }
}
