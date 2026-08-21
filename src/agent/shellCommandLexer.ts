/**
 * Quote-aware tokenizer for `run_remote_command` confirmation.
 *
 * This is not a POSIX shell. It only answers: which tokens are real command
 * stages, and whether the line contains a shape (substitution, file redirect,
 * unclosed quote) that makes those names untrustworthy.
 */

export type ShellLexResult =
  | { ok: true; stages: string[][] }
  | { ok: false };

const SAFE_REDIRECT_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '&1', '&2', '&-', '1', '2', '-']);

function isSafeRedirectTarget(target: string): boolean {
  return SAFE_REDIRECT_TARGETS.has(target.replace(/\s+/g, ''));
}

function isStageSeparator(ch: string): boolean {
  return ch === '|' || ch === ';' || ch === '&';
}

export function tokenizeShellCommand(command: string): ShellLexResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false };
  }

  const stages: string[][] = [];
  let tokens: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let stageHasToken = false;
  let i = 0;

  const flushToken = (): boolean => {
    if (cur.length === 0) {
      return true;
    }
    if (!stageHasToken && (cur.startsWith('\\') || cur.startsWith('{'))) {
      return false;
    }
    tokens.push(cur);
    cur = '';
    stageHasToken = true;
    return true;
  };

  const flushStage = (): boolean => {
    if (!flushToken()) {
      return false;
    }
    if (tokens.length > 0) {
      stages.push(tokens);
      tokens = [];
    }
    stageHasToken = false;
    return true;
  };

  const readRedirect = (start: number): { ok: true; next: number } | { ok: false } => {
    let index = start;
    const ch = trimmed[index];
    const next = trimmed[index + 1];
    if (ch === '>' && next === '>') {
      index += 2;
    } else if (ch === '<' && next === '<') {
      index += 2;
    } else if (ch === '>' && next === '&') {
      index += 2;
    } else if (ch === '&' && next === '>') {
      index += 2;
    } else {
      index += 1;
    }
    while (index < trimmed.length && /\s/.test(trimmed[index])) {
      index += 1;
    }
    let target = '';
    while (index < trimmed.length && !/\s/.test(trimmed[index]) && !isStageSeparator(trimmed[index]) && trimmed[index] !== '<' && trimmed[index] !== '>') {
      target += trimmed[index];
      index += 1;
    }
    if (!isSafeRedirectTarget(target)) {
      return { ok: false };
    }
    return { ok: true, next: index };
  };

  while (i < trimmed.length) {
    const ch = trimmed[i];
    const next = trimmed[i + 1];

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        cur += ch;
      }
      i += 1;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        i += 1;
        continue;
      }
      if (ch === '`') {
        return { ok: false };
      }
      if (ch === '$' && next === '(') {
        return { ok: false };
      }
      cur += ch;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === '`') {
      return { ok: false };
    }
    if (ch === '$' && next === '(') {
      return { ok: false };
    }
    if (ch === '\n' || ch === '\r') {
      return { ok: false };
    }

    if (ch === '\\') {
      if (!stageHasToken && cur.length === 0) {
        return { ok: false };
      }
      cur += next ?? '';
      i += 2;
      continue;
    }

    if (ch === '>' || ch === '<') {
      if (cur.length > 0 && !/^\d+$/.test(cur)) {
        if (!flushToken()) {
          return { ok: false };
        }
      } else {
        cur = '';
      }
      const redirect = readRedirect(i);
      if (!redirect.ok) {
        return { ok: false };
      }
      i = redirect.next;
      continue;
    }

    if (ch === '&' && next === '>') {
      if (!flushToken()) {
        return { ok: false };
      }
      const redirect = readRedirect(i);
      if (!redirect.ok) {
        return { ok: false };
      }
      i = redirect.next;
      continue;
    }

    if (isStageSeparator(ch)) {
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        i += 1;
      }
      if (!flushStage()) {
        return { ok: false };
      }
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      if (!flushToken()) {
        return { ok: false };
      }
      i += 1;
      continue;
    }

    cur += ch;
    i += 1;
  }

  if (quote) {
    return { ok: false };
  }
  if (!flushStage()) {
    return { ok: false };
  }
  if (stages.length === 0) {
    return { ok: false };
  }
  return { ok: true, stages };
}
