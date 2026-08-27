import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PolicyAssetResolver, PolicyEvaluator } from '@at-series/command-policy';
import { createShellPolicyEvaluator } from '@at-series/command-policy/shell';

export interface TerminalPolicyRuntimeOptions {
  readonly assetDirectory?: string;
}

export function createTerminalPolicyRuntime(
  options: TerminalPolicyRuntimeOptions = {}
): PolicyEvaluator {
  const assetDirectory = options.assetDirectory;
  const assetResolver: PolicyAssetResolver | undefined = assetDirectory
    ? async (asset) => readFile(join(assetDirectory, asset.fileName))
    : undefined;
  return createShellPolicyEvaluator(assetResolver ? { assetResolver } : {});
}
