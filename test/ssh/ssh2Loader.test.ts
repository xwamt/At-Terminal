import { describe, expect, it, vi } from 'vitest';
import { getSsh2 } from '../../src/ssh/ssh2Loader';

const loaderMocks = vi.hoisted(() => ({
  Client: vi.fn()
}));

vi.mock('ssh2', () => ({
  Client: loaderMocks.Client
}));

describe('getSsh2', () => {
  it('loads the ssh2 module on demand', async () => {
    const ssh2 = await getSsh2();

    expect(ssh2.Client).toBe(loaderMocks.Client);
  });

  it('returns the same cached module on every call', async () => {
    const first = await getSsh2();
    const second = await getSsh2();

    expect(second).toBe(first);
  });
});
