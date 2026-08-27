import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8')) as T;
}

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/{([^}]+)}/g)].map((match) => match[1]).sort();
}

const english = readJson<Record<string, string>>('package.nls.json');
const chinese = readJson<Record<string, string>>('package.nls.zh-cn.json');
const bundle = readJson<Record<string, string>>('l10n/bundle.l10n.zh-cn.json');

describe('package.nls files', () => {
  it('declares exactly the same keys in both languages', () => {
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
  });

  it('leaves no entry blank in either language', () => {
    for (const [key, value] of [...Object.entries(english), ...Object.entries(chinese)]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('namespaces every key under atTerminal', () => {
    for (const key of Object.keys(english)) {
      expect(key.startsWith('atTerminal.'), key).toBe(true);
    }
  });
});

describe('l10n runtime bundle', () => {
  it('keeps every placeholder of the English source in its translation', () => {
    for (const [source, translation] of Object.entries(bundle)) {
      expect(placeholdersOf(translation), source).toEqual(placeholdersOf(source));
    }
  });

  it('translates every entry into something other than an empty string', () => {
    for (const [source, translation] of Object.entries(bundle)) {
      expect(translation.trim(), source).not.toBe('');
    }
  });
});

const T_CALL = /(?<![\w.])t\(\s*'((?:[^'\\]|\\.)*)'/gs;

function sourceFilesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFilesIn(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function translationKeysIn(source: string): string[] {
  return [...source.matchAll(T_CALL)].map((match) => unescapeLiteral(match[1]));
}

function unescapeLiteral(raw: string): string {
  return JSON.parse(`"${raw.replaceAll("\\'", "'").replace(/(?<!\\)"/g, '\\"')}"`) as string;
}

describe('every string the extension translates at runtime', () => {
  const sources = sourceFilesIn(resolve(process.cwd(), 'src'));
  const keys = new Map<string, string>();
  for (const path of sources) {
    for (const key of translationKeysIn(readFileSync(path, 'utf8'))) {
      keys.set(key, path);
    }
  }

  it('reads a plausible number of them out of the source', () => {
    expect(keys.size).toBeGreaterThan(25);
  });

  it('has a zh-cn translation for every one', () => {
    for (const [key, path] of keys) {
      expect(Object.keys(bundle), `${path}: ${JSON.stringify(key)}`).toContain(key);
    }
  });
});

function stringValuesOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringValuesOf);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(stringValuesOf);
  }
  return [];
}

const WHOLE_PLACEHOLDER = /^%([\w.-]+)%$/;
const ANY_PLACEHOLDER = /%[\w.-]+%/;

const manifestStrings = stringValuesOf(readJson<unknown>('package.json'));
const manifestPlaceholders = manifestStrings
  .map((value) => WHOLE_PLACEHOLDER.exec(value)?.[1])
  .filter((key): key is string => key !== undefined);

describe('package.json', () => {
  it('points at the l10n directory that holds the bundle', () => {
    const manifest = readJson<{ l10n?: string }>('package.json');
    expect(manifest.l10n).toBe('./l10n');
  });

  it('uses placeholders for the strings the UI shows', () => {
    expect(manifestPlaceholders.length).toBeGreaterThanOrEqual(8);
  });

  it('resolves every %placeholder% it writes in both languages', () => {
    for (const key of manifestPlaceholders) {
      expect(Object.keys(english), key).toContain(key);
      expect(Object.keys(chinese), key).toContain(key);
    }
  });

  it('never embeds a placeholder inside a longer string', () => {
    for (const value of manifestStrings) {
      if (ANY_PLACEHOLDER.test(value)) {
        expect(value, value).toMatch(WHOLE_PLACEHOLDER);
      }
    }
  });

  it('leaves no nls key unused across package.mcp.json and package.base.json', () => {
    // The base build keeps %atTerminal.displayName% while the MCP build uses
    // %atTerminal.mcpDisplayName%, so a key only has to be used by one variant.
    const variantStrings = [
      ...stringValuesOf(readJson<unknown>('package.mcp.json')),
      ...stringValuesOf(readJson<unknown>('package.base.json'))
    ];
    const variantPlaceholders = variantStrings
      .map((value) => WHOLE_PLACEHOLDER.exec(value)?.[1])
      .filter((key): key is string => key !== undefined);
    for (const key of Object.keys(english)) {
      expect(variantPlaceholders, key).toContain(key);
    }
  });
});
