# Asset Import and Export Design

## Summary

Add encrypted AT Terminal asset import and export so users can move SSH server assets between devices, VS Code-compatible IDEs, and the base/MCP extension variants with minimal setup.

The feature exports one portable asset package. Server configuration is always included. Passwords and private key files are optional export choices. Imported private keys are written into an extension-managed secure directory, and imported server configs are updated to point at those new local paths.

This design does not migrate SSH host key trust records and does not install or update MCP client configuration.

## Goals

- Provide one-click asset export and import from the command palette and Servers view title actions.
- Use one package format shared by AT Terminal and AT Terminal MCP.
- Let users choose whether to include passwords and private key files.
- Always encrypt the asset package with a user-provided package password.
- Support predictable import conflict handling: skip, overwrite, or keep both with renamed labels.
- Preserve jump host relationships across imported servers when the referenced jump host is also imported or already exists.
- Keep sensitive material out of plain JSON, logs, notifications, and README examples.

## Non-Goals

- Do not export or import SSH host key trust records.
- Do not automatically install or update Kiro, Cursor, Continue, or other MCP client configuration.
- Do not create continuous sync between IDEs or devices.
- Do not support third-party asset formats in the first version.
- Do not make exported private key paths portable by reusing source-machine paths.

## User Experience

### Export Entry Points

- Command palette: `AT Terminal: Export Assets`.
- Servers view title action: export assets.

The export flow:

1. Ask where to save the package.
2. Ask which asset classes to include:
   - Server configuration, required.
   - Passwords, optional.
   - Private key files, optional.
3. Require a package password and confirmation.
4. Build and write the encrypted package.
5. Show a success message with the number of exported servers and whether passwords/private keys were included.

If a selected password or private key is missing, export continues for the rest of the package and reports a warning summary. Missing sensitive items are recorded as omissions in package metadata, not as empty secret values.

### Import Entry Points

- Command palette: `AT Terminal: Import Assets`.
- Servers view title action: import assets.

The import flow:

1. Ask the user to select an asset package.
2. Ask for the package password.
3. Decrypt and validate the package.
4. Show a conflict summary when imported servers match existing servers.
5. Ask for one conflict strategy:
   - Skip existing servers.
   - Overwrite existing servers.
   - Keep both and automatically rename imported server labels.
6. Write private keys into the extension-managed secure directory when present.
7. Save imported server configs through `ConfigManager`.
8. Store imported passwords in SecretStorage when present.
9. Refresh the Servers tree and show an import summary.

Conflicts should be detected by server id first. If ids differ, use a secondary match on normalized `label`, `host`, `port`, and `username` to catch common cross-device duplicates.

## Asset Package Format

The package is a single `.at-terminal-assets` file. Internally it is a JSON wrapper with encryption metadata and base64 ciphertext. The ciphertext contains a versioned JSON payload.

Conceptual payload:

```json
{
  "format": "at-terminal-assets",
  "version": 1,
  "createdAt": 1779870000000,
  "source": {
    "extensionName": "at-terminal",
    "extensionVersion": "2.10.1"
  },
  "options": {
    "includesPasswords": true,
    "includesPrivateKeys": true,
    "includesHostTrust": false
  },
  "servers": [],
  "passwords": {},
  "privateKeys": []
}
```

The on-disk wrapper separates encryption metadata from ciphertext so imports can validate that a file is an AT Terminal package before trying to decrypt it.

The encrypted payload includes:

- `servers`: `ServerConfig` records that pass the existing schema.
- `passwords`: a map from source server id to password for password-auth servers when selected and available.
- `privateKeys`: key file records with source server id, original basename, and encrypted file content when selected and available.
- `omissions`: non-secret metadata for passwords or key files that were requested but unavailable.

## Encryption

All packages are encrypted, including packages that contain only server configuration.

Implementation should use Node's `crypto` module with:

- Random salt.
- Random nonce/iv.
- Password-based key derivation such as `scrypt`.
- Authenticated encryption such as `aes-256-gcm`.

The package password is never stored. Decryption failure should produce a generic invalid password or corrupted package error and must not leak partial payload contents.

## Import Semantics

### Server Identity

Imported server ids are preserved when no conflict exists. When keeping both, new ids are generated for imported conflicting servers. Jump host references are remapped to the final ids so imported server chains remain valid.

When overwriting, the existing target id is preserved if the conflict was matched by secondary fields rather than id. This avoids breaking local references from servers that are not part of the import.

### Passwords

Passwords are imported only for password-auth servers that include password material. They are written through `ConfigManager.saveServer(server, password)` so SecretStorage remains the only persistent password store.

If a server is skipped, its password is not imported.

### Private Keys

Private keys are imported into `imported-private-keys` under extension global storage. The imported server's `privateKeyPath` is rewritten to the new file path.

The target filename should avoid collisions, preserve a safe basename when possible, and avoid exposing server passwords or full host details. File permissions are restricted with owner-only mode on POSIX platforms where Node can apply it. On Windows, the extension writes into VS Code's extension global storage and reports the path in the import summary rather than attempting ACL changes.

If a private-key server does not include a key file, its existing `privateKeyPath` is imported as metadata only. The import summary must tell the user that the key path may need to be fixed before connecting.

### Host Key Trust

Host key trust is not included in v1 packages. Imported servers will prompt for SSH host trust on first connection as usual.

## Code Structure

Add focused modules under `src/config` or `src/assets`:

- `AssetPackage.ts`: package schema, versioning, validation, and type definitions.
- `AssetCrypto.ts`: encryption and decryption helpers.
- `AssetExportService.ts`: reads config, secrets, and private key files to produce packages.
- `AssetImportService.ts`: validates packages, applies conflict strategy, writes private keys, saves servers, and stores passwords.
- `AssetCommands.ts`: VS Code command orchestration and user prompts.

`extension.ts` should only register commands and refresh the tree after successful imports. It should not contain package serialization, conflict logic, or crypto details.

The base and MCP package manifests should expose the same import/export commands and Servers view title actions.

## Error Handling

- Invalid file: show that the selected file is not an AT Terminal asset package.
- Wrong password or corrupted payload: show a generic decrypt failure.
- Unsupported future package version: explain that the extension needs to be updated.
- Missing private key during export: export other assets and show a warning summary.
- Private key write failure during import: abort before saving affected servers unless the user explicitly chose to continue without key files.
- Conflict handling cancellation: make no changes.

Import should stage work in memory before writing. Once writing begins, save servers one by one and report a clear partial-success summary if an unexpected error interrupts the process.

## Testing

Unit tests:

- Package schema accepts v1 payloads and rejects malformed packages.
- Encryption round-trips and rejects wrong passwords.
- Export includes required server config and optional passwords/private keys only when selected.
- Export records omissions without leaking secret values.
- Import skip, overwrite, and keep-both strategies produce expected server lists.
- Import remaps jump host ids when conflicting servers are renamed or regenerated.
- Import writes passwords only for imported servers.
- Import rewrites private key paths to the secure directory.

Manifest tests:

- Base and MCP variants both contribute import/export commands.
- Servers view title menus include import/export commands for both variants.

Manual checks:

- Export from base, import into MCP.
- Export from MCP, import into base.
- Import with wrong password.
- Import a package with one password server and one private-key server.
- Import duplicate assets using each conflict strategy.

## Implementation Decisions

- Use `.at-terminal-assets` as the asset package extension.
- Use a JSON wrapper with base64 ciphertext instead of a zip-like binary container.
- Store imported private keys under `imported-private-keys` in extension global storage.
- Apply owner-only file permissions for imported private keys on POSIX platforms where supported.
