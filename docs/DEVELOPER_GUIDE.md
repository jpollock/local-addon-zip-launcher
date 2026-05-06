---
layout: default
title: Developer Guide
---

# Developer Guide

## Prerequisites

- **Node.js** >= 18 — [nodejs.org](https://nodejs.org)
- **Local by WP Engine** — [localwp.com](https://localwp.com)
- **Git**

## Setup

```bash
git clone https://github.com/jpollock/local-addon-zip-launcher.git
cd local-addon-zip-launcher
npm install
npm run build
npm run install-addon
```

Then restart Local. The addon loads automatically from `~/Library/Application Support/Local/addons/local-addon-zip-launcher` (symlinked to your clone).

## Development Loop

```bash
# Terminal 1: watch for TypeScript changes
npm run watch

# After each change: restart Local (Cmd+Q then relaunch)
# Hot reload is not supported for Local addons
```

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Clean + compile TypeScript + create entry points |
| `npm run watch` | Auto-recompile on save |
| `npm test` | Run all unit tests |
| `npm run test:coverage` | Tests with coverage report |
| `npm run lint` | ESLint check |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run format` | Prettier format |
| `npm run type-check` | TypeScript type check without emitting |
| `npm run precommit` | lint + type-check + test |
| `npm run validate-release` | Full release readiness check |

## Architecture

```
Drop event (any screen in Local)
        │
        ▼
src/renderer/index.ts
  document.addEventListener('drop', handler, { capture: true })
  — detects .zip files only
  — calls ipcRenderer.invoke('zip-launcher:process', { filePath })
        │
        ▼
src/main/index.ts — ipcMain.handle('zip-launcher:process')
  1. validateFilePath()        — path safety check
  2. analyzeZip()              — detect theme/plugin + WXR files
  3. findCollidingSite()       — filesystem check for existing install
  4. dialog.showMessageBox()   — collision dialog (if needed)
  5. ipcMain.emit('addSite')   — trigger Local's site creation
     — OR —
     wpCli.run(--force)        — update existing site
        │
        ▼
context.hooks.addAction('wordPressInstaller:standardInstall')
  — fires after WordPress is installed on the new site
  — runs: wp theme/plugin install --activate
  — runs: importDemoContent() if WXR files found
  — navigates to site info panel
```

## File Responsibilities

| File | Responsibility |
|---|---|
| `src/lib/zip-analyzer.ts` | Pure functions: path validation, zip reading, header parsing, WXR detection, slugification |
| `src/main/index.ts` | Main process: IPC handler, collision detection, service container access, demo content import, navigation |
| `src/renderer/index.ts` | Renderer process: capture-phase drop listener, IPC dispatch, passthrough handling |
| `tests/zip-analyzer.test.ts` | Unit tests for all pure functions in zip-analyzer |

## Adding a New Detection Type

To support a new kind of zip (e.g., a page builder template):

1. Add a detection function in `src/lib/zip-analyzer.ts` that returns `{ type: 'your-type', name, folder, demoContentEntries }`
2. Extend the `ZipAnalysisResult['type']` union: `'theme' | 'plugin' | 'your-type'`
3. Handle the new type in `src/main/index.ts` after the collision check
4. Add WP-CLI install command for your type
5. Write tests for the detection function

## System Log

Local's system log (`Help → System Log`) shows all `[zip-launcher]` messages — useful for debugging detection failures.
