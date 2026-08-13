import { semanticHighlightText } from './semanticHighlight';

interface TerminalWriter {
  write(data: string | Uint8Array): void;
}

export type TerminalOutputMessage =
  | { type?: string; payload?: unknown }
  | { type: 'outputBytes'; payload: string }
  | { type: 'output'; payload: string };

export interface TerminalOutputOptions {
  semanticHighlight?: boolean;
}

export function writeTerminalOutputMessage(
  message: TerminalOutputMessage,
  terminal: TerminalWriter,
  options: TerminalOutputOptions = {}
): boolean {
  if (message.type === 'outputBytes' && typeof message.payload === 'string') {
    const bytes = decodeBase64(message.payload);
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

function decodeBase64(payload: string): Uint8Array {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function highlightBytes(bytes: Uint8Array, enabled: boolean): string | undefined {
  if (!enabled) {
    return undefined;
  }

  const text = new TextDecoder().decode(bytes);
  const highlighted = semanticHighlightText(text);
  return highlighted === text ? undefined : highlighted;
}
