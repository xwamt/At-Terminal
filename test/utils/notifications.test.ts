import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  FAILED_NOTIFICATION_MS,
  showTimedNotification,
  TIMED_NOTIFICATION_MS
} from '../../src/utils/notifications';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function captureProgressTask(): { settled: () => boolean } {
  let settled = false;
  vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) => {
    await task({ report: vi.fn() }, {} as never);
    settled = true;
    return undefined as never;
  });
  return { settled: () => settled };
}

describe('notifications', () => {
  it('uses 3s for success and 8s for failure toasts', () => {
    expect(TIMED_NOTIFICATION_MS).toBe(3000);
    expect(FAILED_NOTIFICATION_MS).toBe(8000);
  });

  it('returns control to the caller without waiting for the toast to disappear', async () => {
    vi.useFakeTimers();
    const progress = captureProgressTask();
    let callerResumed = false;

    void (async () => {
      await showTimedNotification('Remote sync failed', 'error', FAILED_NOTIFICATION_MS);
      callerResumed = true;
    })();
    await Promise.resolve();
    await Promise.resolve();

    expect(callerResumed).toBe(true);
    expect(progress.settled()).toBe(false);
    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      {
        location: vscode.ProgressLocation.Notification,
        title: '$(error) Remote sync failed',
        cancellable: false
      },
      expect.any(Function)
    );
  });

  it('keeps the notification on screen for the requested duration', async () => {
    vi.useFakeTimers();
    const progress = captureProgressTask();

    showTimedNotification('Upload completed', 'info', TIMED_NOTIFICATION_MS);

    await vi.advanceTimersByTimeAsync(TIMED_NOTIFICATION_MS - 1);
    expect(progress.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.settled()).toBe(true);
  });

  it('swallows a notification host that is already gone instead of failing the caller', async () => {
    vi.spyOn(vscode.window, 'withProgress').mockImplementation(() => {
      throw new Error('notification host is gone');
    });
    let callerResumed = false;

    expect(() => showTimedNotification('still fine')).not.toThrow();

    void (async () => {
      await showTimedNotification('still fine');
      callerResumed = true;
    })();
    await Promise.resolve();
    await Promise.resolve();

    expect(callerResumed).toBe(true);
  });

  it('picks an icon per notification kind', () => {
    captureProgressTask();

    showTimedNotification('plain');
    showTimedNotification('careful', 'warning');
    showTimedNotification('broken', 'error');

    const titles = vi
      .mocked(vscode.window.withProgress)
      .mock.calls.map(([options]) => (options as { title?: string }).title);
    expect(titles).toEqual(['$(info) plain', '$(warning) careful', '$(error) broken']);
  });
});
