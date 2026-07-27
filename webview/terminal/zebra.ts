import type { IDisposable } from '@xterm/xterm';

export const TERMINAL_ROW_EVEN_CLASS = 'terminal-row-even';
export const TERMINAL_ROW_ODD_CLASS = 'terminal-row-odd';

interface TerminalRowLike {
  classList: Pick<DOMTokenList, 'add' | 'remove'>;
}

interface WriteParsedTerminalLike {
  onWriteParsed(listener: () => void): IDisposable;
}

type RequestFrame = (callback: FrameRequestCallback) => number;

export function applyTerminalZebraRows(rows: Iterable<TerminalRowLike>): void {
  let rowIndex = 0;
  for (const row of rows) {
    row.classList.remove(TERMINAL_ROW_EVEN_CLASS, TERMINAL_ROW_ODD_CLASS);
    row.classList.add(rowIndex % 2 === 0 ? TERMINAL_ROW_EVEN_CLASS : TERMINAL_ROW_ODD_CLASS);
    rowIndex++;
  }
}

export function applyTerminalZebraStripes(root: ParentNode = document): void {
  applyTerminalZebraRows(root.querySelectorAll<HTMLElement>('.xterm-rows > div'));
}

export function scheduleTerminalZebraRefresh(
  terminal: WriteParsedTerminalLike,
  refresh: () => void,
  requestFrame: RequestFrame = requestAnimationFrame
): IDisposable {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestFrame(() => {
      scheduled = false;
      refresh();
    });
  };

  const disposable = terminal.onWriteParsed(schedule);
  schedule();
  return disposable;
}

export function watchTerminalZebraStripes(
  terminal: WriteParsedTerminalLike,
  root: ParentNode = document,
  requestFrame: RequestFrame = requestAnimationFrame
): IDisposable {
  return scheduleTerminalZebraRefresh(terminal, () => applyTerminalZebraStripes(root), requestFrame);
}
