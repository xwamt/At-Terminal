import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeRemoteCommand,
  shouldAutoApproveRemoteCommand
} from '../../src/agent/agentCommandTrust';
import {
  resetRemoteCommandPolicyForTests,
  setRemoteCommandPolicyLoaderForTests
} from '../../src/agent/loadRemoteCommandPolicy';

function allowDecision() {
  return {
    action: 'allow' as const,
    reasonCode: 'shell.ordinary_read',
    evidence: []
  };
}

function reviewDecision(summary = 'State-changing command requires review.') {
  return {
    action: 'review' as const,
    reasonCode: 'shell.state_modification',
    evidence: [{ summary, redacted: true as const }]
  };
}

afterEach(() => {
  resetRemoteCommandPolicyForTests();
});

describe('authorizeRemoteCommand trust mapping', () => {
  it('does not load policy under none trust', async () => {
    const evaluate = vi.fn(async () => allowDecision());
    setRemoteCommandPolicyLoaderForTests(async () => ({ evaluate }));

    const result = await authorizeRemoteCommand({
      server: { agentCommandTrust: 'none' },
      command: 'uptime',
      cwd: '/var/log'
    });

    expect(result.autoApprove).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not load policy under full trust', async () => {
    const evaluate = vi.fn(async () => reviewDecision());
    setRemoteCommandPolicyLoaderForTests(async () => ({ evaluate }));

    const result = await authorizeRemoteCommand({
      server: { agentCommandTrust: 'full' },
      command: 'rm -rf /'
    });

    expect(result.autoApprove).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('auto-approves only allow decisions under policy trust', async () => {
    setRemoteCommandPolicyLoaderForTests(async () => ({
      evaluate: async () => allowDecision()
    }));

    await expect(
      authorizeRemoteCommand({
        server: { agentCommandTrust: 'policy' },
        command: 'uptime',
        cwd: '/home/deploy'
      })
    ).resolves.toMatchObject({ autoApprove: true, action: 'allow' });
  });

  it('confirms review and deny decisions under policy trust', async () => {
    setRemoteCommandPolicyLoaderForTests(async () => ({
      evaluate: async () => reviewDecision('Writes files.')
    }));

    const reviewed = await authorizeRemoteCommand({
      server: { agentCommandAutoApprove: true },
      command: 'rm -rf /tmp/app'
    });
    expect(reviewed.autoApprove).toBe(false);
    expect(reviewed.riskSummaries).toEqual(['Writes files.']);

    setRemoteCommandPolicyLoaderForTests(async () => ({
      evaluate: async () => ({
        action: 'deny' as const,
        reasonCode: 'redis.blocking',
        evidence: [{ summary: 'Blocking command.', redacted: true as const }]
      })
    }));
    await expect(
      authorizeRemoteCommand({
        server: { agentCommandTrust: 'policy' },
        command: 'BLPOP queue 0'
      })
    ).resolves.toMatchObject({ autoApprove: false, action: 'deny' });
  });

  it('passes the original command text and cwd without rewriting source', async () => {
    const evaluate = vi.fn(async () => allowDecision());
    setRemoteCommandPolicyLoaderForTests(async () => ({ evaluate }));
    const command = '# Purpose: check load\nuptime';

    await authorizeRemoteCommand({
      server: { agentCommandTrust: 'policy' },
      command,
      cwd: '/opt/app'
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith({ sourceText: command, cwd: '/opt/app' });
  });

  it('fail-closes to confirmation when policy initialization fails', async () => {
    setRemoteCommandPolicyLoaderForTests(async () => {
      throw new Error('wasm missing');
    });

    await expect(
      authorizeRemoteCommand({
        server: { agentCommandTrust: 'policy' },
        command: 'uptime'
      })
    ).resolves.toMatchObject({
      autoApprove: false,
      reasonCode: 'policy.initialization_failed'
    });
  });
});

describe('shouldAutoApproveRemoteCommand', () => {
  it('never auto-approves when the server is untrusted', async () => {
    await expect(shouldAutoApproveRemoteCommand({ agentCommandTrust: 'none' }, 'uptime')).resolves.toBe(false);
  });

  it('uses the shared policy under limited trust', async () => {
    setRemoteCommandPolicyLoaderForTests(async () => ({
      evaluate: async ({ sourceText }: { sourceText: string }) =>
        sourceText.includes('rm') ? reviewDecision() : allowDecision()
    }));
    await expect(shouldAutoApproveRemoteCommand({ agentCommandTrust: 'policy' }, 'uptime')).resolves.toBe(true);
    await expect(shouldAutoApproveRemoteCommand({ agentCommandTrust: 'policy' }, 'rm -rf /')).resolves.toBe(false);
    await expect(shouldAutoApproveRemoteCommand({ agentCommandAutoApprove: true }, 'uptime')).resolves.toBe(true);
  });

  it('auto-approves every remote command under full trust', async () => {
    await expect(shouldAutoApproveRemoteCommand({ agentCommandTrust: 'full' }, 'rm -rf /')).resolves.toBe(true);
  });
});
