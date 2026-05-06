# Bundle Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handle product-bundle zips (multiple components + common wrapper) by detecting all themes and plugins, installing them all on one new site.

**Architecture:** `analyzeZip` gains `stripCommonPrefix` (strips shared wrapper like `wp/`) and returns `ZipBundle` instead of `ZipAnalysisResult` — an array of `ZipComponent` items, plugins sorted first. `main.ts` installs each component via extract-then-activate (copy folder into `wp-content`, then `wp {type} activate`), deriving the site name by slugifying and deduplicating all component names.

**Tech Stack:** TypeScript, node-stream-zip, Node.js `fs` (synchronous folder extraction).

---

## File Map

| File | Change |
|---|---|
| `src/lib/zip-analyzer.ts` | Add `ZipComponent`, `ZipBundle`, `stripCommonPrefix`; rewrite `analyzeZip` return type |
| `src/main/index.ts` | Update `PendingZip`, add `extractZipFolderSync`, `slugBundleName`; update hook + IPC handler |
| `tests/zip-analyzer.test.ts` | Add `stripCommonPrefix` tests; update import to include new exports |

`renderer/index.ts` — not touched.

---

## Task 1: Update `zip-analyzer.ts` with bundle types + new `analyzeZip`

**Files:**
- Modify: `src/lib/zip-analyzer.ts`
- Modify: `tests/zip-analyzer.test.ts`

### TDD: Write tests first

- [ ] **Step 1: Add `stripCommonPrefix` import and tests to `tests/zip-analyzer.test.ts`**

Update the import at the top of the test file to include `stripCommonPrefix`, `ZipBundle`, `ZipComponent`:

```typescript
import {
  validateFilePath,
  parseHeader,
  extractFolder,
  isWxr,
  findWxrCandidates,
  slugify,
  getUniqueSlug,
  stripCommonPrefix,
} from '../src/lib/zip-analyzer';
```

Add this `describe` block after the `findWxrCandidates` block and before `slugify`:

```typescript
describe('stripCommonPrefix', () => {
  test('strips a single shared directory prefix', () => {
    const { stripped, prefix } = stripCommonPrefix([
      'wp/markshare-theme/style.css',
      'wp/markshare/markshare.php',
    ]);
    expect(prefix).toBe('wp/');
    expect(stripped).toEqual(['markshare-theme/style.css', 'markshare/markshare.php']);
  });

  test('strips a multi-level shared prefix', () => {
    const { stripped, prefix } = stripCommonPrefix([
      'release/v1/theme/style.css',
      'release/v1/plugin/plugin.php',
    ]);
    expect(prefix).toBe('release/v1/');
    expect(stripped).toEqual(['theme/style.css', 'plugin/plugin.php']);
  });

  test('returns no-op when there is no shared prefix', () => {
    const { stripped, prefix } = stripCommonPrefix([
      'theme/style.css',
      'plugin/plugin.php',
    ]);
    expect(prefix).toBe('');
    expect(stripped).toEqual(['theme/style.css', 'plugin/plugin.php']);
  });

  test('returns no-op for a single root-level file', () => {
    const { stripped, prefix } = stripCommonPrefix(['style.css']);
    expect(prefix).toBe('');
    expect(stripped).toEqual(['style.css']);
  });

  test('handles an empty array', () => {
    const { stripped, prefix } = stripCommonPrefix([]);
    expect(prefix).toBe('');
    expect(stripped).toEqual([]);
  });

  test('does not strip the entire path (preserves at least one segment)', () => {
    // All entries are in the same single file — unusual but handled gracefully
    const { stripped, prefix } = stripCommonPrefix(['wp/style.css', 'wp/functions.php']);
    expect(prefix).toBe('wp/');
    expect(stripped).toEqual(['style.css', 'functions.php']);
  });

  test('handles directory entries with trailing slash', () => {
    const { stripped, prefix } = stripCommonPrefix([
      'wp/',
      'wp/markshare/markshare.php',
      'wp/markshare-theme/style.css',
    ]);
    expect(prefix).toBe('wp/');
    expect(stripped).toEqual(['', 'markshare/markshare.php', 'markshare-theme/style.css']);
  });
});
```

