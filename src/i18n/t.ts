import * as vscode from 'vscode';

/**
 * The placeholder value types `vscode.l10n.t` declares. Widening this to
 * `unknown` would need a cast to compile and would let `undefined` through --
 * which the extension host resolves to the literal `{placeholder}` text
 * instead of raising, so the mistake would ship as garbled UI rather than
 * fail here.
 */
export type TranslationArgs = Record<string, string | number | boolean>;

/**
 * The single entry point for runtime copy. It only forwards to
 * `vscode.l10n.t`; the point is that call sites depend on this module alone,
 * so lifting this i18n layer into the other AT Series plugins is a matter of
 * copying one file instead of editing every call site.
 */
export function t(message: string, args?: TranslationArgs): string {
  return args === undefined ? vscode.l10n.t(message) : vscode.l10n.t(message, args);
}

/**
 * A Webview cannot reach `vscode.l10n` -- that namespace exists only in the
 * extension host -- so its copy has to be translated here and handed to the
 * page as data. The null prototype keeps a key such as `__proto__` an ordinary
 * entry, where an object literal would silently drop it into
 * `Object.prototype`'s setter, and keeps anything inherited out of the
 * serialized payload.
 *
 * Values come back verbatim. Escaping depends on where the caller writes them
 * -- a `<script type="application/json">` block needs `<` as `\u003c`, an
 * attribute needs HTML entities -- and only the caller knows which, so it
 * belongs to the HTML layer rather than here.
 */
export function buildWebviewStrings(source: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, message] of Object.entries(source)) {
    result[key] = t(message);
  }
  return result;
}
