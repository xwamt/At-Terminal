import { describe, expect, it } from 'vitest';
import { looksDestructive } from '../../src/agent/destructiveCommandHint';

describe('looksDestructive', () => {
  it('flags the obviously destructive shapes used by the confirmation banner', () => {
    expect(looksDestructive('rm -rf /tmp/app')).toBe(true);
    expect(looksDestructive('mkfs.ext4 /dev/sdb1')).toBe(true);
    expect(looksDestructive('shutdown -h now')).toBe(true);
    expect(looksDestructive('dd if=/dev/zero of=/dev/sda')).toBe(true);
  });

  it('does not treat ordinary state changes as catastrophic', () => {
    expect(looksDestructive('mkdir -p /tmp/build')).toBe(false);
    expect(looksDestructive('systemctl restart nginx')).toBe(false);
    expect(looksDestructive('find / -delete')).toBe(false);
    expect(looksDestructive('truncate -s0 /etc/shadow')).toBe(false);
  });
});
