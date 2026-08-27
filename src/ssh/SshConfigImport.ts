import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '../config/schema';

/**
 * The fields of a ServerConfig that an OpenSSH config entry can fill in. The caller
 * generates `id`/`createdAt`/`updatedAt` and lets the user review the rest in the
 * server form before anything is saved. Parsing never touches the network.
 */
export interface SshConfigServerDraft {
  label: string;
  host: string;
  port: number;
  username?: string;
  /**
   * `privateKey` when the entry names an IdentityFile; `agent` otherwise, because an
   * OpenSSH config never stores a password and key-less entries rely on the agent or
   * default keys.
   */
  authType: Extract<ServerConfig['authType'], 'privateKey' | 'agent'>;
  privateKeyPath?: string;
}

export interface SshConfigProxyJumpHop {
  host: string;
  username?: string;
  port?: number;
}

export interface SshConfigImportEntry {
  /** Host alias exactly as written in the config file. */
  alias: string;
  draft: SshConfigServerDraft;
  /**
   * First ProxyJump hop, if any. The caller resolves it to a saved server's
   * `jumpHostId` (or imports the hop as its own server first). Extra hops are dropped
   * with a warning because ServerConfig models a single jump host.
   */
  proxyJump?: SshConfigProxyJumpHop;
}

export interface SshConfigImportResult {
  entries: SshConfigImportEntry[];
  warnings: string[];
}

export interface SshConfigImportOptions {
  /** Base directory for `~` expansion in IdentityFile paths; defaults to os.homedir(). */
  homeDir?: string;
}

interface HostBlock {
  aliases: string[];
  /** Lowercased keyword -> first value seen, matching OpenSSH's first-wins rule. */
  values: Map<string, string>;
}

/**
 * Parses `Host` entries out of an OpenSSH client config (`~/.ssh/config`). Only the
 * keywords a ServerConfig can represent are read (HostName, User, Port, IdentityFile,
 * ProxyJump); everything else is ignored. Wildcard and negated host patterns are
 * skipped -- they are matching rules, not concrete servers.
 */
export function parseSshConfig(content: string, options: SshConfigImportOptions = {}): SshConfigImportResult {
  const homeDir = options.homeDir ?? homedir();
  const warnings: string[] = [];
  const entries: SshConfigImportEntry[] = [];

  for (const block of collectHostBlocks(content)) {
    for (const alias of block.aliases) {
      if (isWildcardPattern(alias)) {
        continue;
      }
      entries.push(buildEntry(alias, block.values, homeDir, warnings));
    }
  }

  return { entries, warnings };
}

function collectHostBlocks(content: string): HostBlock[] {
  const blocks: HostBlock[] = [];
  let current: HostBlock | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const parsed = splitKeyValue(line);
    if (!parsed) {
      continue;
    }
    const [keyword, value] = parsed;

    if (keyword === 'host') {
      current = { aliases: tokenize(value), values: new Map() };
      blocks.push(current);
      continue;
    }
    if (keyword === 'match') {
      // Match blocks are conditional rules, not servers; stop attributing keywords
      // to the previous Host until the next one starts.
      current = undefined;
      continue;
    }
    if (current && !current.values.has(keyword)) {
      current.values.set(keyword, value);
    }
  }

  return blocks;
}

function buildEntry(
  alias: string,
  values: Map<string, string>,
  homeDir: string,
  warnings: string[]
): SshConfigImportEntry {
  const identityFile = values.has('identityfile') ? expandHome(unquote(values.get('identityfile')!), homeDir) : undefined;

  let port = 22;
  const rawPort = values.get('port');
  if (rawPort !== undefined) {
    const parsedPort = Number.parseInt(rawPort, 10);
    if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
      port = parsedPort;
    } else {
      warnings.push(`Host "${alias}": ignored invalid Port "${rawPort}"; using 22.`);
    }
  }

  const draft: SshConfigServerDraft = {
    label: alias,
    host: unquote(values.get('hostname') ?? alias),
    port,
    username: values.has('user') ? unquote(values.get('user')!) : undefined,
    authType: identityFile ? 'privateKey' : 'agent',
    privateKeyPath: identityFile
  };

  return {
    alias,
    draft,
    proxyJump: parseProxyJump(alias, values.get('proxyjump'), warnings)
  };
}

function parseProxyJump(
  alias: string,
  value: string | undefined,
  warnings: string[]
): SshConfigProxyJumpHop | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = unquote(value);
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return undefined;
  }

  const hops = trimmed.split(',').map((hop) => hop.trim()).filter(Boolean);
  if (hops.length === 0) {
    return undefined;
  }
  if (hops.length > 1) {
    warnings.push(
      `Host "${alias}": ProxyJump has ${hops.length} hops; only the first hop "${hops[0]}" was imported and the rest were truncated.`
    );
  }

  const hop = parseProxyJumpHop(hops[0]);
  if (!hop) {
    warnings.push(`Host "${alias}": could not parse ProxyJump hop "${hops[0]}"; it was skipped.`);
    return undefined;
  }
  return hop;
}

function parseProxyJumpHop(hop: string): SshConfigProxyJumpHop | undefined {
  // [user@]host[:port], with IPv6 hosts in brackets.
  const match = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:@\s]+)(?::(\d{1,5}))?$/.exec(hop);
  if (!match) {
    return undefined;
  }
  const [, username, host, rawPort] = match;
  const port = rawPort === undefined ? undefined : Number.parseInt(rawPort, 10);
  if (port !== undefined && (port < 1 || port > 65535)) {
    return undefined;
  }
  return {
    host: host.replace(/^\[|\]$/g, ''),
    username: username || undefined,
    port
  };
}

function splitKeyValue(line: string): [string, string] | undefined {
  const match = /^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  return [match[1].toLowerCase(), stripTrailingComment(match[2]).trim()];
}

function stripTrailingComment(value: string): string {
  // OpenSSH only treats whole lines as comments, but trailing ` # ...` is a common
  // hand-edit; dropping it loses nothing a ServerConfig could hold.
  const index = value.search(/\s+#/);
  return index === -1 ? value : value.slice(0, index);
}

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    tokens.push(match[1] ?? match[2]);
  }
  return tokens;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isWildcardPattern(alias: string): boolean {
  return alias.includes('*') || alias.includes('?') || alias.startsWith('!');
}

function expandHome(path: string, homeDir: string): string {
  if (path === '~') {
    return homeDir;
  }
  if (path.startsWith('~/')) {
    return join(homeDir, path.slice(2));
  }
  return path;
}