- [ ] **Step 2: Run tests to confirm new tests fail**

```bash
cd /Users/jeremy.pollock/development/wpengine/local-addon-zip-launcher && npm test 2>&1 | tail -8
```

Expected: existing 39 tests pass, new `stripCommonPrefix` tests fail with "not a function".

### Implement

- [ ] **Step 3: Add `ZipComponent`, `ZipBundle` interfaces and `stripCommonPrefix` to `src/lib/zip-analyzer.ts`**

Remove the old `ZipAnalysisResult` interface entirely and replace with:

```typescript
export interface ZipComponent {
  type: 'theme' | 'plugin';
  name: string;
  folder: string; // WordPress folder name (post-strip), used as WP-CLI slug and wp-content subdir name
}

export interface ZipBundle {
  components: ZipComponent[]; // plugins first, then themes
  demoContentEntries: string[]; // raw (pre-strip) zip entry names
  prefix: string;              // common wrapper stripped during detection (e.g. 'wp/')
}
```

Add `stripCommonPrefix` after `findWxrCandidates`:

```typescript
/**
 * Finds the longest common directory prefix across all zip entry names and returns
 * both the stripped names and the prefix. Used to normalize wrapper directories
 * like `wp/` before theme/plugin detection.
 */
export function stripCommonPrefix(names: string[]): { stripped: string[]; prefix: string } {
  if (names.length === 0) return { stripped: [], prefix: '' };

  // Split each name into path segments (filter removes empty strings from trailing slashes)
  const segments = names.map((n) => n.split('/').filter(Boolean));

  // Walk depth-first: how many leading segments are shared by ALL entries?
  let prefixDepth = 0;
  while (true) {
    const firstSeg = segments[0]?.[prefixDepth];
    if (!firstSeg) break; // first entry has no more segments
    if (!segments.every((segs) => segs[prefixDepth] === firstSeg)) break;
    prefixDepth++;
  }

  if (prefixDepth === 0) return { stripped: names, prefix: '' };

  const prefix = segments[0].slice(0, prefixDepth).join('/') + '/';
  const stripped = names.map((n) => (n.startsWith(prefix) ? n.slice(prefix.length) : n));
  return { stripped, prefix };
}
```

- [ ] **Step 4: Rewrite `analyzeZip` in `src/lib/zip-analyzer.ts`**

Replace the entire `analyzeZip` function with:

```typescript
export async function analyzeZip(filePath: string): Promise<ZipBundle | null> {
  const zip = await openZip(filePath);
  try {
    const rawNames = Object.keys(zip.entries());

    // Strip common wrapper prefix (e.g. 'wp/') before detection.
    const { stripped, prefix } = stripCommonPrefix(rawNames);

    // Post-strip: reject traversal and limit detection to depth ≤ 2.
    const shallow = stripped.filter((n) =>
      n.length > 0 &&
      !n.includes('..') &&
      !path.isAbsolute(n) &&
      n.split('/').filter(Boolean).length <= 2,
    );

    const components: ZipComponent[] = [];
    const detectedFolders = new Set<string>();

    // --- Plugin detection (plugins first per install order) ---
    const phpFiles = shallow.filter((n) => n.endsWith('.php'));
    for (const phpFile of phpFiles) {
      const rawEntry = prefix + phpFile;
      const text = await readEntryText(zip, rawEntry);
      const name = parseHeader(text, 'Plugin Name');
      if (name) {
        const folder = phpFile.split('/')[0]; // post-strip folder name = WP plugin slug
        if (!detectedFolders.has(folder)) {
          detectedFolders.add(folder);
          components.push({ type: 'plugin', name, folder });
        }
      }
    }

    // --- Theme detection ---
    const styleCssFiles = shallow.filter((n) => {
      const parts = n.split('/').filter(Boolean);
      return parts[parts.length - 1] === 'style.css';
    });
    for (const styleCss of styleCssFiles) {
      const rawEntry = prefix + styleCss;
      const text = await readEntryText(zip, rawEntry);
      const name = parseHeader(text, 'Theme Name');
      if (name) {
        const folder = styleCss.split('/')[0]; // post-strip folder name = WP theme slug
        if (!detectedFolders.has(folder)) {
          detectedFolders.add(folder);
          components.push({ type: 'theme', name, folder });
        }
      }
    }

    if (components.length === 0) return null;

    // Demo content: scan raw (pre-strip) names — depth ≤ 3 already reaches into wrappers.
    const demoContentEntries = await detectDemoContent(zip, rawNames);

    return { components, demoContentEntries, prefix };
  } finally {
    zip.close();
  }
}
```

