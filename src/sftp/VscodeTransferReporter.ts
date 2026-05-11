import * as vscode from 'vscode';
import { formatFileSize } from './FileSize';
import type { TransferProgress, TransferReporter } from './TransferService';
import { delay, showTimedNotification, TIMED_NOTIFICATION_MS } from '../utils/notifications';

export class VscodeTransferReporter implements TransferReporter {
  constructor(private readonly notificationDurationMs = TIMED_NOTIFICATION_MS) {}

  async withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T> {
    let lastPercent = 0;
    let active = true;
    let resolveProgress!: (progress: TransferProgress) => void;
    const progressReady = new Promise<TransferProgress>((resolve) => {
      resolveProgress = resolve;
    });
    const notification = vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: label,
        cancellable: false
      },
      async (progress) => {
        resolveProgress({
          report: ({ transferredBytes, totalBytes }) => {
            if (!active) {
              return;
            }
            const percent = totalBytes > 0 ? Math.min(100, Math.floor((transferredBytes / totalBytes) * 100)) : 0;
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
        await delay(this.notificationDurationMs);
        active = false;
      }
    );
    void Promise.resolve(notification).catch(() => undefined);
    return await job(await progressReady);
  }

  async notifySuccess(message: string): Promise<void> {
    await showTimedNotification(message, 'info', this.notificationDurationMs);
  }
}
