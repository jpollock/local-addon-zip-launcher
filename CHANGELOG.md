# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-05-06

### Added
- Bundle detection — zips containing multiple components (theme + plugin) under a common wrapper directory are now fully handled
- `stripCommonPrefix` strips wrapper directories (e.g. `wp/`) before detection, fixing depth issues
- All detected components installed on one site in a single drop: plugins first, then themes
- Site name derived from component names, deduplicated and joined (e.g. `markshare` or `astra-woocommerce`)
- Extract-then-activate install pattern for bundles (no re-zipping required)
- Collision detection checks all bundle components

## [0.3.0] - 2026-05-06

### Added
- TypeScript source with full type safety
- CI/CD with GitHub Actions (lint, typecheck, test, build)
- GitHub Pages documentation site
- Collision detection — native dialog when theme/plugin already installed on a site
- Auto-start stopped site when updating via collision dialog
- Demo content (WXR) auto-import after theme/plugin activation
- Progress bar integration during start, update, and demo import operations
- WordPress.org PHPDoc header format support (` * Plugin Name:`)
- Atomic IPC — single `zip-launcher:process` channel handles everything

### Fixed
- `validateFilePath` path traversal check uses segment split (not substring) — prevents false rejections for paths like `/Users/elliot.andrews/…`
- `multiSite` must be empty string (`Local.MultiSite.No = ''`) — was incorrectly `'no'`
- Demo content import: `wordpress-importer` installed once before loop, not per-entry
- Skip demo import after failed `--force` update
- `showToast` requires `toastTrigger: 'import'` field
- `StreamZip.async` API hangs in Local's Electron environment — switched to callback API
- Navigation uses `webContents.send` not `ipcRenderer.send`

## [0.2.0] - 2026-05-05

### Added
- Security hardening: `validateFilePath`, zip traversal guard, random admin password
- Atomic IPC dispatch: main process emits `addSite`, no renderer round-trip
- `pendingZip` 5-minute TTL to prevent stale state
- Lazy-cached service container
- `node-stream-zip` pinned to exact version, added to `bundledDependencies`
- 22 unit tests

## [0.1.0] - 2026-05-05

### Added
- Initial implementation: drop zip → detect theme/plugin → create site
- Global drop interception via capture-phase event listener
- Passthrough for non-theme/plugin zips to Local's existing import flow
