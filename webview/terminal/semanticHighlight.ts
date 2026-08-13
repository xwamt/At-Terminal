const RESET = '\x1b[0m';

/** Above this the chunk is a firehose, not something a human reads line by line. */
export const MAX_HIGHLIGHT_TEXT_LENGTH = 8 * 1024;
/** A CSV or numeric log can produce thousands of matches per chunk; colouring them all costs more than it is worth. */
export const MAX_HIGHLIGHT_MATCHES = 200;

interface HighlightRule {
  readonly pattern: RegExp;
  readonly color: string;
}

export interface HighlightMatch {
  readonly start: number;
  readonly end: number;
  readonly color: string;
}

const ansiEscapePattern = /\x1b\[[0-?]*[ -/]*[@-~]/;
const unsafeControlPattern = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const rules: HighlightRule[] = [
  { pattern: /\b(?:error|failed|failure|fatal|denied|exception)\b/gi, color: '\x1b[31m' },
  { pattern: /\b(?:warn|warning|deprecated)\b/gi, color: '\x1b[33m' },
  { pattern: /\b(?:success|passed|ok|done)\b/gi, color: '\x1b[32m' },
  { pattern: /https?:\/\/[^\s'"`<>|]+/gi, color: '\x1b[36m' },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, color: '\x1b[36m' },
  { pattern: /(?:^|(?<=[\s:=]))(?:~|\/)[^\s'"`<>|;]+/g, color: '\x1b[34m' },
  { pattern: /\b\d+(?:\.\d+)?\b/g, color: '\x1b[32m' }
];

export function semanticHighlightText(text: string): string {
  if (!isHighlightableText(text)) {
    return text;
  }

  const matches = collectMatches(text);
  if (matches.length === 0 || matches.length > MAX_HIGHLIGHT_MATCHES) {
    return text;
  }

  let highlighted = '';
  let cursor = 0;
  for (const match of matches) {
    highlighted += text.slice(cursor, match.start);
    highlighted += `${match.color}${text.slice(match.start, match.end)}${RESET}`;
    cursor = match.end;
  }
  highlighted += text.slice(cursor);
  return highlighted;
}

/**
 * Folds one rule's matches into the matches kept so far. Both inputs must be sorted by
 * `start` and be internally non-overlapping, which is what a single global regex scan gives
 * you. A candidate is dropped when it overlaps anything already accepted, so earlier rules
 * keep winning over later ones exactly as a first-come-first-served scan would decide - but
 * each fold is a single linear pass instead of a scan of the whole accepted set per candidate.
 */
export function mergeNonOverlappingMatches(
  accepted: readonly HighlightMatch[],
  candidates: readonly HighlightMatch[]
): HighlightMatch[] {
  if (accepted.length === 0) {
    return candidates.slice();
  }
  if (candidates.length === 0) {
    return accepted.slice();
  }

  const merged: HighlightMatch[] = [];
  let acceptedIndex = 0;
  for (const candidate of candidates) {
    while (acceptedIndex < accepted.length && accepted[acceptedIndex].end <= candidate.start) {
      merged.push(accepted[acceptedIndex]);
      acceptedIndex += 1;
    }
    const blocker = accepted[acceptedIndex];
    if (blocker !== undefined && blocker.start < candidate.end) {
      continue;
    }
    merged.push(candidate);
  }
  while (acceptedIndex < accepted.length) {
    merged.push(accepted[acceptedIndex]);
    acceptedIndex += 1;
  }
  return merged;
}

function isHighlightableText(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= MAX_HIGHLIGHT_TEXT_LENGTH &&
    !ansiEscapePattern.test(text) &&
    !unsafeControlPattern.test(text)
  );
}

function collectMatches(text: string): HighlightMatch[] {
  let matches: HighlightMatch[] = [];
  for (const rule of rules) {
    matches = mergeNonOverlappingMatches(matches, matchRule(text, rule));
  }
  return matches;
}

function matchRule(text: string, rule: HighlightRule): HighlightMatch[] {
  rule.pattern.lastIndex = 0;
  const found: HighlightMatch[] = [];
  for (const match of text.matchAll(rule.pattern)) {
    if (match.index === undefined || match[0].length === 0) {
      continue;
    }
    found.push({ start: match.index, end: match.index + match[0].length, color: rule.color });
  }
  return found;
}
