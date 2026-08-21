import { requiresConfirmation } from './remoteCommandPolicy';

export const AGENT_COMMAND_TRUST_LEVELS = ['none', 'policy', 'full'] as const;
export type AgentCommandTrust = (typeof AGENT_COMMAND_TRUST_LEVELS)[number];

export function parseAgentCommandTrust(value: unknown): AgentCommandTrust {
  return AGENT_COMMAND_TRUST_LEVELS.includes(value as AgentCommandTrust)
    ? (value as AgentCommandTrust)
    : 'none';
}

export function resolveAgentCommandTrust(server: {
  agentCommandTrust?: AgentCommandTrust;
  agentCommandAutoApprove?: boolean;
}): AgentCommandTrust {
  if (server.agentCommandTrust) {
    return server.agentCommandTrust;
  }
  return server.agentCommandAutoApprove === true ? 'policy' : 'none';
}

export function shouldAutoApproveRemoteCommand(
  server: {
    agentCommandTrust?: AgentCommandTrust;
    agentCommandAutoApprove?: boolean;
  },
  command: string
): boolean {
  const trust = resolveAgentCommandTrust(server);
  if (trust === 'full') {
    return true;
  }
  if (trust === 'policy') {
    return !requiresConfirmation(command);
  }
  return false;
}

export function shouldAutoApproveSftpWrite(server: {
  agentCommandTrust?: AgentCommandTrust;
  agentCommandAutoApprove?: boolean;
}): boolean {
  return resolveAgentCommandTrust(server) === 'full';
}
