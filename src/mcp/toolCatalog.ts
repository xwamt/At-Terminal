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

const WRITE_AUTHORIZATION_NOTE =
  'Unless the server is set to full trust, the user approves one directory at a time, so expect a dialog whenever the target directory changes; ' +
  'an approval never covers the whole server. Writes outside the directory the SFTP session was opened in ' +
  'are called out as such, sensitive paths (SSH keys, /etc, /usr, service units, sudoers, cron) always ask ' +
  'twice and are never remembered, and a permission-denied write is never retried with sudo. Full trust skips these write prompts.';

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
    description:
      'Run a non-interactive command on an AT Terminal SSH server. A confirmation dialog depends on the server trust level: untrusted always asks; limited trust uses a blocklist of state-changing programs (file writes, permissions, packages, services, docker exec/run, iptables -F, network transfers, editors, and interpreters such as sh and python) and skips the prompt when every stage misses that list; full trust never asks. awk/sed filters and read subcommands such as docker ps, kubectl get, virsh list, and iptables -L do not prompt under limited trust. Every stage of a pipeline or chain is checked against it. A command whose name cannot be read plainly—command substitution, file redirects, unclosed quotes—always asks under limited trust; quoted pipes and escapes inside arguments do not. Unknown commands are not on the blocklist and run without a prompt on a limited-trust or fully trusted server. Expect a human round-trip unless the server is fully trusted, and do not batch work into one shell line to avoid it. stdout/stderr each default to 64000 bytes (hard cap 256000); when truncated is true, narrow the command—do not dump whole configs (for example nginx -T).',
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
            'Optional max bytes to keep separately for stdout and stderr. Default 64000; values above 256000 are capped. Raise explicitly when a larger bounded capture is required.'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'sftp_list_directory',
    title: 'SFTP List Directory',
    description:
      'List a remote directory through the selected AT Terminal SFTP session. Returns at most maxEntries entries (default 500, hard cap 5000) plus truncated/total; when truncated, narrow the path or raise maxEntries.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: {
          type: 'string',
          description: 'Remote POSIX path.'
        },
        maxEntries: {
          type: 'number',
          description:
            'Optional max directory entries to return. Default 500; values above 5000 are capped.'
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
    description:
      'Read bounded UTF-8 text from a remote file through AT Terminal SFTP. Default maxBytes is 65536 (hard cap 262144); when truncated is true, read a smaller range or raise maxBytes explicitly—do not pull whole large configs by default.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...pathProperties,
        maxBytes: {
          type: 'number',
          description:
            'Optional max bytes to read. Default 65536; values above 262144 are capped.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'sftp_write_file',
    title: 'SFTP Write File',
    description:
      `Write UTF-8 text to a remote file after AT Terminal write authorization. ${WRITE_AUTHORIZATION_NOTE}`,
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
    description: `Create a new remote file through AT Terminal SFTP. ${WRITE_AUTHORIZATION_NOTE}`,
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
    description: `Create a new remote directory through AT Terminal SFTP. ${WRITE_AUTHORIZATION_NOTE}`,
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { ...pathProperties },
      required: ['path']
    }
  }
];
