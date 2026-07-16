import * as vscode from 'vscode';
import { formatFileSize } from './FileSize';
import type { TransferProgress, TransferReporter } from './TransferService';
import {
  FAILED_NOTIFICATION_MS,
  showTimedNotification,
  TIMED_NOTIFICATION_MS
} from '../utils/notifications';

export class VscodeTransferReporter implements TransferReporter {
  constructor(
    private readonly successDurationMs = TIMED_NOTIFICATION_MS,
    private readonly failureDurationMs = FAILED_NOTIFICATION_MS
  ) {}

  async withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T> {
    let lastPercent = 0;
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: label,
        cancellable: false
      },
      async (progress) => {
        return await job({
          report: ({ transferredBytes, totalBytes }) => {
            const percent =
              totalBytes > 0 ? Math.min(100, Math.floor((transferredBytes / totalBytes) * 100)) : 0;
            progress.report({
              increment: Math.max(0, percent - lastPercent),
              message:
                totalBytes > 0
                  ? `${formatFileSize(transferredBytes)} / ${formatFileSize(totalBytes)}`
                  : formatFileSize(transferredBytes)
            });
            lastPercent = percent;
          }
        });
      }
    );
  }

  async notifySuccess(message: string): Promise<void> {
    await showTimedNotification(message, 'info', this.successDurationMs);
  }

  async notifyFailure(message: string): Promise<void> {
    await showTimedNotification(message, 'error', this.failureDurationMs);
  }
}
