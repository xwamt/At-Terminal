/**
 * Path rules behind agent SFTP write authorization.
 *
 * Paths reaching these helpers have already been resolved server-side by `realpath`, so `..`
 * and symlinks are gone; what is left is deciding whether a resolved path is inside the
 * session's working tree and whether it is one of the places an agent could write to buy
 * itself persistence or privilege.
 */

export function normalizeRemoteDirectory(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return collapsed || '/';
}

export function isWithinRemoteDirectory(root: string, path: string): boolean {
  const normalizedRoot = normalizeRemoteDirectory(root);
  const normalizedPath = normalizeRemoteDirectory(path);
  if (normalizedPath === normalizedRoot) {
    return true;
  }
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix);
}

/** System trees where a write is a privilege or persistence change rather than a file edit. */
const SENSITIVE_PREFIXES = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/root',
  '/dev',
  '/proc',
  '/sys',
  '/var/spool/cron'
];

/** A path component that makes everything below it sensitive wherever it lives. */
const SENSITIVE_SEGMENTS = new Set(['.ssh']);

const SENSITIVE_BASENAMES = new Set([
  'authorized_keys',
  'authorized_keys2',
  'crontab',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc'
]);

const SENSITIVE_BASENAME_PREFIXES = ['sudoers'];

/** systemd units and timers are the user-writable half of the persistence surface. */
const SENSITIVE_BASENAME_SUFFIXES = ['.service', '.timer'];

export function isSensitiveRemotePath(path: string): boolean {
  const normalized = normalizeRemoteDirectory(path);
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? '';

  if (SENSITIVE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return true;
  }
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) {
    return true;
  }
  if (SENSITIVE_BASENAMES.has(basename)) {
    return true;
  }
  if (SENSITIVE_BASENAME_PREFIXES.some((prefix) => basename.startsWith(prefix))) {
    return true;
  }
  return SENSITIVE_BASENAME_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}
