declare const __AT_TERMINAL_MCP_ENABLED__: boolean;

export const MCP_ENABLED =
  typeof __AT_TERMINAL_MCP_ENABLED__ === 'boolean' ? __AT_TERMINAL_MCP_ENABLED__ : true;
