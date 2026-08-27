import { describe, expect, it } from 'vitest';
import { parseSshConfig } from '../../src/ssh/SshConfigImport';

describe('parseSshConfig', () => {
  it('maps a full host entry to a server draft', () => {
    const result = parseSshConfig(
      [
        'Host prod',
        '  HostName prod.example.com',
        '  User deploy',
        '  Port 2222',
        '  IdentityFile /keys/prod.pem'
      ].join('\n')
    );

    expect(result.warnings).toEqual([]);
    expect(result.entries).toEqual([
      {
        alias: 'prod',
        draft: {
          label: 'prod',
          host: 'prod.example.com',
          port: 2222,
          username: 'deploy',
          authType: 'privateKey',
          privateKeyPath: '/keys/prod.pem'
        },
        proxyJump: undefined
      }
    ]);
  });

  it('defaults host to the alias, port to 22, and auth to agent without an identity file', () => {
    const result = parseSshConfig(['Host bare', '  User ops'].join('\n'));

    expect(result.entries[0].draft).toEqual({
      label: 'bare',
      host: 'bare',
      port: 22,
      username: 'ops',
      authType: 'agent',
      privateKeyPath: undefined
    });
  });

  it('skips wildcard and negated host patterns', () => {
    const result = parseSshConfig(
      [
        'Host *',
        '  User everyone',
        'Host *.internal staging !bastion db?',
        '  HostName 10.0.0.5'
      ].join('\n')
    );

    expect(result.entries.map((entry) => entry.alias)).toEqual(['staging']);
  });

  it('creates one draft per concrete alias on a shared Host line', () => {
    const result = parseSshConfig(['Host web1 web2', '  User deploy'].join('\n'));

    expect(result.entries.map((entry) => entry.alias)).toEqual(['web1', 'web2']);
    expect(result.entries.map((entry) => entry.draft.host)).toEqual(['web1', 'web2']);
  });

  it('keeps the first value when a keyword repeats, matching OpenSSH', () => {
    const result = parseSshConfig(
      ['Host dup', '  HostName first.example.com', '  HostName second.example.com'].join('\n')
    );

    expect(result.entries[0].draft.host).toBe('first.example.com');
  });

  it('supports key=value syntax, comments, and quoted values', () => {
    const result = parseSshConfig(
      [
        '# global comment',
        'Host "spaced host"',
        '  HostName=spaced.example.com',
        '  User deploy # inline note',
        '  IdentityFile "/key store/id_ed25519"'
      ].join('\n')
    );

    expect(result.entries[0]).toMatchObject({
      alias: 'spaced host',
      draft: {
        host: 'spaced.example.com',
        username: 'deploy',
        privateKeyPath: '/key store/id_ed25519'
      }
    });
  });

  it('expands ~ in identity file paths against the provided home directory', () => {
    const result = parseSshConfig(
      ['Host keyed', '  IdentityFile ~/.ssh/id_ed25519'].join('\n'),
      { homeDir: '/home/deploy' }
    );

    expect(result.entries[0].draft.privateKeyPath).toBe('/home/deploy/.ssh/id_ed25519');
    expect(result.entries[0].draft.authType).toBe('privateKey');
  });

  it('parses a single ProxyJump hop with user and port', () => {
    const result = parseSshConfig(
      ['Host inner', '  HostName 10.0.0.20', '  ProxyJump ops@bastion.example.com:2200'].join('\n')
    );

    expect(result.warnings).toEqual([]);
    expect(result.entries[0].proxyJump).toEqual({
      host: 'bastion.example.com',
      username: 'ops',
      port: 2200
    });
  });

  it('keeps only the first ProxyJump hop and warns about truncation', () => {
    const result = parseSshConfig(
      ['Host deep', '  ProxyJump first.example.com,second.example.com,third.example.com'].join('\n')
    );

    expect(result.entries[0].proxyJump).toEqual({
      host: 'first.example.com',
      username: undefined,
      port: undefined
    });
    expect(result.warnings).toEqual([
      'Host "deep": ProxyJump has 3 hops; only the first hop "first.example.com" was imported and the rest were truncated.'
    ]);
  });

  it('ignores ProxyJump none', () => {
    const result = parseSshConfig(['Host direct', '  ProxyJump none'].join('\n'));

    expect(result.entries[0].proxyJump).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('warns and falls back to port 22 on an invalid Port value', () => {
    const result = parseSshConfig(['Host badport', '  Port banana'].join('\n'));

    expect(result.entries[0].draft.port).toBe(22);
    expect(result.warnings).toEqual(['Host "badport": ignored invalid Port "banana"; using 22.']);
  });

  it('does not attribute keywords from Match blocks to the previous host', () => {
    const result = parseSshConfig(
      ['Host real', '  User deploy', 'Match user root', '  HostName hijacked.example.com'].join('\n')
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].draft.host).toBe('real');
  });

  it('returns no entries for an empty or comment-only file', () => {
    expect(parseSshConfig('').entries).toEqual([]);
    expect(parseSshConfig('# nothing here\n\n').entries).toEqual([]);
  });
});
