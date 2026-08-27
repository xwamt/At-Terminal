import { describe, expect, it } from 'vitest';
import {
  parseAgentCommandTrust,
  resolveAgentCommandTrust,
  shouldAutoApproveSftpWrite
} from '../../src/agent/agentCommandTrust';

describe('resolveAgentCommandTrust', () => {
  it('treats a missing config as untrusted', () => {
    expect(resolveAgentCommandTrust({})).toBe('none');
  });

  it('maps the legacy trust checkbox to limited / policy trust', () => {
    expect(resolveAgentCommandTrust({ agentCommandAutoApprove: true })).toBe('policy');
    expect(resolveAgentCommandTrust({ agentCommandAutoApprove: false })).toBe('none');
  });

  it('prefers the explicit trust level over the legacy boolean', () => {
    expect(resolveAgentCommandTrust({ agentCommandTrust: 'full' })).toBe('full');
    expect(
      resolveAgentCommandTrust({ agentCommandTrust: 'none', agentCommandAutoApprove: true })
    ).toBe('none');
  });
});

describe('parseAgentCommandTrust', () => {
  it('accepts the three stored levels and rejects anything else as none', () => {
    expect(parseAgentCommandTrust('none')).toBe('none');
    expect(parseAgentCommandTrust('policy')).toBe('policy');
    expect(parseAgentCommandTrust('full')).toBe('full');
    expect(parseAgentCommandTrust('on')).toBe('none');
    expect(parseAgentCommandTrust(true)).toBe('none');
    expect(parseAgentCommandTrust(undefined)).toBe('none');
  });
});

describe('shouldAutoApproveSftpWrite', () => {
  it('skips SFTP write prompts only under full trust', () => {
    expect(shouldAutoApproveSftpWrite({ agentCommandTrust: 'full' })).toBe(true);
    expect(shouldAutoApproveSftpWrite({ agentCommandTrust: 'policy' })).toBe(false);
    expect(shouldAutoApproveSftpWrite({ agentCommandAutoApprove: true })).toBe(false);
    expect(shouldAutoApproveSftpWrite({})).toBe(false);
  });
});
