import { toUserMessage } from './redaction';

export class UserVisibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserVisibleError';
  }
}

export function formatError(error: unknown): string {
  return toUserMessage(error);
}
