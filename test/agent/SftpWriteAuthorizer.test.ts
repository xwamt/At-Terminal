import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_GRANT_TTL_MS,
  SftpWriteAuthorizer,
  type SftpWriteConfirmation,
  type SftpWriteRequest,
  type SftpWriteScope
} from '../../src/agent/SftpWriteAuthorizer';
import type { ServerConfig } from '../../src/config/schema';

const WORKSPACE_ROOT = '/home/deploy/app';

function server(id = 'server-1'): ServerConfig {
  return {
    id,
    label: 'Production',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

function write(path: string, overrides: Partial<SftpWriteRequest> = {}): SftpWriteRequest {
  return {
    operation: 'write_file',
    path,
    overwrite: false,
    workspaceRoot: WORKSPACE_ROOT,
    ...overrides
  };
}

/** Records what the authorizer asked, and answers with a fixed queue of choices. */
function recordingConfirm(answers: Array<SftpWriteScope | undefined>) {
  const seen: SftpWriteConfirmation[] = [];
  const remaining = [...answers];
  return {
    seen,
    confirm: async (confirmation: SftpWriteConfirmation): Promise<SftpWriteScope | undefined> => {
      seen.push(confirmation);
      if (remaining.length === 0) {
        throw new Error(`Unexpected extra prompt for ${confirmation.request.path}`);
      }
      return remaining.shift();
    }
  };
}

function clock(start = 1_000): { now: () => number; advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    }
  };
}

