import { describe, expect, it, vi } from 'vitest';
import { createTerminalSearchController, isTerminalSearchShortcut } from '../../webview/terminal/search';

function fakeUi(value = '') {
  return {
    bar: { hidden: true },
    input: { value, focus: vi.fn(), select: vi.fn() },
    focusTerminal: vi.fn()
  };
}

function fakeAddon() {
  return {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn()
  };
}

describe('terminal search shortcut', () => {
  it('matches Ctrl+F and Cmd+F keydown only', () => {
    expect(
      isTerminalSearchShortcut({ type: 'keydown', key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })
    ).toBe(true);
    expect(
      isTerminalSearchShortcut({ type: 'keydown', key: 'F', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })
    ).toBe(true);
    expect(
      isTerminalSearchShortcut({ type: 'keyup', key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })
    ).toBe(false);
    expect(
      isTerminalSearchShortcut({ type: 'keydown', key: 'f', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    ).toBe(false);
    expect(
      isTerminalSearchShortcut({ type: 'keydown', key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })
    ).toBe(false);
  });
});

describe('terminal search controller', () => {
  it('opens the find bar and focuses the input', () => {
    const ui = fakeUi();
    const controller = createTerminalSearchController(fakeAddon(), ui);

    controller.open();

    expect(ui.bar.hidden).toBe(false);
    expect(controller.isOpen()).toBe(true);
    expect(ui.input.focus).toHaveBeenCalledOnce();
    expect(ui.input.select).toHaveBeenCalledOnce();
  });

  it('closes the find bar, clears decorations, and returns focus to the terminal', () => {
    const ui = fakeUi();
    const addon = fakeAddon();
    const controller = createTerminalSearchController(addon, ui);

    controller.open();
    controller.close();

    expect(ui.bar.hidden).toBe(true);
    expect(addon.clearDecorations).toHaveBeenCalledOnce();
    expect(ui.focusTerminal).toHaveBeenCalledOnce();
  });

  it('searches forward on Enter and backward on Shift+Enter', () => {
    const ui = fakeUi('needle');
    const addon = fakeAddon();
    const controller = createTerminalSearchController(addon, ui);

    controller.handleInputKeydown({ key: 'Enter', shiftKey: false, preventDefault: vi.fn() });
    controller.handleInputKeydown({ key: 'Enter', shiftKey: true, preventDefault: vi.fn() });

    expect(addon.findNext).toHaveBeenCalledWith('needle');
    expect(addon.findPrevious).toHaveBeenCalledWith('needle');
  });

  it('closes on Escape', () => {
    const ui = fakeUi();
    const controller = createTerminalSearchController(fakeAddon(), ui);
    controller.open();

    controller.handleInputKeydown({ key: 'Escape', shiftKey: false, preventDefault: vi.fn() });

    expect(controller.isOpen()).toBe(false);
  });

  it('does not query the addon when the search term is empty', () => {
    const addon = fakeAddon();
    const controller = createTerminalSearchController(addon, fakeUi(''));

    controller.findNext();
    controller.findPrevious();

    expect(addon.findNext).not.toHaveBeenCalled();
    expect(addon.findPrevious).not.toHaveBeenCalled();
  });
});
