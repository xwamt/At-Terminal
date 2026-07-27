const RESET = '\x1b[0m';

interface HighlightRule {
  readonly pattern: RegExp;
  readonly color: string;
}

interface HighlightMatch {
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
  if (matches.length === 0) {
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

function isHighlightableText(text: string): boolean {
  return text.length > 0 && !ansiEscapePattern.test(text) && !unsafeControlPattern.test(text);
}

function collectMatches(text: string): HighlightMatch[] {
  const matches: HighlightMatch[] = [];
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (match.index === undefined || match[0].length === 0) {
        continue;
      }
      const candidate = {
        start: match.index,
        end: match.index + match[0].length,
        color: rule.color
      };
      if (!overlapsExistingMatch(candidate, matches)) {
        matches.push(candidate);
      }
    }
  }
  return matches.sort((left, right) => left.start - right.start);
}

function overlapsExistingMatch(candidate: HighlightMatch, matches: HighlightMatch[]): boolean {
  return matches.some((match) => candidate.start < match.end && candidate.end > match.start);
}