- [ ] **Step 5: Update `module.exports` to export new symbols**

Replace the export block at the bottom of `src/lib/zip-analyzer.ts`:

```typescript
export {
  validateFilePath,
  openZip,
  readEntryText,
  parseHeader,
  extractFolder,
  isWxr,
  findWxrCandidates,
  stripCommonPrefix,
  analyzeZip,
  slugify,
  getUniqueSlug,
};
export type { ZipComponent, ZipBundle };
```

Note: `ZipAnalysisResult` is removed — it's replaced by `ZipBundle`/`ZipComponent`.

- [ ] **Step 6: Run tests — all must pass**

```bash
cd /Users/jeremy.pollock/development/wpengine/local-addon-zip-launcher && npm test 2>&1 | tail -8
```

Expected: 39 + 7 = 46 tests pass, 0 failures.

- [ ] **Step 7: Verify TypeScript compiles cleanly**

```bash
cd /Users/jeremy.pollock/development/wpengine/local-addon-zip-launcher && npm run type-check 2>&1
```

Expected: no errors. If `main.ts` reports errors about `ZipAnalysisResult`, that's expected — Task 2 fixes them.

- [ ] **Step 8: Commit**

```bash
cd /Users/jeremy.pollock/development/wpengine/local-addon-zip-launcher
git add src/lib/zip-analyzer.ts tests/zip-analyzer.test.ts
git commit -m "feat: analyzeZip returns ZipBundle with stripCommonPrefix and multi-component detection"
```

---

## Task 2: Update `main.ts` to handle bundles

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Update imports in `src/main/index.ts`**

Replace the import block at the top:

```typescript
import {
  validateFilePath,
  analyzeZip,
  slugify,
  getUniqueSlug,
  openZip,
  ZipBundle,
  ZipComponent,
} from '../lib/zip-analyzer';
```

(`ZipAnalysisResult` is removed, `ZipBundle` and `ZipComponent` are added.)

- [ ] **Step 2: Update the `PendingZip` interface**

Replace the existing `PendingZip` interface with:

```typescript
interface PendingZip {
  filePath: string;
  components: ZipComponent[];  // all detected themes/plugins, plugins first
  prefix: string;              // common wrapper prefix in the zip (e.g. 'wp/')
  expectedSiteName: string;
  demoContentEntries: string[];
}
```

- [ ] **Step 3: Add `slugBundleName` helper after `getExistingSiteNames`**

```typescript
/**
 * Derives a site slug from bundle component names.
 * Deduplicates (MarkShare + MarkShare → markshare) and joins (Astra + WooCommerce → astra-woocommerce).
 */
function slugBundleName(components: ZipComponent[]): string {
  const slugs = components.map((c) => slugify(c.name));
  return [...new Set(slugs)].join('-');
}
```

- [ ] **Step 4: Add `extractZipFolderSync` helper after `slugBundleName`**

```typescript
/**
 * Synchronously extracts all entries under `{prefix}{folderName}/` from the zip
 * into `{destParent}/{folderName}/`, overwriting existing files.
 * Used to install bundle components without re-zipping.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractZipFolderSync(zip: any, prefix: string, folderName: string, destParent: string): void {
  const entryPrefix = prefix + folderName + '/';
  const destFolder = path.join(destParent, folderName);
  fs.mkdirSync(destFolder, { recursive: true });

  const entries: string[] = Object.keys(zip.entries());
  for (const entry of entries) {
    if (!entry.startsWith(entryPrefix)) continue;
    const relativePath = entry.slice(entryPrefix.length);
    if (!relativePath) continue; // skip the directory entry itself

    const destPath = path.join(destFolder, relativePath);
    if (entry.endsWith('/')) {
      fs.mkdirSync(destPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const data = zip.entryDataSync(entry);
      fs.writeFileSync(destPath, data);
    }
  }
}
```

