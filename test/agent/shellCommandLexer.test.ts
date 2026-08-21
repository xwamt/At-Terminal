import { describe, expect, it } from 'vitest';
import { tokenizeShellCommand } from '../../src/agent/shellCommandLexer';

describe('tokenizeShellCommand', () => {
  it('keeps quoted pipes in one stage', () => {
    const result = tokenizeShellCommand("grep -iE 'error|fail|oom' /var/log/messages");
    expect(result).toEqual({
      ok: true,
      stages: [['grep', '-iE', 'error|fail|oom', '/var/log/messages']]
    });
  });

  it('treats $() inside double quotes as command substitution', () => {
    expect(tokenizeShellCommand('echo "$(rm x)"')).toEqual({ ok: false });
  });

  it('treats $() inside single quotes as literal text', () => {
    expect(tokenizeShellCommand("echo '$(rm x)'")).toEqual({
      ok: true,
      stages: [['echo', '$(rm x)']]
    });
  });

  it('splits on unquoted operators and keeps quoted spaces in one token', () => {
    const result = tokenizeShellCommand('echo "hello world" | head -1; uptime');
    expect(result).toEqual({
      ok: true,
      stages: [['echo', 'hello world'], ['head', '-1'], ['uptime']]
    });
  });

  it('drops safe redirections and rejects file redirections', () => {
    expect(tokenizeShellCommand('cat /etc/hosts 2>/dev/null')).toEqual({
      ok: true,
      stages: [['cat', '/etc/hosts']]
    });
    expect(tokenizeShellCommand('cat x > /etc/passwd')).toEqual({ ok: false });
    expect(tokenizeShellCommand('cat < /etc/shadow')).toEqual({ ok: false });
  });

  it('rejects an escaped command name and unclosed quotes', () => {
    expect(tokenizeShellCommand('\\rm -rf /')).toEqual({ ok: false });
    expect(tokenizeShellCommand("grep 'unterminated")).toEqual({ ok: false });
  });

  it('rejects backticks in unquoted and double-quoted text', () => {
    expect(tokenizeShellCommand('`rm -rf /`')).toEqual({ ok: false });
    expect(tokenizeShellCommand('echo "`rm`"')).toEqual({ ok: false });
  });
});
