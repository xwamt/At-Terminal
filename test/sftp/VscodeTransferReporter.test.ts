import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { VscodeTransferReporter } from '../../src/sftp/VscodeTransferReporter';

describe('VscodeTransferReporter', () => {
  it('keeps the progress notification open until the transfer job finishes', async () => {
    try {
      let resolveJob!: (value: string) => void;
      const jobDone = new Promise<string>((resolve) => {
        resolveJob = resolve;
      });
      let progressTaskFinished = false;
      const reports: unknown[] = [];
      vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) => {
        const result = await task(
          {
            report: (event) => reports.push(event)
          },
          {} as never
        );
        progressTaskFinished = true;
        return result as never;
      });
      const reporter = new VscodeTransferReporter();

      const pending = reporter.withProgress('Upload /etc/nginx/ng.sh', async (progress) => {
        progress.report({ transferredBytes: 512, totalBytes: 1024 });
        return await jobDone;
      });

      await Promise.resolve();
      expect(progressTaskFinished).toBe(false);
      expect(reports).toEqual([
        {
          increment: 50,
          message: '512 B / 1 KB'
        }
      ]);

      resolveJob('saved');
      await expect(pending).resolves.toBe('saved');
      expect(progressTaskFinished).toBe(true);
      expect(vscode.window.withProgress).toHaveBeenCalledWith(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Upload /etc/nginx/ng.sh',
          cancellable: false
        },
        expect.any(Function)
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('shows success notices for 3 seconds and failure notices for 8 seconds', async () => {
    try {
      vi.useFakeTimers();
      const withProgress = vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) =>
        task({ report: vi.fn() }, {} as never) as never
      );
      const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
      const reporter = new VscodeTransferReporter();

      const success = reporter.notifySuccess('Upload /etc/nginx/ng.sh completed.');
      await vi.advanceTimersByTimeAsync(2999);
      let successSettled = false;
      void success.then(() => {
        successSettled = true;
      });
      await Promise.resolve();
      expect(successSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await success;
      expect(successSettled).toBe(true);

      const failure = reporter.notifyFailure('Upload /etc/nginx/ng.sh failed.');
      let failureSettled = false;
      void failure.then(() => {
        failureSettled = true;
      });
      await vi.advanceTimersByTimeAsync(7999);
      await Promise.resolve();
      expect(failureSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await failure;
      expect(failureSettled).toBe(true);

      expect(showInformationMessage).not.toHaveBeenCalled();
      expect(withProgress).toHaveBeenCalledWith(
        {
          location: vscode.ProgressLocation.Notification,
          title: '$(info) Upload /etc/nginx/ng.sh completed.',
          cancellable: false
        },
        expect.any(Function)
      );
      expect(withProgress).toHaveBeenCalledWith(
        {
          location: vscode.ProgressLocation.Notification,
          title: '$(error) Upload /etc/nginx/ng.sh failed.',
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
