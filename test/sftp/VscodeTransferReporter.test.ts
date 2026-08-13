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

  it('posts a 3s success toast and an 8s failure toast without holding the transfer', async () => {
    try {
      vi.useFakeTimers();
      const dismissed: string[] = [];
      const withProgress = vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (options, task) => {
        await task({ report: vi.fn() }, {} as never);
        dismissed.push((options as { title: string }).title);
        return undefined as never;
      });
      const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
      const reporter = new VscodeTransferReporter();
      let resumed = 0;

      void reporter.notifySuccess('Upload /etc/nginx/ng.sh completed.').then(() => {
        resumed += 1;
      });
      void reporter.notifyFailure('Upload /etc/nginx/ng.sh failed.').then(() => {
        resumed += 1;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(resumed).toBe(2);
      expect(dismissed).toEqual([]);

      await vi.advanceTimersByTimeAsync(3000);
      expect(dismissed).toEqual(['$(info) Upload /etc/nginx/ng.sh completed.']);
      await vi.advanceTimersByTimeAsync(5000);
      expect(dismissed).toEqual([
        '$(info) Upload /etc/nginx/ng.sh completed.',
        '$(error) Upload /etc/nginx/ng.sh failed.'
      ]);

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
