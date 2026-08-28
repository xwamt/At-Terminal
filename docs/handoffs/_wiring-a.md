# Wiring — slice A (trust-i18n)

Everything below touches files slice A does not own (`src/sftp/SftpManager.ts`,
`src/sftp/SftpDragAndDropController.ts` — both belong to slice C). The integrator applies
these when merging into the integration branch. The l10n keys they need
(`"Delete {path}"`, `"No connected SSH terminal is active."`) are already present in
`l10n/bundle.l10n.zh-cn.json` after slice A, so no bundle edit is required here.

## 1. `src/sftp/SftpManager.ts` — localize the `deleteEntry` transfer label

The file already imports `t` from `../i18n/t`. In `deleteEntry`, replace the raw label:

```ts
// before
      await this.runConnected(
        'delete',
// after
      await this.runConnected(
        t('Delete {path}', { path: entry.path }),
```

`deleteEntry` runs QUIET, so the label only surfaces in the failure toast, which becomes
`t('{label} failed.')` → zh-CN「删除 /path 失败。」. No test pins the `'delete'` label
(`test/sftp/SftpManager.test.ts` never asserts it), so this is drop-in safe.

## 2. `src/sftp/SftpDragAndDropController.ts` — localize the requireConnected throw

```ts
import { t } from '../i18n/t';
// ...
    if (state.kind !== 'active') {
      throw new Error(t('No connected SSH terminal is active.'));
    }
```

(Add the import at the top of the file; the string key already exists in the bundle and is
the exact message `SftpManager` / `SftpEditSessionManager` already localize.)

## Notes for the integrator

- Remaining English labels `'new folder'` (`SftpManager.mkdir`) and `'rename'`
  (`SftpManager.rename`) also surface via `{label} failed.`; they belong to slice C and are
  intentionally not patched here.
- Fact-check escalation: at `27deea6` the bundled policy runtime
  (`@at-series/command-policy@0.1.0` via `dist/policy-runtime.js`) returns
  `{ action: 'review', reasonCode: 'shell.unknown_semantics' }` for unknown commands, i.e.
  the runtime still prompts for them, while the shipped copy (`src/mcp/toolCatalog.ts`
  description, `ServerFormPanel.ts` trust help, `docs/features*.md` Safety section, and —
  after slice A — the tool table) states the blocklist narrative ("unknown commands run
  without a prompt"). Docs erring toward "fewer prompts than reality" is the safe
  direction, but copy-vs-runtime reconciliation should be decided with slice D (which owns
  `toolCatalog.ts`) or as a product call. Slice A deliberately did not touch runtime or
  copy outside its owned files.
