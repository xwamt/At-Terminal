import { describe, expect, it } from 'vitest';
import {
  formatRemoteCommandConfirmMessage,
  truncateCommandPreview
} from '../../src/utils/commandPreview';

describe('commandPreview', () => {
  it('returns short commands unchanged', () => {
    expect(truncateCommandPreview('echo hi')).toBe('echo hi');
  });

  it('truncates by line count first', () => {
    const command = Array.from({ length: 25 }, (_, i) => `line-${i}`).join('\n');
    const result = truncateCommandPreview(command);
    expect(result.startsWith('line-0\n')).toBe(true);
    expect(result).toContain('line-19');
    expect(result).not.toContain('line-20');
    expect(result).toContain(`… (truncated, ${command.length} chars, 25 lines)`);
  });

  it('truncates by character count when under line limit', () => {
    const command = 'a'.repeat(900);
    const result = truncateCommandPreview(command);
    expect(result.startsWith('a'.repeat(800))).toBe(true);
    expect(result).toContain('… (truncated, 900 chars, 1 lines)');
  });

  it('keeps destructive warning outside truncated command body', () => {
    const command = 'rm -rf /tmp/app\n' + 'x'.repeat(900);
    const message = formatRemoteCommandConfirmMessage({
      serverLabel: 'Production',
      host: 'server-1.example.com',
      command,
      destructive: true
    });
    expect(message).toContain('… (truncated,');
    expect(message.endsWith('Warning: this command appears destructive.')).toBe(true);
    expect(message.indexOf('… (truncated')).toBeLessThan(message.indexOf('Warning:'));
  });
});
