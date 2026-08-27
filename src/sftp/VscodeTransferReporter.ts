import * as vscode from 'vscode';
import { formatFileSize } from './FileSize';
import type { TransferProgress, TransferReporter } from './TransferService';
import {
  FAILED_NOTIFICATION_MS,
  showTimedNotification,
  TIMED_NOTIFICATION_MS
} from '../utils/notifications';

/**
 * SFTP step callbacks fire per 32KiB chunk, which floods the notification renderer on fast
 * links. Reports pass through only when the integer percent moved or this much time elapsed.
 */
export const PROGRESS_REPORT_MIN_INTERVAL_MS = 100;

export class VscodeTransferReporter implements TransferReporter {
  constructor(
    private readonly successDurationMs = TIMED_NOTIFICATION_MS,
    private readonly failureDurationMs = FAILED_NOTIFICATION_MS
  ) {}

  async withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T> {
    let lastPercent = 0;
    let hasReported = false;
    let lastReportAtMs = 0;
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
            const now = Date.now();
            if (
              hasReported &&
              percent === lastPercent &&
              now - lastReportAtMs < PROGRESS_REPORT_MIN_INTERVAL_MS
            ) {
              return;
            }
            progress.report({
              increment: Math.max(0, percent - lastPercent),
              message:
                totalBytes > 0
                  ? `${formatFileSize(transferredBytes)} / ${formatFileSize(totalBytes)}`
                  : formatFileSize(transferredBytes)
            });
            lastPercent = percent;
            hasReported = true;
            lastReportAtMs = now;
          }
        });
      }
    );
  }

  async notifySuccess(message: string): Promise<void> {
    showTimedNotification(message, 'info', this.successDurationMs);
  }

  async notifyFailure(message: string): Promise<void> {
    showTimedNotification(message, 'error', this.failureDurationMs);
  }
}
