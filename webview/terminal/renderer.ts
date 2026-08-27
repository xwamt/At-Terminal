export interface WebglAddonLike {
  dispose(): void;
  onContextLoss(listener: () => void): { dispose(): void };
}

interface RendererTerminal {
  loadAddon(addon: WebglAddonLike): void;
}

export type TerminalRendererKind = 'webgl' | 'dom';

export type TerminalRendererFallbackReason = 'zebra-stripes' | 'load-failed' | 'context-loss';

export interface TerminalRendererOptions {
  /** Zebra stripes restyle the DOM rows, which the WebGL renderer does not produce. */
  zebraStripes: boolean;
  createWebglAddon: () => WebglAddonLike;
  onFallback?: (reason: TerminalRendererFallbackReason) => void;
}

/**
 * Attaches the WebGL renderer unless zebra striping needs the DOM renderer. Any failure —
 * addon construction, activation, or a later GPU context loss — disposes the addon, which
 * reverts xterm to its DOM renderer, so output keeps flowing either way.
 */
export function setupTerminalRenderer(terminal: RendererTerminal, options: TerminalRendererOptions): TerminalRendererKind {
  if (options.zebraStripes) {
    options.onFallback?.('zebra-stripes');
    return 'dom';
  }

  let addon: WebglAddonLike | undefined;
  try {
    addon = options.createWebglAddon();
    addon.onContextLoss(() => {
      try {
        addon?.dispose();
      } finally {
        options.onFallback?.('context-loss');
      }
    });
    terminal.loadAddon(addon);
    return 'webgl';
  } catch {
    try {
      addon?.dispose();
    } catch {
      // The addon may throw again when disposed before activation finished.
    }
    options.onFallback?.('load-failed');
    return 'dom';
  }
}
