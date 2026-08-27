import { describe, expect, it, vi } from 'vitest';
import { AGENT_AUDIT_FILE_NAME, AgentAuditLog } from '../../src/agent/AgentAuditLog';

function fakeFs() {
  const appended: Array<{ path: string; data: string }> = [];
  const mkdirs: string[] = [];
  return {
    appended,
    mkdirs,
    fs: {
      mkdir: vi.fn(async (path: string) => {
        mkdirs.push(path);
        return undefined;
      }),
      appendFile: vi.fn(async (path: string, data: string) => {
        appended.push({ path, data });
      })
    }
  };
}

function fakeChannel() {
  const lines: string[] = [];
  const dispose = vi.fn();
  return { lines, dispose, channel: { appendLine: (line: string) => lines.push(line), dispose } };
}

describe('AgentAuditLog', () => {
  it('writes one JSONL line per tool call to the channel and the storage file', async () => {
    const { appended, mkdirs, fs } = fakeFs();
    const { lines, channel } = fakeChannel();
    const log = new AgentAuditLog({
      storageDir: '/globalStorage',
      channel,
      now: () => Date.UTC(2026, 7, 27, 12, 0, 0),
      fs
    });

    log.record({
      serverId: 'server-1',
      terminalId: 'terminal-1',
      tool: 'run_remote_command',
      command: 'systemctl status nginx',
      reasonCode: 'auto_approved',
      exitCode: 0,
      durationMs: 42,
      truncated: false
    });
    await log.flush();

    expect(lines).toHaveLength(1);
    expect(appended).toHaveLength(1);
    expect(appended[0].path.replaceAll('\\', '/')).toBe(`/globalStorage/${AGENT_AUDIT_FILE_NAME}`);
    expect(mkdirs[0].replaceAll('\\', '/')).toBe('/globalStorage');
    expect(appended[0].data.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0])).toEqual({
      time: '2026-08-27T12:00:00.000Z',
      serverId: 'server-1',
      terminalId: 'terminal-1',
      tool: 'run_remote_command',
      command: 'systemctl status nginx',
      reasonCode: 'auto_approved',
      exitCode: 0,
      durationMs: 42,
      truncated: false
    });
    expect(JSON.parse(appended[0].data)).toEqual(JSON.parse(lines[0]));
  });

  it('redacts sensitive command text before recording it anywhere', async () => {
    const { appended, fs } = fakeFs();
    const { lines, channel } = fakeChannel();
    const log = new AgentAuditLog({ storageDir: '/s', channel, now: () => 0, fs });

    log.record({
      serverId: 'server-1',
      tool: 'run_remote_command',
      command: 'mysql -u root password=hunter2',
      reasonCode: 'user_approved'
    });
    await log.flush();

    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).toContain('password=[REDACTED]');
    expect(appended[0].data).not.toContain('hunter2');
  });

  it('records path-based tools without a command field', async () => {
    const { fs } = fakeFs();
    const { lines, channel } = fakeChannel();
    const log = new AgentAuditLog({ storageDir: '/s', channel, now: () => 1_000, fs });

    log.record({
      serverId: 'server-1',
      tool: 'sftp_delete',
      path: '/srv/app/old.log',
      reasonCode: 'user_cancelled',
      durationMs: 5
    });
    await log.flush();

    const entry = JSON.parse(lines[0]);
    expect(entry.path).toBe('/srv/app/old.log');
    expect(entry.command).toBeUndefined();
    expect(entry.time).toBe('1970-01-01T00:00:01.000Z');
  });

  it('serializes concurrent records in order', async () => {
    const { appended, fs } = fakeFs();
    const { channel } = fakeChannel();
    const log = new AgentAuditLog({ storageDir: '/s', channel, now: () => 0, fs });

    log.record({ tool: 'a', reasonCode: 'ok' });
    log.record({ tool: 'b', reasonCode: 'ok' });
    log.record({ tool: 'c', reasonCode: 'ok' });
    await log.flush();

    expect(appended.map((entry) => JSON.parse(entry.data).tool)).toEqual(['a', 'b', 'c']);
  });

  it('never fails the tool call when the file write fails', async () => {
    const { channel, lines } = fakeChannel();
    const log = new AgentAuditLog({
      storageDir: '/s',
      channel,
      now: () => 0,
      fs: {
        mkdir: vi.fn(async () => {
          throw new Error('disk full');
        }),
        appendFile: vi.fn(async () => {
          throw new Error('disk full');
        })
      }
    });

    expect(() => log.record({ tool: 'run_remote_command', reasonCode: 'ok' })).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
    // The channel line still lands even when the file is unwritable.
    expect(lines).toHaveLength(1);

    // The log keeps accepting entries after a failure.
    log.record({ tool: 'sftp_read_file', reasonCode: 'ok' });
    await expect(log.flush()).resolves.toBeUndefined();
    expect(lines).toHaveLength(2);
  });

  it('dispose forwards to the channel', () => {
    const { channel, dispose } = fakeChannel();
    const log = new AgentAuditLog({ storageDir: '/s', channel, now: () => 0, fs: fakeFs().fs });

    log.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
