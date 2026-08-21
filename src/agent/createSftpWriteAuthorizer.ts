import { SftpWriteAuthorizer } from './SftpWriteAuthorizer';

/** Production wiring uses the VS Code confirm unless the server is fully trusted. */
export function createProductionSftpWriteAuthorizer(): SftpWriteAuthorizer {
  return new SftpWriteAuthorizer();
}
