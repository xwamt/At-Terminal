export interface WebglAddonLike {
  dispose(): void;
  onContextLoss(listener: () => void): { dispose(): void };
}

export type TerminalRendererKind = 'webgl' | 'dom';

export type TerminalRendererFallbackReason = 'zebra-stripes' | 'load-failed' | 'context-loss';

export interface TerminalRendererOptions<TAddon extends WebglAddonLike> {
  /** Zebra stripes restyle the DOM rows, which the WebGL renderer does not produce. */
  zebraStripes: boolean;
  createWebglAddon: () => TAddon;
  onFallback?: (reason: TerminalRendererFallbackReason) => void;
}

/**
 * Attaches the WebGL renderer unless zebra striping needs the DOM renderer. Any failure —
 * addon construction, activation, or a later GPU context loss — disposes the addon, which
 * reverts xterm to its DOM renderer, so output keeps flowing either way.
 */
export function setupTerminalRenderer<TAddon extends WebglAddonLike>(
  terminal: { loadAddon(addon: NoInfer<TAddon>): void },
  options: TerminalRendererOptions<TAddon>
): TerminalRendererKind {
  if (options.zebraStripes) {
    options.onFallback?.('zebra-stripes');
    return 'dom';
  }

  let addon: TAddon | undefined;
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
