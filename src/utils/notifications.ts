import * as vscode from 'vscode';

export type TimedNotificationKind = 'info' | 'warning' | 'error';

export const TIMED_NOTIFICATION_MS = 3000;
export const FAILED_NOTIFICATION_MS = 8000;

/**
 * Shows a toast that dismisses itself. VS Code has no timeout on notifications, so the
 * duration is expressed by keeping a progress task alive - but that task belongs to the
 * notification, not to the caller. Returns as soon as the toast is posted.
 */
export function showTimedNotification(
  message: string,
  kind: TimedNotificationKind = 'info',
  durationMs = TIMED_NOTIFICATION_MS
): void {
  const icon = kind === 'error' ? '$(error)' : kind === 'warning' ? '$(warning)' : '$(info)';
  try {
    void vscode.window
      .withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${icon} ${message}`,
          cancellable: false
        },
        async () => {
          await delay(durationMs);
        }
      )
      .then(undefined, () => undefined);
  } catch {
    // The notification host can already be gone during shutdown, and a toast is never worth
    // failing the operation that asked for it.
  }
}

export function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
