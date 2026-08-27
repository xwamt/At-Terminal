# Limited-Trust Remote Command Policy Redesign

- Status: Implemented in AT Terminal MCP
- Date: 2026-08-25
- Scope: `run_remote_command` confirmation policy in limited-trust mode
- Implementation status: Shared `@at-series/command-policy` analyzers are the
  runtime source of truth. This plugin maps trust levels, confirmation UI, and
  MCP-only loading. JumpServer is a documented next-phase consumer.

## Summary

Replace the current blocklist and hand-written lexer with a deterministic,
fail-closed policy pipeline:

1. Parse the complete Shell script with `web-tree-sitter` and
   `tree-sitter-bash`.
2. Convert the syntax tree into a small policy IR.
3. Analyze every executable node with command-specific capability rules.
4. Automatically approve only scripts whose complete effect can be proven to
   be an ordinary read under the policy's command contracts.
5. Require confirmation for writes, controls, sensitive reads, parse failures,
   unsupported behavior, and any other unknown effect.

The MCP tool interface remains unchanged. `# Purpose:` stays a comment and
never grants authority.

Analyzers live in the public Apache-2.0 npm package
[`@at-series/command-policy@0.1.0`](https://www.npmjs.com/package/@at-series/command-policy).
This plugin pins that exact version (no `^`). The published TypeScript
contract is `docs/api.md` in the command-policy repository. This plugin
does not keep a parallel lexer or blocklist. It lazy-loads
`dist/policy-runtime.js` only in the MCP variant, maps `none` / `policy` /
`full` trust, and renders redacted confirmation evidence. The shared
library returns `allow` | `review` | `deny` and never shows UI, writes
logs, or executes commands.

## Consuming `@at-series/command-policy`

Install from the public npm registry. Pin the exact published version:

```json
{
  "dependencies": {
    "@at-series/command-policy": "0.1.0"
  }
}
```

```sh
npm install @at-series/command-policy@0.1.0
```

Do not use `^` or `~`, and do not use a `file:` sibling checkout in
released plugins. Package page:
https://www.npmjs.com/package/@at-series/command-policy

Public TypeScript contract: `docs/api.md` in the command-policy repository.
Import analyzers from the published
subpath entries (`/shell`, `/python`, `/sqlite`, `/mysql`, `/redis`,
`/build`). This plugin only maps `none` / `policy` / `full` trust onto
those decisions.

## Context and evidence

The analyzed log is:

`~/.at-series/logs/antigravity-ide/agent-ops-2026-08-25-64929.jsonl`

It contains:

- 86 `run_remote_command` invocation records.
- 85 successful executions and one connection error.
- 70 successful commands beginning with a two-line
  `# Purpose: ...\n<command>` form.
- At least seven commands that plainly change state.

The log does not record whether a confirmation was displayed or which policy
rule caused it. The prompt count is therefore inferred from the command text
and the current policy code.

The current lexer returns `ok: false` for every newline. Limited-trust mode
maps every lexer failure to confirmation. Consequently, all 70 successful
commands with a `# Purpose:` line are expected to prompt before their real
command semantics are inspected. One later `tc -s ... show` query is also
expected to prompt because `tc` is currently blocked as a whole.

This produces an estimated 71 prompts for 85 successful executions. Roughly
64 of those commands are query or diagnostic operations by their visible
semantics, although some of those reads are sensitive under the policy agreed
below.

There is also a direct policy/documentation conflict:

- `skills/at-terminal-mcp/SKILL.md` requires every command to begin with a
  `# Purpose:` comment.
- `src/agent/shellCommandLexer.ts` rejects the newline needed to separate that
  comment from the command.

Other major sources of false confirmation are whole-command blocking for
`sudo`, `python3`, `sqlite3`, `curl`, and `tc`, even when their arguments
describe ordinary reads.

## Goals

- Automatically approve ordinary read and diagnostic commands in
  limited-trust mode.
- Analyze complete multi-line scripts, not only a single logical command.
- Preserve confirmation for all known writes and control operations.
- Preserve confirmation for explicitly sensitive reads.
- Preserve confirmation whenever the policy cannot prove the effect.
- Produce a stable reason code and source span for every confirmation.
- Keep the existing three trust modes and the existing MCP tool schema.
- Reuse mature open-source parsing and policy work where practical.

## Non-goals

- This policy is not an operating-system sandbox.
- It does not guarantee the behavior of a malicious executable that happens
  to use a trusted command name.
- It does not prove that a server honors HTTP method semantics.
- It does not make arbitrary Python, SQL, or Shell programs safe.
- It does not change untrusted or fully trusted mode behavior.
- It does not cache a user's approval for mutating commands.
- It does not use an LLM to make authorization decisions.

## Decisions confirmed with the user

1. Limited trust uses a proof-oriented rule:
   auto-approve only when static analysis can establish an ordinary read.
2. Explicitly sensitive reads still require confirmation.
3. Multi-line scripts may be auto-approved when every possible statement can
   be established as an ordinary read.
4. The MCP tool interface does not change.
5. The implementation will use a Shell AST rather than extending the existing
   lexer.
6. The parser and baseline rules will reuse open-source work from mature
   projects, with at-terminal-specific capability analyzers on top.
7. HTTP GET and HEAD are treated as reads according to the HTTP method
   contract, subject to sensitive-data and local-write checks.
8. Approval for commands requiring confirmation is not cached.
9. An optimized MCP-package increase of roughly 400–500 KB is acceptable;
   the design must enforce that ceiling and leave the base package unchanged.

## Threat model and meaning of "proof"

The policy makes a deterministic proof relative to explicit command
contracts. For example, the `systemctl status` contract is read-only while the
`systemctl restart` contract controls a service.

This is not an absolute proof of the remote runtime:

- A bare command may resolve through a modified `PATH`.
- An executable may have been replaced.
- Shell startup files, aliases, functions, Python module shadowing, database
  client startup files, or server-specific behavior can change semantics.
- A GET endpoint may violate normal HTTP semantics.

The policy assumes a non-compromised remote account and standard behavior for
recognized executables. Commands outside that model return `unknown` and
require confirmation. A hostile remote environment requires execution
isolation, which is outside this design.

## Open-source reuse

### Parser

Use `web-tree-sitter` with `tree-sitter-bash`, the same parser stack used by
large open-source agent CLIs including Qwen Code and Gemini CLI.

The parser dependency and WASM grammar must be pinned to reviewed versions.
Parser initialization failure must produce `confirm`, never `allow`.

### Baseline policy code

Adapt the Apache-2.0 AST traversal and read-only command rules from:

- Qwen Code's `shellAstParser.ts`
- Gemini CLI's Shell parsing and command-safety utilities

These implementations are internal project modules rather than a stable
shared library. The design therefore ports and audits the relevant logic
instead of depending on a moving repository file. Required copyright,
license, and NOTICE text must be retained.

Their baseline handles common commands and Shell structures, but does not
fully cover at-terminal's remote-administration workload. The plugin still
needs focused analyzers for `sudo`, service tools, network administration,
database clients, HTTP clients, Python snippets, and sensitive resources.

New all-in-one capability engines surveyed during design were either newly
published, lightly adopted, implemented in another runtime, or licensed in a
way that makes direct embedding unattractive. They may supply test ideas but
must not become the core security boundary without a separate evaluation.

## Size and loading budget

The policy must remain proportionate to a small VS Code extension. A local
in-memory production build measured the current MCP `extension.js` at about
322 KB raw and 93 KB gzip-compressed.

Measurements of the proposed production assets were:

- `web-tree-sitter` production JavaScript and runtime WASM: about 355 KB raw
  and 112 KB gzip-compressed;
- `tree-sitter-bash.wasm`: about 1.36 MB raw and 185 KB gzip-compressed;
- `tree-sitter-python.wasm`: about 458 KB raw and 69 KB gzip-compressed;
- a focused SQLite parser: approximately 115 KB raw and at most about 69 KB
  as a complete compressed package.

Gzip is only a proxy for VSIX ZIP compression, so the packaged VSIX remains
the authoritative measurement. The expected optimized increase is roughly
400–500 KB compressed and 2.3 MB installed.

The implementation must enforce these constraints:

- The normal `extension.js` bundle must not absorb the policy runtime.
- Build the policy as a separate internal bundle loaded only for a
  limited-trust `run_remote_command` invocation.
- Ship the policy bundle and parser assets only in the MCP package variant;
  the base variant has zero policy-engine size increase.
- Keep parser packages as build dependencies. Bundle only production
  JavaScript and copy only the required WASM files.
- Never package parser source trees, debug WASM, generated C parsers, native
  bindings, tests, or complete parser `node_modules`.
- Load Bash support first. Load Python and SQLite analysis only when the
  command actually contains those embedded languages.
- Add package tests that fail if the MCP VSIX grows by more than 500 KB
  compressed, installed policy assets exceed 2.5 MB, or the base variant
  changes because of this feature.

Large generic dependencies are explicitly out of scope. In particular, a
multi-dialect parser with an unpacked size measured in tens of megabytes must
not be introduced merely to classify the small supported SQL subset.

## Proposed architecture

### Policy API

Replace an internal boolean-only answer with a structured result:

```ts
type PolicyAction = 'allow' | 'confirm';

interface PolicyDecision {
  action: PolicyAction;
  effects: Effect[];
  reasons: PolicyReason[];
  evidence: PolicyEvidence[];
  policyVersion: string;
}
```

This is an internal API change. The MCP request and response schema remain
unchanged.

Every evidence item identifies:

- the analyzer and rule ID,
- the normalized command,
- the capability/effect,
- the source span in the original script,
- a redacted human explanation.

Authorization must not use numeric confidence. A result is either established
by a rule or unknown.

### Decision pipeline

1. Resolve the server and trust level.
2. For untrusted mode, require confirmation without running the new policy.
3. For fully trusted mode, auto-approve without running the new policy.
4. For limited trust, parse the original command as a complete Shell script.
5. Reject a tree containing `ERROR`, `MISSING`, unsupported nodes, uncovered
   source text, or exceeded resource limits.
6. Convert the supported syntax tree into a typed policy IR.
7. Resolve statically knowable command names, arguments, assignments, paths,
   and embedded source strings.
8. Analyze each leaf invocation through the command analyzer registry.
9. Propagate effects through every compound Shell node.
10. Apply the sensitive-resource policy.
11. Aggregate the most restrictive result.
12. Return `allow` only when every possible effect is an ordinary read or
    harmless process-local operation.

### Resource limits

The evaluator must have bounded:

- input bytes,
- AST node count,
- nesting depth,
- recursive embedded-language depth,
- number of statically expanded alternatives,
- analysis time.

Exceeding a limit returns a dedicated `analysis-limit` reason and requires
confirmation.

Every embedded-language parser follows the same completeness rule as the
Shell parser: syntax errors, recovery nodes, uncovered source, initialization
failure, or unsupported syntax return `unknown`.

### Parser dialect

SSH `exec` uses the remote account's login Shell, and the current server
configuration does not declare its dialect. The policy therefore
automatically approves only an audited POSIX/Bash-compatible syntax subset at
the top level.

- A static `sh -c '<script>'` string is recursively parsed using the POSIX
  subset.
- A static `bash -c '<script>'` string is recursively parsed using the audited
  Bash subset.
- Other Shell dialects and non-static inner scripts require confirmation.

### Policy context

The evaluator receives internal context in addition to the command:

- requested remote `cwd`,
- trust level,
- known server metadata,
- policy and rule-pack versions.

Passing `cwd` internally does not change the MCP schema. It is needed to
classify relative paths and sensitive resources correctly.

## Policy IR

The policy IR contains only syntax whose semantics the evaluator explicitly
handles:

- script/list,
- simple command,
- pipeline,
- `&&` / `||`,
- conditional and case branches,
- loops,
- subshell,
- command and process substitution,
- redirects and heredocs,
- assignments,
- function definitions,
- background execution.

Unknown Tree-sitter node types do not silently disappear. Conversion fails
closed and produces confirmation.

Comments are retained only for source positions and audit display. In
particular, `# Purpose:` never changes a capability or decision.

## Effect model

Each analyzed operation describes:

- access: `process-local`, `read`, `write`, `control`, or `unknown`;
- resource: filesystem, process, service, network, database, Shell, or other;
- sensitivity: normal or sensitive;
- modifiers: elevated, detached, or dynamic;
- source evidence.

Decision rules in limited-trust mode:

- Ordinary reads and harmless process-local operations are allowed.
- Sensitive reads are confirmed.
- Writes and controls are confirmed.
- Unknown or dynamic effects are confirmed.
- Detached/background effects are confirmed.
- Elevation alone is not a reason to confirm; the elevated child operation is
  still fully analyzed.

The last rule is required to allow operations such as
`sudo systemctl status` and `sudo grep <ordinary-file>` without turning
`sudo` into a blanket bypass.

## Shell effect propagation

### Lists, branches, and loops

Newlines, semicolons, `&&`, `||`, conditions, case arms, and loop bodies are
all possible execution paths. Their effects are unioned. A non-read effect in
any reachable path makes the complete script require confirmation.

Function bodies are analyzed conservatively when present rather than relying
on an incomplete static call graph.

### Pipelines and data flow

Every stage is analyzed. The pipeline also propagates the sensitivity of its
data:

- ordinary logs through `grep | tail` remain ordinary reads;
- sensitive input remains sensitive after formatting or filtering;
- data flowing to a network upload, file writer, or interpreter requires
  confirmation.

### Redirects

- `>`, `>>`, and writable `<>` to an ordinary path are filesystem writes.
- `>/dev/null`, descriptor duplication, and descriptor closing are harmless
  process-local operations.
- `< path` is a read and participates in sensitive-path analysis.
- heredoc and here-string content is input, but substitutions inside it are
  recursively analyzed.

### Substitutions and nested scripts

Command substitution, backticks, subshells, and process substitution are
recursively analyzed. Static `sh -c` and `bash -c` source is recursively
parsed. `eval`, `source`, non-static code strings, and dynamic command names
are unknown.

### Variables and expansions

Literal assignments may be tracked within the script. Substitutions used to
compute an argument also contribute their own effects.

If an unresolved value controls any of the following, the invocation is
unknown:

- executable name,
- subcommand or safety-critical option,
- write destination,
- sensitive-resource path,
- HTTP method or destination,
- SQL source,
- embedded interpreter source.

Globs may be accepted only when their lexical root is known to be ordinary.
For example, `/var/log/*.log` can be analyzed while `~/*` may include
credentials and is not automatically approved.

### Background processes

`&`, `nohup`, daemonization, and other detached execution require
confirmation even when the child command appears read-only, because the
process can outlive the bounded tool invocation.

## Command analyzer registry

Analyzers are deterministic, versioned modules. Each analyzer accepts a
normalized invocation and policy context, and returns effects plus evidence.
Unknown flags or unsupported forms return `unknown`.

### Executable normalization

- Recognize audited bare command names and trusted system paths.
- Normalize versioned aliases only through explicit rules.
- Treat relative executables and absolute executables outside approved system
  locations as unknown.
- Do not trust a basename extracted from an arbitrary path such as
  `/tmp/systemctl`.

### Basic observers and filters

Port the established Qwen/Gemini rules for common readers and filters,
including:

- `cat`, `head`, `tail`, `grep`, `rg`,
- `ls`, `stat`, `file`, `pwd`, `uname`, `id`,
- `ps`, `ss`, `df`, `du`,
- `sort`, `uniq`, `cut`, `tr`, `jq`,
- safe forms of `find`, `sed`, `awk`, and `git`.

Command-specific rules must detect:

- `find -delete`, writable output options, and nested execution;
- `sed -i`, write commands, and execution commands;
- `awk system()`, output redirection, and pipes to commands;
- output-file flags such as `sort -o`.

All file operands participate in sensitive-path analysis.

### Wrappers

Unwrap and recursively analyze recognized static forms of:

- `sudo`,
- `env`,
- `command` and `builtin`,
- `nice`, `ionice`, `timeout`, and `stdbuf`,
- `busybox` applets,
- static `sh -c` and `bash -c`.

Unknown wrapper flags, interactive Shells, preserved hostile environments, or
dynamic child commands require confirmation.

`xargs` and similar tools begin as unknown unless the implementation can
prove both a fixed child command and safe placement of all input-derived
arguments.

### Services, containers, and network administration

Examples of read contracts:

- `systemctl status/show/list-*/is-active/is-enabled/is-failed`;
- `journalctl` bounded reads;
- `tc -s ... show`;
- `ip ... show`;
- `iptables -L/-S`;
- `nft list`;
- `docker ps/inspect/logs/stats/top/version/info`;
- `kubectl get/describe/logs/api-resources/version`;
- `virsh list/dominfo`.

Examples requiring confirmation:

- service start, stop, restart, reload, enable, disable, edit, and property
  changes;
- network add, delete, replace, set, and flush;
- container or cluster run, exec, apply, delete, scale, and configuration
  changes.

Unknown subcommands and flags are not assumed to be reads.

### SQL clients

The first release recognizes static inline queries passed to `sqlite3`. Parse
every statement with a size-audited SQLite parser; regular expressions may
supplement but must not replace SQL parsing.

`psql`, `mysql`, and SQL loaded from remote files remain `unknown` until each
dialect has a separately reviewed analyzer that stays within the package
budget. A generic all-dialect SQL package is not part of this design.

Potentially approvable statements include:

- pure `SELECT`,
- read-only `WITH ... SELECT`,
- `SHOW`,
- `EXPLAIN`,
- explicitly read-only PRAGMA and client metadata commands.

Confirmation is required for:

- all DML, DDL, transaction-control writes, and writable PRAGMA;
- writable CTEs;
- `SELECT INTO`, locking clauses, and known effectful functions;
- output-file and Shell meta-commands;
- extension loading;
- dynamic SQL;
- remote script files whose content is unavailable to the local evaluator.

Function calls use an allowlist of known pure built-ins. Unknown or
user-defined functions are not assumed pure.

### HTTP clients

For `curl` and related clients, GET and HEAD are reads by policy contract when
all relevant arguments are static.

Confirmation is required for:

- POST, PUT, PATCH, DELETE, CONNECT, or an unknown method;
- body, form, upload, and writable output options;
- config or netrc files whose content cannot be inspected;
- credential-bearing headers, cookies, URL userinfo, or other explicitly
  sensitive authentication material;
- sensitive destinations such as cloud metadata endpoints;
- unresolved method, URL, or option values.

Network data derived from a sensitive source remains sensitive even when the
HTTP method itself is GET.

### Python

To avoid retaining the blanket confirmation seen in the log, static
`python -c` source is parsed with a pinned `tree-sitter-python` grammar and a
strict effect analyzer.

The initial safe subset may include:

- pure expressions and local control flow;
- known standard-library formatting and parsing;
- read-only file APIs;
- static read-only SQL operations;
- HTTP GET/HEAD calls;
- recursively analyzable literal subprocess invocations;
- explicitly approved pure modules such as `python -m json.tool`.

Confirmation is required for:

- file write modes and write APIs;
- database writes, commits, and dynamic SQL;
- non-read HTTP methods;
- unresolvable subprocesses;
- `exec`, `eval`, dynamic import, reflection, and bytecode loading;
- unknown imports, calls, decorators, or dynamic attributes.

Because Python imports can execute code and can be shadowed by local modules,
the analyzer's approved standard-library imports are part of the same
non-compromised-runtime command contract described in the threat model.

Other interpreters initially support only narrow, explicit pure operations.
Everything else remains unknown until an analyzer with adequate tests is
added.

## Sensitive-read policy

Sensitive reads are separate from write detection and always require
confirmation in limited-trust mode.

The classifier operates on structured operands, not the raw command string.
Initial categories include:

- password and shadow databases;
- private keys and SSH credential material;
- cloud, Kubernetes, package-manager, and application credential stores;
- `.env` and known secret files;
- authentication headers, cookies, URL credentials, and token literals;
- environment variables with credential-like names;
- SQL columns and expressions containing password, secret, token, API key,
  private key, or credential material.

SQL classification is column-aware where possible. Merely naming an
`api_key` table is not sufficient to mark metadata columns sensitive, while
`SELECT *` from a known secret-bearing table is sensitive.

Broad configuration reads and contextual filters such as `grep -A` require
confirmation when the selected range can include credentials.

## Trust-mode behavior

### Untrusted

Always require confirmation, preserving current behavior.

### Limited trust

Run the new evaluator. Allow only a fully established ordinary read. Confirm
everything else.

This intentionally changes the current treatment of unknown commands:
unknown commands no longer run automatically merely because they are absent
from a blocklist.

### Fully trusted

Always auto-approve, preserving current behavior.

## Confirmation UI

The dialog should emphasize only the minimal fragments that caused
confirmation:

- reason code,
- affected resource,
- source line/span,
- redacted command fragment,
- short human explanation.

Examples:

- `database-write`: `UPDATE api_key ...`
- `service-control`: `systemctl restart`
- `sensitive-read`: Authorization token
- `unknown-dynamic-sql`: query source cannot be resolved

Ordinary read-only portions of a long script should be collapsed by default.

The initial design does not remember approval for an exact command or a
command class. Repeated state-changing operations must each be confirmed.

## Audit and observability

Every evaluated invocation should record:

- trust level,
- policy and parser versions,
- `allow` or `confirm`,
- reason codes,
- redacted evidence spans,
- whether it was auto-approved,
- whether a dialog was shown,
- user decision: allow, deny, or dismiss,
- decision latency,
- a keyed command correlation ID.

Structured redaction must occur before serialization. Passwords, private keys,
tokens, authentication headers, sensitive SQL literals, and similar data must
never enter the audit log in raw form.

The correlation ID must be an HMAC over the command using a per-installation
secret, not a plain hash that permits offline guessing of short secrets. It
must not be used as an authorization cache.

## Performance caching

The parsed and evaluated result may be cached in memory by:

- a process-local digest of the normalized command,
- relevant policy context,
- parser version,
- rule-pack version.

The process-local digest is never persisted. The cache changes performance
only. It must not remember a user's approval or turn a previous confirmation
into an automatic allow.

## Verification strategy

### Log replay corpus

Convert all 86 invocation records in the supplied log into a redacted,
reviewed fixture corpus. Label each command:

- ordinary read,
- sensitive read,
- state modification,
- unknown/unprovable.

The single connection error remains an execution fixture rather than a policy
decision fixture.

### Rule tests

For every allowed command form, include a nearby mutation:

- `systemctl status` versus `systemctl restart`;
- SQL `SELECT` versus `UPDATE`;
- `curl` GET versus `curl -d`;
- `tc show` versus `tc replace`;
- file read versus output redirection.

### Metamorphic tests

Verify decisions remain correct under:

- whitespace, comments, and newlines;
- quoting and escaping;
- absolute trusted paths and versioned aliases;
- reordered equivalent options;
- `sudo` and other wrappers;
- pipelines, branches, substitutions, and nested scripts.

### Adversarial tests

Cover:

- parser differentials and malformed trees;
- dynamic executable names;
- heredoc and substitution execution;
- `eval`, `source`, and interpreter escapes;
- sensitive-data flow into network or files;
- arbitrary-path executable masquerading;
- SQL writable CTEs and effectful functions;
- HTTP option files and method overrides;
- analysis resource exhaustion.

### Fuzzing

Fuzz the parser-to-IR conversion and effect aggregation under strict time,
node, and recursion budgets. Crashes, timeouts, and unsupported syntax must
all resolve to confirmation.

## Rollout

The shared package now owns replay, adversarial, and fuzz suites. AT Terminal
switched to that evaluator and deleted `remoteCommandPolicy.ts` and
`shellCommandLexer.ts` rather than keeping overlapping old rules in shadow
mode.

Plugin-side remaining work is packaging measurement (MCP VSIX compressed
delta) and later JumpServer consumption of the same public API.

## JumpServer next-phase contract

JumpServer is not migrated in this change. When it consumes
`@at-series/command-policy@0.1.0` from npm (exact pin, no `^`, same
`docs/api.md` contract as AT Terminal), the following mapping applies.

### SSH

- Final confirmation for `JumpServerAgentToolService.runTerminalCommand` is
  the integration point for `@at-series/command-policy/shell`.
- Policy evaluation and execution must use the same normalized effective
  command text. Do not rewrite `sourceText` after a decision.
- Pass `cwd` as a separate field. Do not concatenate it into the command.
- `sendTerminalInput` remains always-confirm. Shared `allow` must not skip
  that prompt.

### MySQL and Redis

- Later replace `SqlSafety` / `RedisSafety` with `/mysql` and `/redis`.
- Current files: `src/agent/SqlSafety.ts`, `src/agent/RedisSafety.ts`,
  `src/agent/JumpServerAgentToolService.ts`.

### Trust

JumpServer currently has no `none` / `policy` / `full` trust levels. A shared
`allow` decision must not skip existing JumpServer confirms until an explicit
trust model exists. Until then, policy evidence may enrich the dialog but
cannot auto-approve.

## Acceptance criteria

- Zero state-changing commands auto-approved in the reviewed log corpus.
- Zero sensitive-read commands auto-approved in the reviewed log corpus.
- Zero known mutation bypasses in the adversarial suite.
- No more than 10% confirmation rate among human-labeled ordinary queries;
  every remaining confirmation has a specific `unknown` reason.
- Every confirmation contains at least one stable reason code and source
  span.
- Warm evaluation latency p95 is at most 25 ms.
- Parser initialization and cold-start failures can add confirmation but
  cannot bypass it.
- The `# Purpose:` plus multi-line command form no longer confirms merely
  because it contains a newline.
- The MCP VSIX compressed-size increase is at most 500 KB, installed policy
  assets are at most 2.5 MB, and the base package size does not increase.

## Risks and mitigations

### Unknown commands may prompt more often

The proof-oriented model reverses the current blocklist default for unknown
commands. Mitigate this with a broad reviewed baseline, replay telemetry, and
small versioned analyzer additions rather than returning to unknown-as-safe.

### Tree-sitter is tolerant of malformed input

Reject every parse containing error or missing nodes and require complete
source coverage.

### Command contracts can drift

Pin rule versions, test supported command versions, treat unknown options as
unknown, and version every policy decision.

### Embedded-language analysis is expensive

Use strict size/depth/time budgets, lazy parser initialization, and
performance-only caching.

### Parser packages can silently bloat the VSIX

Bundle a separate production policy entry point and copy an explicit asset
allowlist. CI must inspect the final VSIX, reject full parser packages and
debug assets, and enforce the compressed and installed size budgets.

### Static analysis is not a sandbox

Keep the threat-model limitation explicit. If a stronger guarantee is later
required, add remote execution isolation as a separate defense-in-depth
project rather than weakening the meaning of this policy.

## Expected outcome

The redesign removes the direct conflict between the required `# Purpose:`
comment and limited-trust parsing. The runtime now consumes
`@at-series/command-policy` instead of a plugin-local blocklist.