- [ ] **Step 5: Update `findCollidingSite` to check all components**

Replace the existing `findCollidingSite` function with:

```typescript
function findCollidingSite(components: ZipComponent[]): LocalSite | null {
  const cradle = getCradle();
  if (!cradle) return null;
  let sites: LocalSite[];
  try {
    sites = Object.values(cradle.siteData.getSites());
  } catch (_) {
    return null;
  }
  for (const component of components) {
    const subdir = component.type === 'theme' ? 'themes' : 'plugins';
    for (const site of sites) {
      const checkPath = path.join(site.longPath, 'app', 'public', 'wp-content', subdir, component.folder);
      if (fs.existsSync(checkPath)) return site;
    }
  }
  return null;
}
```

- [ ] **Step 6: Update the `wordPressInstaller:standardInstall` hook**

Replace the entire hook with:

```typescript
context.hooks.addAction('wordPressInstaller:standardInstall', async (...args: unknown[]) => {
  const site = args[0] as LocalSite;
  if (!pendingZip) return;
  if (site.name !== pendingZip.expectedSiteName) return;

  const { filePath, components, prefix, demoContentEntries } = pendingZip;
  clearPendingZip();

  logger.info(`[zip-launcher] Post-install: installing ${components.length} component(s) on "${site.name}"`);

  const cradle = getCradle();
  if (!cradle || !cradle.wpCli) {
    logger.warn('[zip-launcher] wpCli not available');
    sendToRenderer('showToast', {
      toastTrigger: 'import',
      toastType: 'error',
      message: `Couldn't activate components — WP-CLI unavailable. Install manually from WP admin.`,
    });
    sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
    return;
  }

  // Open zip once for all component extractions.
  let zip: unknown;
  try {
    zip = await openZip(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[zip-launcher] Could not open zip for extraction', err);
    sendToRenderer('showToast', {
      toastTrigger: 'import',
      toastType: 'error',
      message: `Couldn't open zip for installation: ${message}`,
    });
    sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
    return;
  }

  let anyInstalled = false;
  try {
    for (const component of components) {
      const subdir = component.type === 'theme' ? 'themes' : 'plugins';
      const destParent = path.join(site.longPath, 'app', 'public', 'wp-content', subdir);
      sendToRenderer('updateSiteMessage', site.id, `Installing ${component.name}…`);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extractZipFolderSync(zip as any, prefix, component.folder, destParent);
        await cradle.wpCli.run(site, [component.type, 'activate', component.folder]);
        logger.info(`[zip-launcher] Activated ${component.type} "${component.name}"`);
        anyInstalled = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[zip-launcher] Failed to install ${component.type} "${component.name}": ${message}`);
        sendToRenderer('showToast', {
          toastTrigger: 'import',
          toastType: 'error',
          message: `Couldn't install ${component.type} "${component.name}": ${message}`,
        });
      }
    }
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (zip as any).close();
  }

  if (anyInstalled) {
    await importDemoContent(filePath, demoContentEntries || [], site, cradle.wpCli, logger);
  }
  sendToRenderer('updateSiteMessage', site.id, null);
  sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
});
```

- [ ] **Step 7: Update the `zip-launcher:process` IPC handler**

Replace the entire `ipcMain.handle('zip-launcher:process', ...)` block with:

```typescript
ipcMain.handle('zip-launcher:process', async (_event: unknown, data: unknown) => {
  const { filePath } = data as { filePath: unknown };

  if (!validateFilePath(filePath)) {
    logger.warn(`[zip-launcher] Invalid file path rejected: ${filePath}`);
    return { error: 'Invalid file path.' };
  }

  logger.info(`[zip-launcher] Analyzing: ${filePath}`);

  let bundle: ZipBundle | null;
  try {
    bundle = await analyzeZip(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[zip-launcher] analyzeZip error: ${message}`);
    return { passthrough: true };
  }

  if (!bundle) {
    logger.info('[zip-launcher] Not a theme or plugin zip — passing through');
    return { passthrough: true };
  }

  const { components, demoContentEntries, prefix } = bundle;
  const componentSummary = components.map((c) => `${c.type}:${c.name}`).join(', ');
  logger.info(`[zip-launcher] Detected ${components.length} component(s): ${componentSummary}`);

  // --- Collision detection (checks all components, returns on first match) ---
  const collidingSite = findCollidingSite(components);
  if (collidingSite) {
    const { response } = await dialog.showMessageBox((global as any).mainWindow || undefined, {
      type: 'question',
      title: 'Already installed',
      message: components.length > 1
        ? `Components from this bundle are already installed on ${collidingSite.name}.`
        : `"${components[0].name}" is already installed on ${collidingSite.name}.`,
      detail: 'Update it there, or create a new site?',
      buttons: ['Update existing', 'Create new site', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });

    if (response === 2) {
      logger.info('[zip-launcher] User cancelled');
      return { ok: true };
    }

    if (response === 0) {
      const cradle = getCradle();
      if (!cradle || !cradle.wpCli) {
        sendToRenderer('showToast', {
          toastTrigger: 'import',
          toastType: 'error',
          message: 'WP-CLI unavailable — cannot update.',
        });
        return { ok: true };
      }

      if (!isSiteRunning(collidingSite)) {
        sendToRenderer('updateSiteMessage', collidingSite.id, `Starting ${collidingSite.name}…`);
        try {
          await cradle.siteProcessManager.start(collidingSite);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[zip-launcher] Could not start site: ${message}`);
          sendToRenderer('updateSiteMessage', collidingSite.id, null);
          sendToRenderer('showToast', {
            toastTrigger: 'import',
            toastType: 'error',
            message: `Couldn't start "${collidingSite.name}". Start it manually and drop the zip again.`,
          });
          return { ok: true };
        }
      }

      // Update: extract-then-activate for bundles; --force for single-component zips.
      const zip = await openZip(filePath);
      try {
        for (const component of components) {
          const subdir = component.type === 'theme' ? 'themes' : 'plugins';
          const destParent = path.join(collidingSite.longPath, 'app', 'public', 'wp-content', subdir);
          sendToRenderer('updateSiteMessage', collidingSite.id, `Updating ${component.name}…`);

          if (components.length > 1) {
            // Bundle: extract-then-activate
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              extractZipFolderSync(zip as any, prefix, component.folder, destParent);
              await cradle.wpCli.run(collidingSite, [component.type, 'activate', component.folder]);
              logger.info(`[zip-launcher] Updated ${component.type} "${component.name}"`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              sendToRenderer('showToast', {
                toastTrigger: 'import',
                toastType: 'error',
                message: `Couldn't update "${component.name}": ${message}`,
              });
            }
          } else {
            // Single-component: use WP-CLI --force (proven path)
            try {
              await cradle.wpCli.run(collidingSite, [component.type, 'install', filePath, '--force']);
              logger.info(`[zip-launcher] Updated ${component.type} "${component.name}" via --force`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              sendToRenderer('showToast', {
                toastTrigger: 'import',
                toastType: 'error',
                message: `Couldn't update "${component.name}": ${message}`,
              });
            }
          }
        }
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (zip as any).close();
      }

      await importDemoContent(filePath, demoContentEntries || [], collidingSite, cradle.wpCli, logger);
      sendToRenderer('updateSiteMessage', collidingSite.id, null);
      sendToRenderer('goToRoute', `/main/site-info/${collidingSite.id}/overview`);
      return { ok: true };
    }

    logger.info('[zip-launcher] User chose to create a new site despite collision');
  }

  // --- Create new site ---
  const baseSlug = slugBundleName(components);
  let slug: string;
  try {
    slug = getUniqueSlug(baseSlug, getExistingSiteNames());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }

  const sitePath = path.join(getSitesDir(), slug);
  const adminPassword = crypto.randomBytes(8).toString('hex');

  setPendingZip({ filePath, components, prefix, expectedSiteName: slug, demoContentEntries });

  ipcMain.emit('addSite', {}, {
    newSiteInfo: {
      siteName: slug,
      sitePath,
      siteDomain: `${slug}.local`,
      multiSite: '',
    },
    wpCredentials: {
      adminUsername: 'admin',
      adminPassword,
      adminEmail: 'admin@example.com',
    },
    goToSite: false,
    installWP: true,
  });

  logger.info(`[zip-launcher] addSite emitted for "${slug}" (${components.length} component(s))`);
  return { ok: true };
});
```

- [ ] **Step 8: Verify full build and tests pass**

```bash
cd /Users/jeremy.pollock/development/wpengine/local-addon-zip-launcher && npm run build 2>&1 | tail -5 && npm test 2>&1 | tail -5
```

Expected: clean build, 46 tests pass.

- [ ] **Step 9: Commit**

```bash
cd /Users/jeremy.pollock/development/wpengine/local-addon-zip-launcher
git add src/main/index.ts
git commit -m "feat: install all bundle components via extract-then-activate"
```

---

## Task 3: Version bump + release

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add v0.3.1 entry to `CHANGELOG.md`**

Insert this block at the top of the version entries (after the preamble, before `## [0.3.0]`):

