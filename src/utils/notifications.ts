import * as vscode from 'vscode';

export type TimedNotificationKind = 'info' | 'warning' | 'error';

export const TIMED_NOTIFICATION_MS = 3000;

export async function showTimedNotification(
  message: string,
  kind: TimedNotificationKind = 'info',
  durationMs = TIMED_NOTIFICATION_MS
): Promise<void> {
  const icon = kind === 'error' ? '$(error)' : kind === 'warning' ? '$(warning)' : '$(info)';
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${icon} ${message}`,
      cancellable: false
    },
    async () => {
      await delay(durationMs);
    }
  );
}

export function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
