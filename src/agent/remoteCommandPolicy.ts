/**
 * Confirmation policy for `run_remote_command`.
 *
 * The caller may be an agent acting on injected instructions, so a blocklist is the wrong
 * shape: anything it fails to describe runs unprompted. The gate is an allowlist of read-only
 * commands; everything else is confirmed by a human. `looksDestructive` survives only as a
 * warning banner on the confirmation dialog and never decides whether to prompt.
 *
 * A pipeline of read-only stages is still read-only, so `|` is allowed as long as every stage
 * clears the same allowlist. That is not a hole in the allowlist: nothing runs that could not
 * have run on its own line.
 */

/**
 * Any of these turns one stage into several, or redirects output into a file, so the
 * allowlisted head of the stage stops being a description of what will run. `|` is deliberately
 * absent: what makes a pipe dangerous is what sits on either end of it, and every end is
 * checked separately below.
 */
const SHELL_CONTROL_CHARACTERS = /[&;<>`$(){}\n\r\\]/;

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

/** One stage of a pipeline: a single command, with no way to reach a second one. */
function isReadOnlyPipelineStage(stage: string): boolean {
  const trimmed = stage.trim();
  if (!trimmed || SHELL_CONTROL_CHARACTERS.test(trimmed)) {
    return false;
  }
  const [name, ...args] = trimmed.split(/\s+/);
  return READ_ONLY_COMMANDS.get(name)?.(args) ?? false;
}

/**
 * A pipeline is auto-approved only when *every* stage is independently allowlisted, so
 * `cat x | grep y` passes while `cat x | sh` does not.
 *
 * Stages are cut on `|` without lexing quotes, and that only ever costs an extra prompt: a stage
 * the shell will really run starts right after an unquoted `|`, so it always begins a naive stage
 * too, and a head that hides behind quotes (`r"m" -rf /`) stops matching an allowlist key at all.
 * The reverse — a dangerous command that the cut makes look read-only — cannot happen, because
 * the cut only ever adds stages that must also pass. `grep "a|b" file` is the price: harmless,
 * but confirmed.
 */
export function isReadOnlyAllowlistedCommand(command: string): boolean {
  const trimmed = command.trim();
  // `||` is "run the second one if the first fails", not a pipe. Splitting would leave an empty
  // stage, which fails anyway; rejecting it by name keeps that from looking like a coincidence.
  if (!trimmed || trimmed.includes('||')) {
    return false;
  }
  return trimmed.split('|').every((stage) => isReadOnlyPipelineStage(stage));
}

/**
 * Advisory only. This is the original blocklist regex, kept because a red banner on shapes it
 * does recognise is worth something; it is not consulted when deciding whether to prompt.
 */
export function looksDestructive(command: string): boolean {
  return /\b(rm\s+-[^\n]*r|mkfs|shutdown|reboot|poweroff|dd\s+if=)/i.test(command);
}
