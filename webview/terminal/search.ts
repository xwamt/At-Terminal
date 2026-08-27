export interface SearchAddonLike {
  findNext(term: string): boolean;
  findPrevious(term: string): boolean;
  clearDecorations?(): void;
}

export interface TerminalSearchUi {
  bar: { hidden: boolean };
  input: { value: string; focus(): void; select(): void };
  focusTerminal(): void;
}

export interface TerminalSearchController {
  open(): void;
  close(): void;
  isOpen(): boolean;
  findNext(): void;
  findPrevious(): void;
  handleInputKeydown(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>): void;
}

export function isTerminalSearchShortcut(
  event: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
): boolean {
  return (
    event.type === 'keydown' &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'f'
  );
}

export function createTerminalSearchController(
  addon: SearchAddonLike,
  ui: TerminalSearchUi
): TerminalSearchController {
  const controller: TerminalSearchController = {
    open() {
      ui.bar.hidden = false;
      ui.input.focus();
      ui.input.select();
    },
    close() {
      ui.bar.hidden = true;
      addon.clearDecorations?.();
      ui.focusTerminal();
    },
    isOpen() {
      return !ui.bar.hidden;
    },
    findNext() {
      if (ui.input.value) {
        addon.findNext(ui.input.value);
      }
    },
    findPrevious() {
      if (ui.input.value) {
        addon.findPrevious(ui.input.value);
      }
    },
    handleInputKeydown(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) {
          controller.findPrevious();
        } else {
          controller.findNext();
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        controller.close();
      }
    }
  };
  return controller;
}
