/**
 * Confirmation policy for `run_remote_command`.
 *
 * The gate is a blocklist: on a trusted server a command runs unprompted unless one of its stages
 * names a program that changes state, or unless it is written in a shape whose command names
 * cannot be read at all. An allowlist of read-only binaries was tried first and failed in use —
 * no such list keeps up with a real machine, so `top -bn1` and `last -n 10` were prompting.
 *
 * The cost of the reversal is not hidden: a program nobody thought to list runs without asking.
 * What keeps that from meaning "anything runs" is the interpreter and wrapper group below plus the
 * refusal to guess at unreadable shapes — `sh`, `python`, `awk`, `sed`, `xargs`, `env`, `sudo`,
 * `$(…)`, a redirect or a quoted name are exactly how an unknown command name becomes an
 * arbitrary one, and every one of them confirms.
 *
 * `looksDestructive` stays a separate, narrower signal for the dialog's warning banner. It answers
 * "would this destroy data", not "does this change state"; `mkdir /tmp/x` is gated here and not
 * flagged there, which is the intended difference.
 */

/**
 * Shapes that make the command names in a line unreadable, so no per-stage check of them can be
 * trusted. `$(` and a backtick run a command inside this one; `>` and `<` (so also `>>`, `2>`,
 * `<<` and process substitution) redirect into or out of files; a newline starts a second line; a
 * backslash escapes a character out of a name, which is all `\rm` is.
 */
