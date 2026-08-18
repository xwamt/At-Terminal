import { describe, expect, it } from 'vitest';
import { buildWebviewStrings, t } from '../../src/i18n/t';

describe('t', () => {
  it('passes the message through with named placeholders substituted', () => {
    expect(t('Delete {path}?', { path: '/tmp/app.log' })).toBe('Delete /tmp/app.log?');
  });

  it('returns a message that has no placeholders unchanged', () => {
    expect(t('Configure SSH')).toBe('Configure SSH');
    expect(t('Configure SSH', { unused: 'ignored' })).toBe('Configure SSH');
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    expect(t('{path} -> {path}', { path: 'file.txt' })).toBe('file.txt -> file.txt');
  });

  it('substitutes falsy numbers and booleans instead of dropping to the placeholder', () => {
    expect(t('{count} items, rememberPassword: {rememberPassword}', { count: 0, rememberPassword: false })).toBe(
      '0 items, rememberPassword: false'
    );
  });

  it('leaves a placeholder with no matching argument literal', () => {
    expect(t('Host at {host} ({port})', { host: '127.0.0.1' })).toBe(
      'Host at 127.0.0.1 ({port})'
    );
  });
});

describe('buildWebviewStrings', () => {
  it('resolves every requested key into a plain dictionary', () => {
    const strings = buildWebviewStrings({
      save: 'Save',
      cancel: 'Cancel'
    });
    expect(strings).toEqual({ save: 'Save', cancel: 'Cancel' });
  });

  it('produces a JSON-embeddable dictionary with no prototype pollution vector', () => {
    const strings = buildWebviewStrings({ save: 'Save' });
    expect(Object.getPrototypeOf(strings)).toBeNull();
  });

  it('returns an empty dictionary for an empty source', () => {
    const strings = buildWebviewStrings({});
    expect(Object.keys(strings)).toEqual([]);
    expect(JSON.stringify(strings)).toBe('{}');
  });

  it('serializes to the JSON the page will actually be handed', () => {
    expect(JSON.stringify(buildWebviewStrings({ save: 'Save', cancel: 'Cancel' }))).toBe(
      '{"save":"Save","cancel":"Cancel"}'
    );
  });

  it('carries a "__proto__" key as data instead of losing it to the inherited setter', () => {
    const strings = buildWebviewStrings({ ['__proto__']: 'Save' });

    expect(strings['__proto__']).toBe('Save');
    expect(JSON.stringify(strings)).toBe('{"__proto__":"Save"}');
  });

  it('leaves placeholders unresolved for the page to fill in', () => {
    expect(buildWebviewStrings({ title: 'Configure: {label}' })).toEqual({
      title: 'Configure: {label}'
    });
  });

  it('passes values through unescaped, leaving escaping to whoever embeds them', () => {
    expect(buildWebviewStrings({ danger: '</script><img src=x onerror=alert(1)>' })).toEqual({
      danger: '</script><img src=x onerror=alert(1)>'
    });
  });
});
