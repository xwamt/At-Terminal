#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BridgeClient } from './BridgeClient';

const bridge = new BridgeClient();
const server = new McpServer({
  name: 'at-terminal',
  version: '0.2.12'
});

const sftpTargetSchema = {
  terminalId: z.string().optional().describe('Connected AT Terminal terminal id.'),
  serverId: z.string().optional().describe('Connected AT Terminal server id.')
};

const pathSchema = {
  ...sftpTargetSchema,
  path: z.string().min(1).describe('Remote POSIX path.')
};

server.registerTool(
  'list_ssh_servers',
  {
    title: 'List SSH Servers',
    description: 'List configured AT Terminal SSH servers without exposing credentials.',
    inputSchema: {}
  },
  async () => {
    const result = await bridge.listServers();
    return textResult(result);
  }
);

server.registerTool(
  'get_terminal_context',
  {
    title: 'Get Terminal Context',
    description: 'Return focused, default connected, connected, and known AT Terminal SSH terminal contexts.',
    inputSchema: {}
  },
  async () => textResult(await bridge.getTerminalContext())
);

server.registerTool(
  'run_remote_command',
  {
    title: 'Run Remote SSH Command',
    description: 'Run a confirmed non-interactive command on an AT Terminal SSH server.',
    inputSchema: {
      serverId: z
        .string()
        .optional()
        .describe('Configured SSH server id, or active for the connected active SSH terminal.'),
      command: z.string().min(1).describe('Non-interactive shell command to run remotely.'),
      cwd: z.string().optional().describe('Optional POSIX working directory.'),
      timeoutMs: z.number().int().positive().optional().describe('Optional timeout in milliseconds.'),
      maxOutputBytes: z.number().int().positive().optional().describe('Optional max bytes for stdout and stderr.')
    }
  },
  async (input) => {
    const result = await bridge.runRemoteCommand(input);
    return textResult(result);
  }
);

server.registerTool(
  'sftp_list_directory',
  {
    title: 'SFTP List Directory',
    description: 'List a remote directory through the selected AT Terminal SFTP session.',
    inputSchema: { ...sftpTargetSchema, path: z.string().optional() }
  },
  async (input) => textResult(await bridge.sftpListDirectory(input))
);

server.registerTool(
  'sftp_stat_path',
  {
    title: 'SFTP Stat Path',
    description: 'Return remote path metadata through AT Terminal SFTP.',
    inputSchema: pathSchema
  },
  async (input) => textResult(await bridge.sftpStatPath(input))
);

server.registerTool(
  'sftp_read_file',
  {
    title: 'SFTP Read File',
    description: 'Read bounded UTF-8 text from a remote file through AT Terminal SFTP.',
    inputSchema: { ...pathSchema, maxBytes: z.number().int().positive().optional() }
  },
  async (input) => textResult(await bridge.sftpReadFile(input))
);

server.registerTool(
  'sftp_write_file',
  {
    title: 'SFTP Write File',
    description: 'Write UTF-8 text to a remote file after AT Terminal write authorization.',
    inputSchema: { ...pathSchema, content: z.string(), overwrite: z.boolean().optional() }
  },
  async (input) => textResult(await bridge.sftpWriteFile(input))
);

server.registerTool(
  'sftp_create_file',
  {
    title: 'SFTP Create File',
    description: 'Create a new remote file through AT Terminal SFTP.',
    inputSchema: { ...pathSchema, content: z.string().optional() }
  },
  async (input) => textResult(await bridge.sftpCreateFile(input))
);

server.registerTool(
  'sftp_create_directory',
  {
    title: 'SFTP Create Directory',
    description: 'Create a new remote directory through AT Terminal SFTP.',
    inputSchema: pathSchema
  },
  async (input) => textResult(await bridge.sftpCreateDirectory(input))
);

function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
