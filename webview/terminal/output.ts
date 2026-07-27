import { semanticHighlightText } from './semanticHighlight';

interface TerminalWriter {
  write(data: string | Uint8Array): void;
}

export type TerminalOutputMessage =
  | { type?: string; payload?: unknown }
  | { type: 'outputBytes'; payload: number[] }
  | { type: 'output'; payload: string };

export interface TerminalOutputOptions {
  semanticHighlight?: boolean;
}

export function writeTerminalOutputMessage(
  message: TerminalOutputMessage,
  terminal: TerminalWriter,
  options: TerminalOutputOptions = {}
): boolean {
  if (message.type === 'outputBytes' && isByteArray(message.payload)) {
    const bytes = Uint8Array.from(message.payload);
    const highlighted = highlightBytes(bytes, options.semanticHighlight === true);
    terminal.write(highlighted ?? bytes);
    return true;
  }
  if (message.type === 'output' && typeof message.payload === 'string') {
    terminal.write(options.semanticHighlight === true ? semanticHighlightText(message.payload) : message.payload);
    return true;
  }
  return false;
}

function isByteArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

function highlightBytes(bytes: Uint8Array, enabled: boolean): string | undefined {
  if (!enabled) {
    return undefined;
  }

  const text = new TextDecoder().decode(bytes);
  const highlighted = semanticHighlightText(text);
  return highlighted === text ? undefined : highlighted;
}
