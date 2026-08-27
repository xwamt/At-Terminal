import { looksDestructive } from './destructiveCommandHint';
import {
  loadRemoteCommandPolicyEvaluator,
  type RemoteCommandPolicyDecision
} from './loadRemoteCommandPolicy';
import { resolveAgentCommandTrust, type AgentCommandTrust } from './agentCommandTrust';

export interface RemoteCommandAuthorization {
  readonly autoApprove: boolean;
  readonly destructive: boolean;
  readonly riskSummaries: readonly string[];
  readonly reasonCode?: string;
  readonly action?: RemoteCommandPolicyDecision['action'];
}

function unavailableDecision(): RemoteCommandPolicyDecision {
  return {
    action: 'review',
    reasonCode: 'policy.initialization_failed',
    evidence: []
  };
}

function isPolicyAction(value: unknown): value is RemoteCommandPolicyDecision['action'] {
  return value === 'allow' || value === 'review' || value === 'deny';
}

export async function authorizeRemoteCommand(options: {
  server: {
    agentCommandTrust?: AgentCommandTrust;
    agentCommandAutoApprove?: boolean;
  };
  command: string;
  cwd?: string;
}): Promise<RemoteCommandAuthorization> {
  const destructive = looksDestructive(options.command);
  const trust = resolveAgentCommandTrust(options.server);
  if (trust === 'full') {
    return { autoApprove: true, destructive, riskSummaries: [] };
  }
  if (trust !== 'policy') {
    return { autoApprove: false, destructive, riskSummaries: [] };
  }

  let decision: RemoteCommandPolicyDecision;
  try {
    const evaluator = await loadRemoteCommandPolicyEvaluator();
    decision = await evaluator.evaluate({
      sourceText: options.command,
      cwd: options.cwd
    });
  } catch {
    decision = unavailableDecision();
  }

  if (!isPolicyAction(decision.action)) {
    decision = unavailableDecision();
  }

  return {
    autoApprove: decision.action === 'allow',
    destructive,
    riskSummaries: decision.evidence.map((item) => item.summary).filter((summary) => summary.length > 0),
    reasonCode: decision.reasonCode,
    action: decision.action
  };
}
