import { t } from '../i18n/t';

/**
 * An upload found an entry already sitting at the remote destination. The UI catches this
 * to offer overwrite / skip / overwrite-all instead of silently clobbering the remote file,
 * so this error must stay identifiable after crossing module boundaries -- hence the stable
 * `name` plus the {@link isSftpConflictError} guard that also matches on it.
 */
export class SftpConflictError extends Error {
  override readonly name = 'SftpConflictError';

  constructor(public readonly path: string) {
    super(t('Remote path already exists: {path}', { path }));
  }
}

export function isSftpConflictError(error: unknown): error is SftpConflictError {
  if (error instanceof SftpConflictError) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'SftpConflictError' &&
    typeof (error as { path?: unknown }).path === 'string'
  );
}
