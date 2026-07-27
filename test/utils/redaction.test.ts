import { describe, expect, it } from 'vitest';
import { redactSensitiveText, toUserMessage } from '../../src/utils/redaction';

describe('redaction utilities', () => {
  it('redacts passwords and private key blocks from text', () => {
    const input = 'password=secret -----BEGIN OPENSSH PRIVATE KEY----- abc';
    expect(redactSensitiveText(input)).toBe('password=[REDACTED] [REDACTED_PRIVATE_KEY]');
  });

  it('formats unknown errors without leaking raw objects', () => {
    expect(toUserMessage(new Error('connect failed'))).toBe('connect failed');
    expect(toUserMessage({ message: 'custom failure' })).toBe('custom failure');
    expect(toUserMessage(42)).toBe('Unexpected error');
  });
});
