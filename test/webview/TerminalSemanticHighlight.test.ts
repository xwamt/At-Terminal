import { describe, expect, it } from 'vitest';
import {
  MAX_HIGHLIGHT_MATCHES,
  MAX_HIGHLIGHT_TEXT_LENGTH,
  mergeNonOverlappingMatches,
  semanticHighlightText,
  type HighlightMatch
} from '../../webview/terminal/semanticHighlight';

/**
 * The shipped behaviour before this file existed: walk candidates in rule order and keep a
 * candidate only when it overlaps nothing already kept. Quadratic, but it is the definition
 * of "first come, first served" that the fast path has to reproduce exactly.
 */
function firstComeFirstServed(groups: readonly (readonly HighlightMatch[])[]): HighlightMatch[] {
  const accepted: HighlightMatch[] = [];
  for (const group of groups) {
    for (const candidate of group) {
      const overlaps = accepted.some((match) => candidate.start < match.end && candidate.end > match.start);
      if (!overlaps) {
        accepted.push(candidate);
      }
    }
  }
  return accepted.sort((left, right) => left.start - right.start);
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomDisjointGroup(random: () => number, span: number, color: string): HighlightMatch[] {
  const group: HighlightMatch[] = [];
  let cursor = 0;
  while (cursor < span) {
    cursor += Math.floor(random() * 6);
    const length = 1 + Math.floor(random() * 8);
    if (cursor + length > span) {
      break;
    }
    group.push({ start: cursor, end: cursor + length, color });
    cursor += length;
  }
  return group;
}

describe('mergeNonOverlappingMatches', () => {
  it('keeps an earlier accepted match and drops the candidate that overlaps it', () => {
    const accepted: HighlightMatch[] = [{ start: 9, end: 14, color: 'red' }];
    const candidates: HighlightMatch[] = [{ start: 4, end: 18, color: 'blue' }];

    expect(mergeNonOverlappingMatches(accepted, candidates)).toEqual(accepted);
  });

  it('interleaves non-overlapping candidates in start order', () => {
    const accepted: HighlightMatch[] = [
      { start: 10, end: 20, color: 'red' },
      { start: 40, end: 50, color: 'red' }
    ];
    const candidates: HighlightMatch[] = [
      { start: 0, end: 5, color: 'blue' },
      { start: 25, end: 30, color: 'blue' },
      { start: 45, end: 60, color: 'blue' }
    ];

    expect(mergeNonOverlappingMatches(accepted, candidates)).toEqual([
      { start: 0, end: 5, color: 'blue' },
      { start: 10, end: 20, color: 'red' },
      { start: 25, end: 30, color: 'blue' },
      { start: 40, end: 50, color: 'red' }
    ]);
  });

  it('drops a candidate that swallows an accepted match entirely', () => {
    const accepted: HighlightMatch[] = [{ start: 5, end: 8, color: 'red' }];
    const candidates: HighlightMatch[] = [{ start: 0, end: 10, color: 'blue' }];

    expect(mergeNonOverlappingMatches(accepted, candidates)).toEqual(accepted);
  });

  it('accepts a candidate that only touches the boundary of an accepted match', () => {
    const accepted: HighlightMatch[] = [{ start: 5, end: 8, color: 'red' }];
    const candidates: HighlightMatch[] = [
      { start: 0, end: 5, color: 'blue' },
      { start: 8, end: 12, color: 'blue' }
    ];

    expect(mergeNonOverlappingMatches(accepted, candidates)).toEqual([
      { start: 0, end: 5, color: 'blue' },
      { start: 5, end: 8, color: 'red' },
      { start: 8, end: 12, color: 'blue' }
    ]);
  });

  it('produces the same result as first-come-first-served for randomized rule groups', () => {
    const random = createRandom(20260813);
    for (let round = 0; round < 300; round += 1) {
      const groups = [
        randomDisjointGroup(random, 200, 'a'),
        randomDisjointGroup(random, 200, 'b'),
        randomDisjointGroup(random, 200, 'c'),
        randomDisjointGroup(random, 200, 'd')
      ];

      const fast = groups.reduce<HighlightMatch[]>(
        (accepted, group) => mergeNonOverlappingMatches(accepted, group),
        []
      );

      expect(fast).toEqual(firstComeFirstServed(groups));
    }
  });
});

describe('semanticHighlightText priority', () => {
  it('lets an earlier rule win over a later rule that starts further left', () => {
    expect(semanticHighlightText('cat /var/error.log')).toBe('cat /var/\x1b[31merror\x1b[0m.log');
  });

  it('lets the IP rule win over the number rule that starts at the same offset', () => {
    expect(semanticHighlightText('host 10.0.0.1 up')).toBe('host \x1b[36m10.0.0.1\x1b[0m up');
  });

  it('lets the url rule win over the number rule nested inside it', () => {
    expect(semanticHighlightText('see https://example.com/500 now')).toBe(
      'see \x1b[36mhttps://example.com/500\x1b[0m now'
    );
  });
});

describe('semanticHighlightText limits', () => {
  it('leaves oversized chunks untouched instead of highlighting them on the render thread', () => {
    const oversized = 'error '.repeat(Math.ceil((MAX_HIGHLIGHT_TEXT_LENGTH + 1) / 6));

    expect(oversized.length).toBeGreaterThan(MAX_HIGHLIGHT_TEXT_LENGTH);
    expect(semanticHighlightText(oversized)).toBe(oversized);
  });

  it('still highlights a chunk that sits just under the size limit', () => {
    const sized = `error ${'x'.repeat(MAX_HIGHLIGHT_TEXT_LENGTH - 6)}`;

    expect(sized.length).toBe(MAX_HIGHLIGHT_TEXT_LENGTH);
    expect(semanticHighlightText(sized)).toContain('\x1b[31merror\x1b[0m');
  });

  it('leaves match-dense chunks untouched once they pass the match cap', () => {
    const dense = Array.from({ length: MAX_HIGHLIGHT_MATCHES + 1 }, (_, index) => `${index}`).join(' ');

    expect(dense.length).toBeLessThanOrEqual(MAX_HIGHLIGHT_TEXT_LENGTH);
    expect(semanticHighlightText(dense)).toBe(dense);
  });

  it('still highlights a chunk that sits exactly on the match cap', () => {
    const dense = Array.from({ length: MAX_HIGHLIGHT_MATCHES }, (_, index) => `${index}`).join(' ');

    expect(semanticHighlightText(dense)).toContain('\x1b[32m0\x1b[0m');
  });
});
