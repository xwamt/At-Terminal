const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const formatted = Number.isInteger(value) ? value.toString() : value.toFixed(1).replace(/\.0$/, '');
  return `${formatted} ${UNITS[unitIndex]}`;
}
