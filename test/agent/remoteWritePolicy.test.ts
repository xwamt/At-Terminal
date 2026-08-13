import { describe, expect, it } from 'vitest';
import {
  isSensitiveRemotePath,
  isWithinRemoteDirectory,
  normalizeRemoteDirectory
} from '../../src/agent/remoteWritePolicy';

describe('normalizeRemoteDirectory', () => {
  it('strips trailing separators and collapses repeats', () => {
    expect(normalizeRemoteDirectory('/home/deploy/')).toBe('/home/deploy');
    expect(normalizeRemoteDirectory('/home//deploy//app/')).toBe('/home/deploy/app');
    expect(normalizeRemoteDirectory('/')).toBe('/');
    expect(normalizeRemoteDirectory('')).toBe('/');
  });
});

describe('isWithinRemoteDirectory', () => {
  it('accepts the root itself and its descendants', () => {
    expect(isWithinRemoteDirectory('/home/deploy', '/home/deploy')).toBe(true);
    expect(isWithinRemoteDirectory('/home/deploy', '/home/deploy/app/config.yml')).toBe(true);
    expect(isWithinRemoteDirectory('/home/deploy/', '/home/deploy/app/')).toBe(true);
  });

  it('rejects siblings that merely share a name prefix', () => {
    expect(isWithinRemoteDirectory('/home/deploy', '/home/deploy-backup/x')).toBe(false);
    expect(isWithinRemoteDirectory('/home/deploy', '/home/deployment')).toBe(false);
  });

  it('rejects anything above or beside the root', () => {
    expect(isWithinRemoteDirectory('/home/deploy', '/etc/cron.d/task')).toBe(false);
    expect(isWithinRemoteDirectory('/home/deploy', '/home')).toBe(false);
    expect(isWithinRemoteDirectory('/home/deploy', '/')).toBe(false);
  });
});

describe('isSensitiveRemotePath', () => {
  it.each([
    '/home/deploy/.ssh/authorized_keys',
    '/root/.ssh/id_ed25519',
    '/home/deploy/.ssh',
    '/etc/cron.d/backup',
    '/etc',
    '/etc/sudoers',
    '/etc/sudoers.d/90-deploy',
    '/etc/systemd/system/evil.service',
    '/home/deploy/.config/systemd/user/evil.service',
    '/home/deploy/.config/systemd/user/evil.timer',
    '/usr/local/bin/deploy',
    '/usr',
    '/bin/ls',
    '/sbin/init',
    '/boot/grub/grub.cfg',
    '/root/notes.txt',
    '/var/spool/cron/crontabs/deploy',
    '/home/deploy/crontab',
    '/home/deploy/.bashrc',
    '/home/deploy/.profile',
    '/somewhere/authorized_keys'
  ])('treats %j as sensitive', (path) => {
    expect(isSensitiveRemotePath(path)).toBe(true);
  });

  it.each([
    '/home/deploy/app/config.yml',
    '/home/deploy/notes.md',
    '/var/www/html/index.html',
    '/opt/app/release.json',
    '/tmp/scratch.txt',
    '/home/deploy/etc/app.conf',
    '/home/deploy/usrdata.txt',
    '/home/deploy/service.yml'
  ])('treats %j as ordinary', (path) => {
    expect(isSensitiveRemotePath(path)).toBe(false);
  });
});