```markdown
## [0.3.1] - 2026-05-06

### Added
- Bundle detection — zips containing multiple components (theme + plugin) under a common wrapper directory are now fully handled
- `stripCommonPrefix` strips wrapper directories (e.g. `wp/`) before detection, fixing depth issues
- All detected components installed on one site in a single drop: plugins first, then themes
- Site name derived from component names, deduplicated and joined (e.g. `markshare` or `astra-woocommerce`)
- Extract-then-activate install pattern for bundles (no re-zipping required)
- Collision detection checks all bundle components, not just the first
```

- [ ] **Step 2: Bump version and push**

```bash
cd /Users/jeremy.pollock/development/wpengine/local-addon-zip-launcher
npm version 0.3.1 --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: bump version to 0.3.1"
git tag v0.3.1
git push origin main --tags
```

Expected: tag `v0.3.1` pushed, GitHub Actions release workflow queued.

- [ ] **Step 3: Verify release workflow**

```bash
gh run list --repo jpollock/local-addon-zip-launcher --limit 3 2>/dev/null
```

Expected: Release workflow `in_progress` or `completed success`.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `stripCommonPrefix` function | Task 1, Step 3 |
| `ZipComponent` interface | Task 1, Step 3 |
| `ZipBundle` interface (with `prefix`) | Task 1, Step 3 |
| `analyzeZip` returns `ZipBundle \| null` | Task 1, Step 4 |
| Exhaustive detection (both theme + plugin passes) | Task 1, Step 4 |
| Plugins sorted before themes | Task 1, Step 4 |
| Demo content from raw (pre-strip) names | Task 1, Step 4 |
| `slugBundleName` (deduplicate + join) | Task 2, Step 3 |
| `extractZipFolderSync` helper | Task 2, Step 4 |
| `findCollidingSite` checks all components | Task 2, Step 5 |
| Hook: extract-then-activate per component | Task 2, Step 6 |
| Hook: open zip once for all extractions | Task 2, Step 6 |
| Hook: partial failure continues | Task 2, Step 6 |
| IPC: bundle collision dialog message adapts | Task 2, Step 7 |
| IPC: bundle update uses extract-then-activate | Task 2, Step 7 |
| IPC: single-component update uses `--force` | Task 2, Step 7 |
| IPC: site name via `slugBundleName` | Task 2, Step 7 |
| `stripCommonPrefix` tests (7 cases) | Task 1, Step 1 |
| Version 0.3.1 | Task 3 |

**Placeholder scan:** None. All steps contain complete code.

**Type consistency:**
- `ZipComponent.folder` = post-strip WordPress folder name (used for WP-CLI and `wp-content` path) — consistent across `analyzeZip`, `findCollidingSite`, `extractZipFolderSync`, hook, and IPC handler.
- `ZipBundle.prefix` = raw prefix string (e.g. `'wp/'`) — consistent in `analyzeZip` return, `PendingZip` storage, `extractZipFolderSync` call, and update path.
- `PendingZip.components: ZipComponent[]` — matches hook destructuring and hook loop.
