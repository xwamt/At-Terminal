import { SftpWriteAuthorizer } from './SftpWriteAuthorizer';

/** Production wiring must use default VS Code confirm — never auto-approve. */
export function createProductionSftpWriteAuthorizer(): SftpWriteAuthorizer {
  return new SftpWriteAuthorizer();
}
