import type { HostApp } from '@at-series/mcp-hub';

export function detectHostApp(input: {
  appName?: string;
  appRoot?: string;
  uriScheme?: string;
  extensionPath?: string;
}): HostApp {
  const signals = [input.extensionPath, input.appName, input.appRoot, input.uriScheme]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizePath(value).toLowerCase());

  if (matches(signals, 'kiro')) {
    return 'kiro';
  }
  if (matches(signals, 'cursor')) {
    return 'cursor';
  }
  if (matches(signals, 'qoder')) {
    return 'qoder';
  }
  if (matches(signals, 'windsurf')) {
    return 'windsurf';
  }
  if (matches(signals, 'continue')) {
    return 'continue';
  }
  if (matches(signals, 'vscode') || signals.some((value) => value.includes('visual studio code'))) {
    return 'vscode';
  }
  return 'unknown';
}

function matches(signals: string[], id: string): boolean {
  const dotted = `/.${id}/`;
  const dottedWin = `\\.${id}\\`;
  return signals.some(
    (value) => value.includes(dotted) || value.includes(dottedWin) || value.includes(id)
  );
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}
