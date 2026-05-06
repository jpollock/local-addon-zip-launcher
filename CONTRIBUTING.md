# Contributing to Zip Launcher

Thank you for your interest in contributing! This document covers everything you need to get started.

## Prerequisites

- **Node.js** >= 18 — [nodejs.org](https://nodejs.org)
- **Local by WP Engine** — [localwp.com](https://localwp.com)
- **Git**

## Development Setup

```bash
# 1. Clone the repo
git clone https://github.com/jpollock/local-addon-zip-launcher.git
cd local-addon-zip-launcher

# 2. Install dependencies
npm install

# 3. Build and symlink into Local
npm run build
npm run install-addon

# 4. Restart Local to load the addon
```

## Development Workflow

```bash
# Auto-recompile on changes
npm run watch

# After each change, restart Local to pick up the new build.
# Hot reload is not supported for Local addons.
```

## Running Tests

```bash
npm test              # All tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

## Code Style

```bash
npm run lint        # Check
npm run lint:fix    # Auto-fix
npm run format      # Format with Prettier
npm run precommit   # lint + type-check + test (run before committing)
```

## Project Structure

```
src/
  main/index.ts       — Main process: IPC handler, collision detection, demo import
  renderer/index.ts   — Renderer process: drop interception
  lib/
    zip-analyzer.ts   — Pure functions: zip detection, path validation, slug helpers
tests/
  zip-analyzer.test.ts — Unit tests for all pure functions
```

## Adding a New Detection Type

The `analyzeZip` function in `src/lib/zip-analyzer.ts` is where zip content is identified. To add a new type:

1. Add a new detection pass after the plugin check
2. Return `{ type: 'your-type', name, folder, demoContentEntries }`
3. Extend the `ZipAnalysisResult['type']` union type
4. Handle the new type in `src/main/index.ts`
5. Add tests

## Commit Style

We use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | When to use |
|---|---|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `chore:` | Tooling, deps, version bumps |
| `test:` | Test additions/changes |

## Filing Issues

Please use [GitHub Issues](https://github.com/jpollock/local-addon-zip-launcher/issues). Include:
- Local version (Help → About Local)
- macOS / Windows / Linux
- The zip you dropped (or a description of its structure)
- Relevant lines from Local's system log (Help → System Log)
