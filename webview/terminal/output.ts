import { semanticHighlightText } from './semanticHighlight';

interface TerminalWriter {
  write(data: string | Uint8Array, callback?: () => void): void;
}

export type TerminalOutputMessage =
  | { type?: string; payload?: unknown }
  | { type: 'outputBytes'; payload: Uint8Array }
  | { type: 'output'; payload: string };

export const TERMINAL_ENCODINGS = ['utf-8', 'gbk', 'big5'] as const;

export type TerminalEncoding = (typeof TERMINAL_ENCODINGS)[number];

export function normalizeTerminalEncoding(value: string | undefined): TerminalEncoding {
  return TERMINAL_ENCODINGS.includes(value as TerminalEncoding) ? (value as TerminalEncoding) : 'utf-8';
}

/**
 * Returns a stateful chunk decoder for legacy encodings, or `undefined` for UTF-8 where raw
 * bytes go straight to xterm (its own UTF-8 decoder already handles multi-byte sequences that
 * are split across chunks). The `stream: true` flag keeps split GBK/Big5 sequences intact
 * across chunk boundaries the same way.
 */
export function createTerminalByteDecoder(encoding: string | undefined): ((bytes: Uint8Array) => string) | undefined {
  const normalized = normalizeTerminalEncoding(encoding);
  if (normalized === 'utf-8') {
    return undefined;
  }
  const decoder = new TextDecoder(normalized);
  return (bytes) => decoder.decode(bytes, { stream: true });
}

export interface TerminalOutputOptions {
  semanticHighlight?: boolean;
  /** Chunk decoder from {@link createTerminalByteDecoder}; absent means raw UTF-8 bytes. */
  decodeBytes?: (bytes: Uint8Array) => string;
  /** Invoked once xterm has consumed the chunk, with the original byte count, for flow control. */
  acknowledge?: (bytes: number) => void;
}

export function writeTerminalOutputMessage(
  message: TerminalOutputMessage,
  terminal: TerminalWriter,
  options: TerminalOutputOptions = {}
): boolean {
  if (message.type === 'outputBytes' && message.payload instanceof Uint8Array) {
    const bytes = message.payload;
    let data: string | Uint8Array;
    if (options.decodeBytes) {
      const text = options.decodeBytes(bytes);
      data = options.semanticHighlight === true ? semanticHighlightText(text) : text;
    } else {
      data = highlightBytes(bytes, options.semanticHighlight === true) ?? bytes;
    }
    const acknowledge = options.acknowledge;
    if (acknowledge) {
      terminal.write(data, () => acknowledge(bytes.byteLength));
    } else {
      terminal.write(data);
    }
    return true;
  }
  if (message.type === 'output' && typeof message.payload === 'string') {
    terminal.write(options.semanticHighlight === true ? semanticHighlightText(message.payload) : message.payload);
    return true;
  }
  return false;
}

function highlightBytes(bytes: Uint8Array, enabled: boolean): string | undefined {
  if (!enabled) {
    return undefined;
  }

  const text = new TextDecoder().decode(bytes);
  const highlighted = semanticHighlightText(text);
  return highlighted === text ? undefined : highlighted;
}