describe('SftpWriteAuthorizer approval scope', () => {
  it('does not let an approval for one directory authorize a write elsewhere on the same server', async () => {
    const recorder = recordingConfirm(['session', 'once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/notes/a.txt`));
    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/config/b.txt`));

    expect(recorder.seen).toHaveLength(2);
    expect(recorder.seen.map((confirmation) => confirmation.parentDirectory)).toEqual([
      `${WORKSPACE_ROOT}/notes`,
      `${WORKSPACE_ROOT}/config`
    ]);
  });

  it('asks again for every write when the user picks "once"', async () => {
    const recorder = recordingConfirm(['once', 'once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/a.txt`));
    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/b.txt`));

    expect(recorder.seen).toHaveLength(2);
  });

  it('offers "once" first so the default answer grants the least', async () => {
    const recorder = recordingConfirm(['once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/a.txt`));

    expect(recorder.seen[0].allowedScopes[0]).toBe('once');
    expect(recorder.seen[0].allowedScopes).toEqual(['once', 'directory', 'session']);
  });

  it('reuses a directory grant for other files in the same directory', async () => {
    const recorder = recordingConfirm(['directory']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/logs/a.txt`));
    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/logs/b.txt`));
    await authorizer.requireWrite(
      server(),
      write(`${WORKSPACE_ROOT}/logs/c`, { operation: 'create_directory' })
    );

    expect(recorder.seen).toHaveLength(1);
  });

  it('does not extend a directory grant to a subdirectory', async () => {
    const recorder = recordingConfirm(['directory', 'once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/logs/a.txt`));
    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/logs/nested/b.txt`));

    expect(recorder.seen).toHaveLength(2);
  });

  it('expires a directory grant after 15 minutes', async () => {
    const recorder = recordingConfirm(['directory', 'once']);
    const time = clock();
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm, now: time.now });

    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/logs/a.txt`));
    time.advance(DIRECTORY_GRANT_TTL_MS - 1);
    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/logs/b.txt`));
    expect(recorder.seen).toHaveLength(1);

    time.advance(2);
    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/logs/c.txt`));
    expect(recorder.seen).toHaveLength(2);
  });

  it('keeps a session grant alive past the directory TTL', async () => {
    const recorder = recordingConfirm(['session']);
    const time = clock();
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm, now: time.now });

    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/logs/a.txt`));
    time.advance(DIRECTORY_GRANT_TTL_MS * 10);
    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/logs/b.txt`));

    expect(recorder.seen).toHaveLength(1);
  });

  it('keeps grants separate per server', async () => {
    const recorder = recordingConfirm(['session', 'once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server('server-1'), write(`${WORKSPACE_ROOT}/a.txt`));
    await authorizer.requireWrite(server('server-2'), write(`${WORKSPACE_ROOT}/a.txt`));

    expect(recorder.seen).toHaveLength(2);
  });

  it('throws when the user dismisses the prompt', async () => {
    const authorizer = new SftpWriteAuthorizer({ confirm: async () => undefined });

    await expect(authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/a.txt`))).rejects.toThrow(
      'SFTP write was cancelled.'
    );
  });

  it('rejects a scope the prompt was not allowed to offer', async () => {
    const recorder = recordingConfirm(['session']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await expect(authorizer.requireWrite(server(), write('/etc/nginx/nginx.conf'))).rejects.toThrow(
      'SFTP write was cancelled.'
    );
  });
});

describe('SftpWriteAuthorizer workspace jail', () => {
  it('flags a write that leaves the session working directory', async () => {
    const recorder = recordingConfirm(['once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write('/var/www/html/index.html'));

    expect(recorder.seen[0].outsideWorkspace).toBe(true);
    expect(recorder.seen[0].workspaceRoot).toBe(WORKSPACE_ROOT);
  });

  it('does not flag a write inside the session working directory', async () => {
    const recorder = recordingConfirm(['once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/nested/a.txt`));

    expect(recorder.seen[0].outsideWorkspace).toBe(false);
  });

  it('never offers an unbounded session grant outside the working directory', async () => {
    const recorder = recordingConfirm(['once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write('/var/www/html/index.html'));

    expect(recorder.seen[0].allowedScopes).toEqual(['once', 'directory']);
  });

  it('does not let a grant inside the working directory cover a write outside it', async () => {
    const recorder = recordingConfirm(['session', 'once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/a.txt`));
    await authorizer.requireWrite(server(), write('/var/www/html/index.html'));

    expect(recorder.seen).toHaveLength(2);
  });
});

describe('SftpWriteAuthorizer sensitive paths', () => {
  it('asks twice before writing a sensitive path', async () => {
    const recorder = recordingConfirm(['once', 'once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write('/home/deploy/.ssh/authorized_keys'));

    expect(recorder.seen.map((confirmation) => confirmation.stage)).toEqual([
      'primary',
      'sensitive-double-check'
    ]);
    expect(recorder.seen[0].sensitive).toBe(true);
  });

  it('cancels when the second sensitive confirmation is dismissed', async () => {
    const recorder = recordingConfirm(['once', undefined]);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await expect(
      authorizer.requireWrite(server(), write('/etc/systemd/system/evil.service'))
    ).rejects.toThrow('SFTP write was cancelled.');
    expect(recorder.seen).toHaveLength(2);
  });

  it('only ever offers "once" for a sensitive path', async () => {
    const recorder = recordingConfirm(['once', 'once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write('/etc/cron.d/backup'));

    expect(recorder.seen[0].allowedScopes).toEqual(['once']);
    expect(recorder.seen[1].allowedScopes).toEqual(['once']);
  });

  it('never caches a sensitive approval, so every write asks again', async () => {
    const recorder = recordingConfirm(['once', 'once', 'once', 'once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write('/etc/cron.d/backup'));
    await authorizer.requireWrite(server(), write('/etc/cron.d/backup'));

    expect(recorder.seen).toHaveLength(4);
  });

  it('does not let a session grant on the directory cover a sensitive file inside it', async () => {
    const recorder = recordingConfirm(['session', 'once', 'once']);
    const authorizer = new SftpWriteAuthorizer({ confirm: recorder.confirm });

    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/notes.txt`));
    await authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/deploy.service`));

    expect(recorder.seen).toHaveLength(3);
    expect(recorder.seen[1].sensitive).toBe(true);
    expect(recorder.seen[1].parentDirectory).toBe(WORKSPACE_ROOT);
  });
});
