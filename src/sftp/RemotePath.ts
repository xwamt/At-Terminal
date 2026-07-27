export function joinRemotePath(parent: string, child: string): string {
  const cleanParent = parent === '/' ? '' : parent.replace(/\/+$/, '');
  return `${cleanParent}/${child.replace(/^\/+/, '')}` || '/';
}

export function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return '/';
  }
  return normalized.slice(0, index);
}

export function quotePosixShellPath(path: string): string {
  return `'${path.replaceAll("'", "'\"'\"'")}'`;
}

export function safePreviewName(remotePath: string): string {
  const name = remotePath.split('/').filter(Boolean).pop() || 'remote-file';
  return name.replace(/[<>:"\\|?*\x00-\x1f]/g, '_');
}
