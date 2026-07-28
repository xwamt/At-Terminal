import type { ToolCatalogEntry } from '@at-series/mcp-hub';

export const AT_TERMINAL_PLUGIN_ID = 'at.terminal' as const;

const sftpTargetProperties = {
  terminalId: {
    type: 'string',
    description: 'Connected AT Terminal terminal id.'
  },
  serverId: {
    type: 'string',
    description: 'Connected AT Terminal server id.'
  }
} as const;

const pathProperties = {
  ...sftpTargetProperties,
  path: {
    type: 'string',
    description: 'Remote POSIX path.'
  }
} as const;

export const AT_TERMINAL_TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: 'list_ssh_servers',
    title: 'List SSH Servers',
    description:
      'List AT Terminal SSH servers authorized for background connections without exposing credentials.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_terminal_context',
    title: 'Get Terminal Context',
    description:
      'Return focused, default connected, connected, and known AT Terminal SSH terminal contexts.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'run_remote_command',
    title: 'Run Remote SSH Command',
    description: 'Run a confirmed non-interactive command on an AT Terminal SSH server.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: {
          type: 'string',
          description:
            'Configured SSH server id, or active to use the connected active SSH terminal.'
        },
        command: {
          type: 'string',
          description: 'Non-interactive shell command to run remotely.'
        },
        cwd: {
          type: 'string',
          description: 'Optional POSIX working directory to cd into before running the command.'
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional timeout in milliseconds. Values above 120000 are capped.'
        },
        maxOutputBytes: {
          type: 'number',
          description:
            'Optional max bytes to keep separately for stdout and stderr. Values above 256000 are capped.'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'sftp_list_directory',
    title: 'SFTP List Directory',
    description: 'List a remote directory through the selected AT Terminal SFTP session.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: {
          type: 'string',
          description: 'Remote POSIX path.'
        }
      }
    }
  },
  {
    name: 'sftp_stat_path',
    title: 'SFTP Stat Path',
    description: 'Return remote path metadata through AT Terminal SFTP.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: { ...pathProperties },
      required: ['path']
    }
  },
  {
    name: 'sftp_read_file',
    title: 'SFTP Read File',
    description: 'Read bounded UTF-8 text from a remote file through AT Terminal SFTP.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...pathProperties,
        maxBytes: {
          type: 'number',
          description: 'Optional max bytes to read.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'sftp_write_file',
    title: 'SFTP Write File',
    description: 'Write UTF-8 text to a remote file after AT Terminal write authorization.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ...pathProperties,
        content: {
          type: 'string',
          description: 'UTF-8 file content.'
        },
        overwrite: {
          type: 'boolean',
          description: 'Set true to replace an existing file.'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'sftp_create_file',
    title: 'SFTP Create File',
    description: 'Create a new remote file through AT Terminal SFTP.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ...pathProperties,
        content: {
          type: 'string',
          description: 'Optional UTF-8 file content.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'sftp_create_directory',
    title: 'SFTP Create Directory',
    description: 'Create a new remote directory through AT Terminal SFTP.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { ...pathProperties },
      required: ['path']
    }
  }
];
