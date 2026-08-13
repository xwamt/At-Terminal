/**
 * Confirmation policy for `run_remote_command`.
 *
 * The caller may be an agent acting on injected instructions, so a blocklist is the wrong
 * shape: anything it fails to describe runs unprompted. The gate is an allowlist of read-only
 * commands; everything else is confirmed by a human. `looksDestructive` survives only as a
 * warning banner on the confirmation dialog and never decides whether to prompt.
 */

/**
 * Any of these turns one command into several, or redirects output into a file, so the
 * allowlisted head of the line stops being a description of what will run.
 */
const SHELL_CONTROL_CHARACTERS = /[|&;<>`$(){}\n\r\\]/;

type ArgumentRule = (args: string[]) => boolean;

const acceptsAnyArguments: ArgumentRule = () => true;

const READ_ONLY_SYSTEMCTL_SUBCOMMANDS = new Set([
  'status',
  'is-active',
  'is-enabled',
  'is-failed',
  'list-units',
  'list-unit-files',
  'show',
  'cat'
]);

/** journalctl reads the journal, except for the handful of flags that rewrite or discard it. */
const JOURNALCTL_WRITE_FLAGS = [
  '--vacuum-size',
  '--vacuum-time',
  '--vacuum-files',
  '--rotate',
  '--flush',
  '--sync',
  '--relinquish-var',
  '--smart-relinquish-var',
  '--setup-keys',
  '--update-catalog'
];

/**
 * Binaries that cannot mutate remote state on their own. Commands that merely *look* like
 * reporters but take a write form are deliberately absent: `date -s` sets the clock,
 * `hostname <name>` renames the host, `ss -K` closes sockets, and `env`/`sudo` run arbitrary
 * programs through an allowlisted-looking prefix.
 */
const READ_ONLY_COMMANDS = new Map<string, ArgumentRule>([
  ['ls', acceptsAnyArguments],
  ['cat', acceptsAnyArguments],
  ['head', acceptsAnyArguments],
  ['tail', acceptsAnyArguments],
  ['wc', acceptsAnyArguments],
  ['stat', acceptsAnyArguments],
  ['file', acceptsAnyArguments],
  ['readlink', acceptsAnyArguments],
  ['realpath', acceptsAnyArguments],
  ['dirname', acceptsAnyArguments],
  ['basename', acceptsAnyArguments],
  ['grep', acceptsAnyArguments],
  ['egrep', acceptsAnyArguments],
  ['fgrep', acceptsAnyArguments],
  ['ps', acceptsAnyArguments],
  ['df', acceptsAnyArguments],
  ['du', acceptsAnyArguments],
  ['free', acceptsAnyArguments],
  ['uptime', acceptsAnyArguments],
  ['whoami', acceptsAnyArguments],
  ['id', acceptsAnyArguments],
  ['groups', acceptsAnyArguments],
  ['uname', acceptsAnyArguments],
  ['pwd', acceptsAnyArguments],
  ['which', acceptsAnyArguments],
  ['lsb_release', acceptsAnyArguments],
  ['netstat', acceptsAnyArguments],
  ['systemctl', (args) => {
    const subcommand = args.find((argument) => !argument.startsWith('-'));
    return subcommand !== undefined && READ_ONLY_SYSTEMCTL_SUBCOMMANDS.has(subcommand);
  }],
  ['journalctl', (args) =>
    !args.some((argument) => JOURNALCTL_WRITE_FLAGS.some((flag) => argument === flag || argument.startsWith(`${flag}=`)))]
]);

/** The command names that `agentCommandAutoApprove` can skip confirmation for. */
export const READ_ONLY_COMMAND_ALLOWLIST: readonly string[] = [...READ_ONLY_COMMANDS.keys()];

export function isReadOnlyAllowlistedCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL_CHARACTERS.test(trimmed)) {
    return false;
  }
  const [name, ...args] = trimmed.split(/\s+/);
  return READ_ONLY_COMMANDS.get(name)?.(args) ?? false;
}

/**
 * Advisory only. This is the original blocklist regex, kept because a red banner on shapes it
 * does recognise is worth something; it is not consulted when deciding whether to prompt.
 */
export function looksDestructive(command: string): boolean {
  return /\b(rm\s+-[^\n]*r|mkfs|shutdown|reboot|poweroff|dd\s+if=)/i.test(command);
}
