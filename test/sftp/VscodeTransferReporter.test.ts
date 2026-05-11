import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { VscodeTransferReporter } from '../../src/sftp/VscodeTransferReporter';

describe('VscodeTransferReporter', () => {
  it('keeps transfer progress notifications capped while the transfer continues', async () => {
    try {
      vi.useFakeTimers();
      const reports: unknown[] = [];
      const withProgress = vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) =>
        task(
          {
            report: (event) => reports.push(event)
          },
          {} as never
        ) as never
      );
      const reporter = new VscodeTransferReporter(3000);

      const result = await reporter.withProgress('Upload /etc/nginx/ng.sh', async (progress) => {
        progress.report({ transferredBytes: 1536, totalBytes: 1536 });
        return 'saved';
      });

      expect(result).toBe('saved');
      expect(withProgress).toHaveBeenCalledWith(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Upload /etc/nginx/ng.sh',
          cancellable: false
        },
        expect.any(Function)
      );
      expect(reports).toEqual([
        {
          increment: 100,
          message: '1.5 KB / 1.5 KB'
        }
      ]);

      await vi.advanceTimersByTimeAsync(3000);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('shows completion notices as timed progress notifications', async () => {
    try {
      vi.useFakeTimers();
      const withProgress = vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) =>
        task({ report: vi.fn() }, {} as never) as never
      );
      const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
      const reporter = new VscodeTransferReporter(3000);

      const done = reporter.notifySuccess('Upload /etc/nginx/ng.sh completed.');
      await vi.advanceTimersByTimeAsync(3000);
      await done;

      expect(showInformationMessage).not.toHaveBeenCalled();
      expect(withProgress).toHaveBeenCalledWith(
        {
          location: vscode.ProgressLocation.Notification,
          title: '$(info) Upload /etc/nginx/ng.sh completed.',
          cancellable: false
        },
        expect.any(Function)
      );
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
