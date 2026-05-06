# Design: Bundle Detection (Multi-Component Zips)

**Date:** 2026-05-06  
**Status:** Approved

## Overview

Extend `local-addon-zip-launcher` to handle "product bundle" zips — zips that contain both a WordPress plugin and a companion theme (and optional demo content) nested under a common wrapper directory. Both components are installed on a single new site.

**Trigger:** A zip like `Markdown content sharing website.zip` containing:
```
wp/
  markshare-theme/style.css      → Theme Name: MarkShare
  markshare/markshare.php        → Plugin Name: MarkShare
  markshare/markshare-sample.xml → WXR demo content
```

Currently passes through as "not a theme or plugin zip" because the `wp/` wrapper pushes components to depth 3.

---

## Section 1: analyzeZip Changes

### Wrapper stripping

Before any detection, strip the longest common directory prefix shared by all zip entries.

```
function stripCommonPrefix(names: string[]): { stripped: string[], prefix: string }
```

`['wp/markshare-theme/style.css', 'wp/markshare/markshare.php']`  
→ common prefix: `wp/`  
→ stripped: `['markshare-theme/style.css', 'markshare/markshare.php']`

Stripping is applied only for detection analysis. The original entry names are preserved for extraction.

### Multi-component return type

```typescript
export interface ZipComponent {
  type: 'theme' | 'plugin';
  name: string;
  folder: string;           // original (pre-strip) folder name in the zip
}

export interface ZipBundle {
  components: ZipComponent[]; // all detected themes and plugins, plugins first
  demoContentEntries: string[]; // unchanged — scanned from raw (pre-strip) names
}
```

`analyzeZip` returns `ZipBundle | null`. `null` = nothing detected (unchanged passthrough).

Single-component zips return a `ZipBundle` with one item in `components` — no breaking change in `main.ts` logic, just destructuring changes.

### Detection pass

After stripping, run both theme and plugin passes exhaustively (don't stop at first match). Collect all results. Sort: plugins before themes (install order requirement).

---

## Section 2: Site Naming + Install Order

### Site name

Collect `name` from each component, slugify, deduplicate, join with `-`:

- `[MarkShare, MarkShare]` → `markshare`
- `[Astra, WooCommerce]` → `astra-woocommerce`

### Install order

Plugins first, then themes, within each type in detection order. Ensures companion themes can rely on the plugin being active at activation time.

### Component installation (in the post-install hook)

WP-CLI's `wp theme/plugin install` accepts a zip path but the original zip contains multiple components. **Do not re-zip.** Instead:

1. Open the original zip
2. For each component, extract its folder (all entries matching `{folder}/**`) to a temp directory
3. Copy the extracted folder directly into `{site.longPath}/app/public/wp-content/{themes|plugins}/{folder}`
4. Run `wp {type} activate {folder}` (no install step needed — files are already in place)
5. Delete temp directory for that component

This avoids creating intermediate zip files and is faster.

---

## Section 3: Error Handling + Demo Content

### Partial failure

If one component fails to extract or activate, continue with remaining components. Show an error toast per failure. Always navigate to the site at the end — it exists and partial installs are better than nothing.

### Demo content

Unchanged. WXR scan uses the raw (pre-strip) names at depth ≤ 3, so `wp/markshare/markshare-sample.xml` is already found. No depth changes needed.

### Collision detection

`findCollidingSite` checks each component's folder against `wp-content/themes` or `wp-content/plugins`. First match triggers the dialog. On "Update existing," all components are updated on that site using `wp {type} install --force` (current zip-install approach still works for single-component updates; for bundles, use the extract-then-activate pattern).

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/zip-analyzer.ts` | Add `stripCommonPrefix`, `ZipComponent`, `ZipBundle` types; update `analyzeZip` to return `ZipBundle \| null` |
| `src/main/index.ts` | Update `pendingZip` to hold `components: ZipComponent[]`; update hook to extract+activate each component; update collision check and IPC handler to use `ZipBundle` |
| `tests/zip-analyzer.test.ts` | Tests for `stripCommonPrefix`; update `analyzeZip` return shape expectations |

`renderer.js` — **not touched**.

---

## What Does Not Change

- Passthrough behavior for non-bundle zips
- Demo content import flow
- Collision dialog copy and button layout
- Site creation via `ipcMain.emit('addSite')`
- Progress bar messages (adapt text to show component count when > 1)