const UNREADABLE_COMMAND = /[`<>\n\r\\]|\$\(/;

/** `|`, `;` and `&` each begin another command — and so do `&&` and `||`. Every one is checked. */
const STAGE_SEPARATOR = /[|;&]/;

/**
 * What a command name may look like once normalized. Anything else is confirmed instead of looked
 * up, because the shell reads it as something other than a plain name: `{r,x}m` is a brace
 * expansion, `/bin/r?` is a glob, `rm${IFS}-rf` hides separators in an expansion, `FOO=bar` is an
 * assignment prefix that pushes the real name one word to the right, and a bare leading `.` is the
 * `source` builtin.
 */
const NORMALIZED_COMMAND_NAME = /^[a-z0-9][a-z0-9._+-]*$/;

/** Answers "does this invocation need a human?" for one command name. */
type ArgumentRule = (args: readonly string[]) => boolean;

/** The command changes state however it is called, so the arguments cannot rescue it. */
const alwaysConfirms: ArgumentRule = () => true;

/** Creating, moving, rewriting, truncating or removing files. */
const FILESYSTEM_WRITE_COMMANDS = [
  'rm', 'rmdir', 'unlink', 'shred', 'mv', 'cp', 'install', 'ln', 'mkdir', 'touch', 'truncate',
  'dd', 'tee', 'rsync', 'patch', 'split', 'csplit', 'mktemp', 'mkfifo', 'mknod', 'fallocate',
  'rename', 'sponge', 'logrotate', 'updatedb'
];

/** Permission, ownership and attribute changes — silent until something stops working. */
const PERMISSION_COMMANDS = [
  'chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'umask', 'setcap', 'setfattr', 'chcon'
];

/** Archivers write their output to disk, and several of them replace the input in place. */
const ARCHIVE_COMMANDS = [
  'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', 'zstd', 'unzstd',
  '7z', '7za', 'cpio', 'ar', 'rar', 'unrar', 'lzma', 'compress', 'uncompress'
];

/** Partitioning, formatting, mounting and volume management: the least recoverable group here. */
const STORAGE_COMMANDS = [
  'mkfs', 'fsck', 'e2fsck', 'xfs_repair', 'xfs_growfs', 'tune2fs', 'resize2fs', 'fdisk', 'sfdisk',
  'cfdisk', 'gdisk', 'sgdisk', 'parted', 'partprobe', 'mount', 'umount', 'swapon', 'swapoff',
  'mkswap', 'lvcreate', 'lvremove', 'lvextend', 'lvreduce', 'vgcreate', 'vgremove', 'vgextend',
  'pvcreate', 'pvremove', 'mdadm', 'blockdev', 'hdparm', 'wipefs', 'badblocks', 'losetup',
  'cryptsetup', 'dmsetup', 'btrfs', 'zfs', 'zpool'
];

/** Signals, priorities and scheduling. Several of these also run a program of their own choosing. */
const PROCESS_CONTROL_COMMANDS = [
  'kill', 'pkill', 'killall', 'skill', 'renice', 'snice', 'nice', 'timeout', 'nohup', 'disown',
  'at', 'batch', 'fuser', 'setsid', 'chrt', 'ionice', 'taskset', 'flock', 'stdbuf'
];

/** Services, kernel modules, security policy and the power state of the host. */
const SERVICE_AND_KERNEL_COMMANDS = [
  'service', 'init', 'telinit', 'shutdown', 'reboot', 'poweroff', 'halt', 'kexec',
  'modprobe', 'insmod', 'rmmod', 'depmod', 'ldconfig', 'udevadm',
  'setenforce', 'semanage', 'restorecon', 'setsebool', 'aa-enforce', 'aa-complain', 'aa-disable',
  'loginctl', 'machinectl', 'busctl', 'dbus-send', 'gdbus',
  'nginx', 'apachectl', 'apache2ctl', 'httpd', 'supervisorctl', 'pm2', 'forever'
];

/**
 * Interpreters and execution wrappers. This is the group that keeps a blocklist meaningful: an
 * unlisted binary can only be reached by name, but every entry here turns an argument into a
 * program. `awk` and `sed` are here despite reading well — `sed -i` edits in place and `awk` has
 * `system()` and `print > file`.
 */
const INTERPRETER_AND_WRAPPER_COMMANDS = [
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'csh', 'tcsh', 'fish', 'busybox', 'toybox',
  'python', 'python2', 'python3', 'perl', 'ruby', 'node', 'nodejs', 'deno', 'bun', 'php', 'lua',
  'tclsh', 'expect', 'rscript', 'julia', 'erl', 'elixir', 'iex', 'ghc', 'runghc', 'swift',
  'awk', 'gawk', 'mawk', 'nawk', 'sed', 'xargs', 'parallel',
  'env', 'sudo', 'sudoedit', 'su', 'doas', 'pkexec', 'runuser', 'chroot', 'nsenter', 'unshare',
  'setarch', 'runcon', 'eval', 'exec', 'source', 'command', 'builtin', 'time',
  'watch', 'script', 'screen', 'tmux', 'byobu',
  'make', 'cmake', 'ninja', 'gcc', 'g++', 'cc', 'clang', 'clang++', 'javac', 'java', 'mvn',
  'gradle', 'ant', 'dotnet', 'rustc', 'npx', 'pnpx',
  'ansible', 'puppet', 'chef-client', 'salt', 'salt-call', 'terraform', 'pulumi', 'pdsh', 'clush'
];

/** Package managers install and remove software, and most run maintainer scripts as root. */
const PACKAGE_MANAGER_COMMANDS = [
  'apt', 'apt-get', 'apt-key', 'aptitude', 'add-apt-repository', 'dpkg', 'dpkg-reconfigure',
  'debconf-set-selections', 'update-alternatives', 'yum', 'dnf', 'rpm', 'zypper', 'pacman', 'apk',
  'snap', 'flatpak', 'brew', 'port', 'pip', 'pip2', 'pip3', 'pipx', 'npm', 'yarn', 'pnpm', 'gem',
  'cargo', 'go', 'composer', 'conda', 'mamba', 'poetry', 'bundle'
];

/** Transfers pull code onto the host; remote execution moves the same problem to another machine. */
const NETWORK_TRANSFER_COMMANDS = [
  'curl', 'wget', 'scp', 'sftp', 'ftp', 'lftp', 'tftp', 'nc', 'ncat', 'netcat', 'socat',
  'ssh', 'telnet', 'rlogin', 'rsh', 'rclone', 's3cmd', 'aws', 'gcloud', 'az'
];

/** Accounts, groups and the files that decide who may become root. */
const ACCOUNT_COMMANDS = [
  'useradd', 'adduser', 'usermod', 'userdel', 'deluser', 'groupadd', 'groupmod', 'groupdel',
  'passwd', 'chpasswd', 'chage', 'visudo', 'newgrp', 'gpasswd', 'chsh', 'chfn', 'vipw', 'vigr',
  'pam-auth-update', 'authconfig'
];

/** Firewall, routing and interface state. `ip`, `ifconfig`, `route` and `ethtool` are ruled below. */
const NETWORK_CONFIG_COMMANDS = [
  'iptables', 'ip6tables', 'iptables-restore', 'ip6tables-restore', 'nft', 'ipset', 'ipvsadm',
  'firewall-cmd', 'ufw', 'tc', 'brctl', 'arp', 'conntrack', 'nmcli', 'nmtui', 'netplan',
  'dhclient', 'resolvectl', 'wpa_cli'
];

/**
 * Container and orchestration clients. Read subcommands such as `docker ps` confirm too: the
 * write and read forms differ only by a word, and a client that can `exec` into a container is a
 * shell by another name.
 */
const CONTAINER_COMMANDS = [
  'docker', 'docker-compose', 'podman', 'podman-compose', 'nerdctl', 'kubectl', 'oc', 'crictl',
  'ctr', 'helm', 'lxc', 'lxc-attach', 'virsh', 'vagrant', 'minikube', 'k3s'
];

/** Editors and pagers: all of them can run a shell (`:!`, `!`, `v`), and most can write a file. */
const EDITOR_AND_PAGER_COMMANDS = [
  'vi', 'vim', 'view', 'rvim', 'rview', 'vimdiff', 'nvim', 'nano', 'pico', 'emacs', 'emacsclient',
  'ed', 'ex', 'joe', 'micro', 'mcedit', 'mc', 'ncdu', 'less', 'more', 'most', 'pg', 'man', 'info'
];

/** Debuggers and tracers attach to live processes, write dumps, and several execute code. */
const TRACING_COMMANDS = [
  'gdb', 'strace', 'ltrace', 'perf', 'tcpdump', 'tshark', 'dumpcap', 'bpftrace', 'bpftool',
  'stap', 'sysdig', 'nmap', 'masscan'
];

/** Database and message clients: their query languages write, and several have a shell escape. */
const DATA_STORE_COMMANDS = [
  'mysql', 'mysqladmin', 'mysqldump', 'psql', 'pg_ctl', 'pg_dump', 'pg_restore', 'sqlite3',
  'redis-cli', 'mongo', 'mongosh', 'mongodump', 'influx', 'clickhouse-client', 'etcdctl'
];

/** Boot, initramfs and firmware: a mistake here does not survive to the next boot to be fixed. */
const BOOT_COMMANDS = [
  'update-grub', 'grub-install', 'grub2-install', 'grub-mkconfig', 'grub2-mkconfig', 'dracut',
  'mkinitrd', 'update-initramfs', 'efibootmgr', 'fwupdmgr'
];

/** Version control other than `git`, which has its own rule. All of them rewrite a working copy. */
const VERSION_CONTROL_COMMANDS = ['svn', 'hg', 'bzr', 'cvs'];

/** Crypto material, mail and other people's terminals: state that lives outside the filesystem. */
const OTHER_STATE_CHANGE_COMMANDS = [
  'openssl', 'gpg', 'gpg2', 'keytool', 'certbot', 'ssh-keygen', 'ssh-copy-id', 'ssh-add',
  'ssh-agent', 'mail', 'mailx', 'sendmail', 'wall', 'write', 'logger'
];

const READ_ONLY_SYSTEMCTL_SUBCOMMANDS = new Set([
  'status', 'is-active', 'is-enabled', 'is-failed', 'is-system-running', 'list-units',
  'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'list-jobs',
  'list-machines', 'show', 'show-environment', 'cat', 'get-default', 'help'
]);

/** `hostnamectl` / `timedatectl` / `localectl`: everything that writes is spelled `set-…`. */
const READ_ONLY_CTL_SUBCOMMANDS = new Set([
  'status', 'show', 'list-timezones', 'list-locales', 'list-keymaps', 'list-x11-keymap-models',
  'list-x11-keymap-layouts', 'list-x11-keymap-variants', 'list-x11-keymap-options', 'help'
]);

/** journalctl reads the journal, except for the handful of flags that rewrite or discard it. */
const JOURNALCTL_WRITE_FLAGS = [
  '--vacuum-size', '--vacuum-time', '--vacuum-files', '--rotate', '--flush', '--sync',
  '--relinquish-var', '--smart-relinquish-var', '--setup-keys', '--update-catalog'
];

/** `ip <object> <command>`: an object with no command, or with one of these, only reports. */
const READ_ONLY_IP_COMMANDS = new Set(['show', 'list', 'lst', 'get', 'save', 'help']);

/** `find` walks read-only until one of these actions is attached to what it finds. */
const FIND_WRITE_ACTIONS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0', '-fprintf'
]);

const DMESG_WRITE_FLAGS = new Set([
  '--clear', '--read-clear', '--console-on', '--console-off', '--console-level'
]);

/** `date` flags that take their value as the next word, so that word is not a time to set. */
const DATE_VALUE_FLAGS = new Set(['-d', '--date', '-r', '--reference', '-f', '--file']);

/** `git` global options that take their value as the next word, ahead of the subcommand. */
const GIT_VALUE_OPTIONS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix'
]);

/**
 * The `git` subcommands that only report. Everything else confirms, including the ones that merely
 * look harmless: `git branch -d`, `git tag x`, `git remote add` and `git config x y` all write, and
 * telling those apart from their listing forms is exactly the guessing this gate refuses to do.
 */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'annotate', 'describe', 'shortlog', 'whatchanged',
  'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'show-ref',
  'for-each-ref', 'merge-base', 'name-rev', 'count-objects', 'check-ignore', 'verify-commit',
  'grep', 'version', 'help'
]);

/** `ifconfig` reports with no operand at all; anything else names an interface to change. */
const IFCONFIG_READ_FLAGS = new Set(['-a', '-s', '-v']);

/** `ethtool` shows by default; every option that is not one of these queries writes to the device. */
const ETHTOOL_READ_FLAGS = new Set([
  '-i', '--driver', '-S', '--statistics', '-k', '--show-features', '--show-offload', '-g',
  '--show-ring', '-a', '--show-pause', '-c', '--show-coalesce', '-l', '--show-channels', '-T',
  '--show-time-stamping', '-P', '--show-permaddr', '-m', '--module-info', '-u', '--show-ntuple',
  '-d', '--register-dump', '-e', '--eeprom-dump', '--show-priv-flags', '--show-eee', '--show-fec',
  '-h', '--help', '--version'
]);

/** Only the named subcommands report; a missing subcommand confirms rather than being guessed at. */
function onlyTheseSubcommandsRead(readSubcommands: ReadonlySet<string>): ArgumentRule {
  return (args) => {
    const subcommand = args.find((argument) => !argument.startsWith('-'));
    return subcommand === undefined || !readSubcommands.has(subcommand);
  };
}

const journalctlRewritesJournal: ArgumentRule = (args) =>
  args.some((argument) =>
    JOURNALCTL_WRITE_FLAGS.some((flag) => argument === flag || argument.startsWith(`${flag}=`)));

const ipChangesNetworkState: ArgumentRule = (args) => {
  const operands = args.filter((argument) => !argument.startsWith('-'));
  if (operands.length < 2) {
    // `ip`, `ip -br a`, `ip route`: an object on its own defaults to showing it.
    return false;
  }
  return !READ_ONLY_IP_COMMANDS.has(operands[1]);
};

/** `-K` closes matching sockets, and short options bundle (`ss -tK`). `--kill` is the long form. */
const ssClosesSockets: ArgumentRule = (args) =>
  args.some((argument) => argument === '--kill' || /^-[^-]*K/.test(argument));

const findActsOnWhatItFinds: ArgumentRule = (args) =>
  args.some((argument) => FIND_WRITE_ACTIONS.has(argument));

const dmesgClearsBuffer: ArgumentRule = (args) =>
  args.some((argument) => DMESG_WRITE_FLAGS.has(argument) || /^-[^-]*[CcDEn]/.test(argument));

/** Only `crontab -l` (optionally `-u <user> -l`) reads; every other form installs or drops jobs. */
const crontabDoesMoreThanList: ArgumentRule = (args) => {
  let listing = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-l') {
      listing = true;
      continue;
    }
    if (argument === '-u') {
      index += 1;
      continue;
    }
    return true;
  }
  return !listing;
};

/** `date -s`, `date --set` and the bare `MMDDhhmm` operand all set the clock; `+format` prints. */
const dateSetsClock: ArgumentRule = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-s' || argument === '--set' || argument.startsWith('--set=')) {
      return true;
    }
    if (argument.startsWith('+')) {
      continue;
    }
    if (DATE_VALUE_FLAGS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) {
      continue;
    }
    return true;
  }
  return false;
};

const hostnameRenamesHost: ArgumentRule = (args) =>
  args.some((argument) =>
    !argument.startsWith('-') || argument === '-F' || argument === '--file' || argument === '-b');

const sysctlWritesKey: ArgumentRule = (args) =>
  args.some((argument) =>
    argument === '-w' ||
    argument === '--write' ||
    argument === '-p' ||
    argument === '--load' ||
    argument === '--system' ||
    argument.includes('='));

const gitSubcommandWrites: ArgumentRule = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (GIT_VALUE_OPTIONS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) {
      continue;
    }
    return !READ_ONLY_GIT_SUBCOMMANDS.has(argument);
  }
  return true;
};

const ifconfigChangesInterface: ArgumentRule = (args) =>
  args.some((argument) => !IFCONFIG_READ_FLAGS.has(argument));

/** `route -n` prints the table; every write form (`add`, `del`, `flush`) is an operand. */
const routeChangesTable: ArgumentRule = (args) => args.some((argument) => !argument.startsWith('-'));

const ethtoolChangesDevice: ArgumentRule = (args) =>
  args.some((argument) => argument.startsWith('-') && !ETHTOOL_READ_FLAGS.has(argument));

/** `sort` is a filter until `-o` points it at a file, which it will happily overwrite. */
const sortWritesFile: ArgumentRule = (args) =>
  args.some((argument) => argument === '-o' || argument === '--output' || argument.startsWith('--output='));

/**
 * Commands whose most common form is read-only, so the whole name cannot be blocked without
 * bringing back the usability problem an allowlist had. Each rule decides from the arguments, and
 * each one confirms when it cannot tell.
 */
const ARGUMENT_RULED_COMMANDS: readonly [string, ArgumentRule][] = [
  ['systemctl', onlyTheseSubcommandsRead(READ_ONLY_SYSTEMCTL_SUBCOMMANDS)],
  ['hostnamectl', onlyTheseSubcommandsRead(READ_ONLY_CTL_SUBCOMMANDS)],
  ['timedatectl', onlyTheseSubcommandsRead(READ_ONLY_CTL_SUBCOMMANDS)],
  ['localectl', onlyTheseSubcommandsRead(READ_ONLY_CTL_SUBCOMMANDS)],
  ['journalctl', journalctlRewritesJournal],
  ['ip', ipChangesNetworkState],
  ['ss', ssClosesSockets],
  ['find', findActsOnWhatItFinds],
  ['dmesg', dmesgClearsBuffer],
  ['crontab', crontabDoesMoreThanList],
  ['date', dateSetsClock],
  ['hostname', hostnameRenamesHost],
  ['sysctl', sysctlWritesKey],
  ['git', gitSubcommandWrites],
  ['ifconfig', ifconfigChangesInterface],
  ['route', routeChangesTable],
  ['ethtool', ethtoolChangesDevice],
  ['sort', sortWritesFile]
];

function alwaysConfirming(names: readonly string[]): [string, ArgumentRule][] {
  return names.map((name): [string, ArgumentRule] => [name, alwaysConfirms]);
}

const BLOCKED_COMMANDS = new Map<string, ArgumentRule>([
  ...alwaysConfirming(FILESYSTEM_WRITE_COMMANDS),
  ...alwaysConfirming(PERMISSION_COMMANDS),
  ...alwaysConfirming(ARCHIVE_COMMANDS),
  ...alwaysConfirming(STORAGE_COMMANDS),
  ...alwaysConfirming(PROCESS_CONTROL_COMMANDS),
  ...alwaysConfirming(SERVICE_AND_KERNEL_COMMANDS),
  ...alwaysConfirming(INTERPRETER_AND_WRAPPER_COMMANDS),
  ...alwaysConfirming(PACKAGE_MANAGER_COMMANDS),
  ...alwaysConfirming(NETWORK_TRANSFER_COMMANDS),
  ...alwaysConfirming(ACCOUNT_COMMANDS),
  ...alwaysConfirming(NETWORK_CONFIG_COMMANDS),
  ...alwaysConfirming(CONTAINER_COMMANDS),
  ...alwaysConfirming(EDITOR_AND_PAGER_COMMANDS),
  ...alwaysConfirming(TRACING_COMMANDS),
  ...alwaysConfirming(DATA_STORE_COMMANDS),
  ...alwaysConfirming(BOOT_COMMANDS),
  ...alwaysConfirming(VERSION_CONTROL_COMMANDS),
  ...alwaysConfirming(OTHER_STATE_CHANGE_COMMANDS),
  ...ARGUMENT_RULED_COMMANDS
]);

/**
 * Families whose members are generated rather than enumerable: every filesystem ships its own
 * `mkfs.<fs>` and `fsck.<fs>`, distributions ship `python3.11` beside `python3`, and `systemd-*`,
 * `ansible-*` and `grub-*` are whole toolboxes.
 */
const BLOCKED_COMMAND_PATTERNS: readonly RegExp[] = [
  /^mkfs\..+$/,
  /^fsck\..+$/,
  /^(?:mount|umount)\..+$/,
  /^(?:python|perl|ruby|php|lua|node|pip|bash|tclsh)\d+(?:\.\d+)*$/,
  /^(?:gcc|g\+\+|cc|clang|clang\+\+)-\d+(?:\.\d+)*$/,
  /^(?:systemd|ansible|grub|grub2)-.+$/
];

/** Every command name the gate confirms on, whether always or under an argument rule. */
export const CONFIRMATION_REQUIRED_COMMANDS: readonly string[] = [...BLOCKED_COMMANDS.keys()];

function blockedRuleFor(name: string): ArgumentRule | undefined {
  const rule = BLOCKED_COMMANDS.get(name);
  if (rule) {
    return rule;
  }
  return BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(name)) ? alwaysConfirms : undefined;
}

/** `/usr/bin/RM` and `rm` are the same program; the blocklist is written in the second spelling. */
function normalizeCommandName(head: string): string {
  return head.slice(head.lastIndexOf('/') + 1).toLowerCase();
}

/** One stage of a pipeline or chain: a single command, checked by the name it will really run. */
function stageRequiresConfirmation(stage: string): boolean {
  const [head, ...args] = stage.split(/\s+/);
  // Quotes are ordinary inside arguments, but a quoted *name* (`"rm"`, `r''m`) exists to stop the
  // name from matching anything, so it is refused before the blocklist is consulted.
  if (/['"]/.test(head)) {
    return true;
  }
  const name = normalizeCommandName(head);
  if (!NORMALIZED_COMMAND_NAME.test(name)) {
    return true;
  }
  const rule = blockedRuleFor(name);
  if (rule) {
    return rule(args);
  }
  // Unlisted, but spelled as a path. A blocklist recognises names, and `/tmp/deploy.sh` is not a
  // name it could ever have been asked about, so the one thing it can say is "ask".
  return head.includes('/');
}

/**
 * True when `run_remote_command` must show its confirmation dialog even on a trusted server.
 *
 * Every stage of the line is checked, not just the first: `ls && rm -rf /` confirms because of the
 * second stage, while `ps aux | grep java` runs because neither stage is blocked. Splitting is
 * naive about quotes, which can only add stages — a stage the shell will really run always begins
 * right after an unquoted separator, so it always begins a naive stage too. The extra stages that
 * naive splitting invents (`grep "a|b" file`) can only cost a prompt, never grant one.
 */
export function requiresConfirmation(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || UNREADABLE_COMMAND.test(trimmed)) {
    return true;
  }
  const stages = trimmed
    .split(STAGE_SEPARATOR)
    .map((stage) => stage.trim())
    .filter((stage) => stage.length > 0);
  if (stages.length === 0) {
    return true;
  }
  return stages.some((stage) => stageRequiresConfirmation(stage));
}

/**
 * Advisory only, and deliberately narrower than the gate: it answers "would this destroy data",
 * which is what the red banner on the confirmation dialog claims. The blocklist above answers
 * "does this change state", so `mkdir /tmp/x` is gated without being flagged. Making the banner
 * follow the blocklist instead would light it up on every prompt a trusted server ever shows,
 * which is the same as not having it.
 */
export function looksDestructive(command: string): boolean {
  return /\b(rm\s+-[^\n]*r|mkfs|shutdown|reboot|poweroff|dd\s+if=)/i.test(command);
}
