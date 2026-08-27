import { join } from 'node:path';
import { createRequire } from 'node:module';

export interface RemoteCommandPolicyEvidence {
  readonly summary: string;
}

export interface RemoteCommandPolicyDecision {
  readonly action: 'allow' | 'review' | 'deny';
  readonly reasonCode: string;
  readonly evidence: readonly RemoteCommandPolicyEvidence[];
}

export interface RemoteCommandPolicyEvaluator {
  evaluate(input: { sourceText: string; cwd?: string }): Promise<RemoteCommandPolicyDecision>;
}

const INITIALIZATION_FAILED: RemoteCommandPolicyDecision = Object.freeze({
  action: 'review',
  reasonCode: 'policy.initialization_failed',
  evidence: Object.freeze([])
});

function createUnavailableEvaluator(): RemoteCommandPolicyEvaluator {
  return {
    async evaluate() {
      return INITIALIZATION_FAILED;
    }
  };
}

type PolicyLoader = () =>
  | RemoteCommandPolicyEvaluator
  | Promise<RemoteCommandPolicyEvaluator>;

let testLoader: PolicyLoader | undefined;
let cached: Promise<RemoteCommandPolicyEvaluator> | undefined;

export function setRemoteCommandPolicyLoaderForTests(loader: PolicyLoader | undefined): void {
  testLoader = loader;
  cached = undefined;
}

export function resetRemoteCommandPolicyForTests(): void {
  testLoader = undefined;
  cached = undefined;
}

function loadBundledPolicyRuntime(): RemoteCommandPolicyEvaluator {
  try {
    const require = createRequire(__filename);
    const runtimePath = join(__dirname, 'policy-runtime.js');
    const runtime = require(runtimePath) as {
      createTerminalPolicyRuntime?: (options: { assetDirectory: string }) => RemoteCommandPolicyEvaluator;
    };
    if (typeof runtime.createTerminalPolicyRuntime !== 'function') {
      return createUnavailableEvaluator();
    }
    return runtime.createTerminalPolicyRuntime({
      assetDirectory: join(__dirname, 'policy-assets')
    });
  } catch {
    return createUnavailableEvaluator();
  }
}

export async function loadRemoteCommandPolicyEvaluator(): Promise<RemoteCommandPolicyEvaluator> {
  cached ??= (async () => {
    if (testLoader) {
      return await testLoader();
    }
    if (!MCP_ENABLED) {
      return createUnavailableEvaluator();
    }
    return loadBundledPolicyRuntime();
  })();
  try {
    return await cached;
  } catch {
    cached = undefined;
    return createUnavailableEvaluator();
  }
}
