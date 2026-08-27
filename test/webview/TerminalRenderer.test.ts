import { describe, expect, it, vi } from 'vitest';
import { setupTerminalRenderer, type WebglAddonLike } from '../../webview/terminal/renderer';
import { colorHasAlpha } from '../../webview/terminal/options';

function fakeWebglAddon() {
  let contextLossListener: (() => void) | undefined;
  const addon: WebglAddonLike = {
    dispose: vi.fn(),
    onContextLoss: vi.fn((listener: () => void) => {
      contextLossListener = listener;
      return { dispose: vi.fn() };
    })
  };
  return { addon, loseContext: () => contextLossListener?.() };
}

describe('terminal renderer selection', () => {
  it('attaches the WebGL addon when zebra stripes are off', () => {
    const { addon } = fakeWebglAddon();
    const terminal = { loadAddon: vi.fn() };

    const kind = setupTerminalRenderer(terminal, {
      zebraStripes: false,
      createWebglAddon: () => addon
    });

    expect(kind).toBe('webgl');
    expect(terminal.loadAddon).toHaveBeenCalledWith(addon);
  });

  it('keeps the DOM renderer when zebra stripes are on since WebGL cannot restyle rows', () => {
    const create = vi.fn();
    const terminal = { loadAddon: vi.fn() };
    const onFallback = vi.fn();

    const kind = setupTerminalRenderer(terminal, {
      zebraStripes: true,
      createWebglAddon: create,
      onFallback
    });

    expect(kind).toBe('dom');
    expect(create).not.toHaveBeenCalled();
    expect(terminal.loadAddon).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledWith('zebra-stripes');
  });

  it('falls back to the DOM renderer when WebGL activation throws', () => {
    const { addon } = fakeWebglAddon();
    const terminal = {
      loadAddon: vi.fn(() => {
        throw new Error('WebGL2 not supported');
      })
    };
    const onFallback = vi.fn();

    const kind = setupTerminalRenderer(terminal, {
      zebraStripes: false,
      createWebglAddon: () => addon,
      onFallback
    });

    expect(kind).toBe('dom');
    expect(addon.dispose).toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledWith('load-failed');
  });

  it('falls back to the DOM renderer when addon construction throws', () => {
    const terminal = { loadAddon: vi.fn() };
    const onFallback = vi.fn();

    const kind = setupTerminalRenderer(terminal, {
      zebraStripes: false,
      createWebglAddon: () => {
        throw new Error('no WebGL context');
      },
      onFallback
    });

    expect(kind).toBe('dom');
    expect(terminal.loadAddon).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledWith('load-failed');
  });

  it('disposes the addon on GPU context loss so xterm reverts to the DOM renderer', () => {
    const { addon, loseContext } = fakeWebglAddon();
    const terminal = { loadAddon: vi.fn() };
    const onFallback = vi.fn();

    setupTerminalRenderer(terminal, {
      zebraStripes: false,
      createWebglAddon: () => addon,
      onFallback
    });
    loseContext();

    expect(addon.dispose).toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledWith('context-loss');
  });
});

describe('terminal background alpha detection', () => {
  it('flags translucent backgrounds so allowTransparency is only set when needed', () => {
    expect(colorHasAlpha('transparent')).toBe(true);
    expect(colorHasAlpha('#12345678')).toBe(true);
    expect(colorHasAlpha('#1234')).toBe(true);
    expect(colorHasAlpha('rgba(0, 0, 0, 0.5)')).toBe(true);
    expect(colorHasAlpha('rgb(0 0 0 / 50%)')).toBe(true);
  });

  it('treats opaque colors as not requiring transparency', () => {
    expect(colorHasAlpha('#1e1e1e')).toBe(false);
    expect(colorHasAlpha('#112233ff')).toBe(false);
    expect(colorHasAlpha('rgb(30, 30, 30)')).toBe(false);
    expect(colorHasAlpha('rgba(0, 0, 0, 1)')).toBe(false);
    expect(colorHasAlpha(undefined)).toBe(false);
    expect(colorHasAlpha('')).toBe(false);
  });
});
