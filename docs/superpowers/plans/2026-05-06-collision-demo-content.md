# Collision Detection + Demo Content Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add collision detection (existing site dialog) and automatic WXR demo-content import to `local-addon-zip-launcher`.

**Architecture:** `analyzeZip` gains two new return fields (`folder`, `demoContentEntries`). The main IPC handler uses the folder to check for an existing site on disk, presents a native Electron dialog on collision, and routes to an update or create-new flow. Demo content import runs at the end of both flows via a shared `importDemoContent` helper.

**Tech Stack:** Node.js (fs, crypto, os, path), node-stream-zip v1.15.0, Electron (ipcMain, dialog), Local WP-CLI service.

---

## File Map

| File | Role |
|---|---|
| `lib/zip-analyzer.js` | Add `extractFolder`, `isWxr`, `findWxrCandidates`; update `analyzeZip` return shape |
| `tests/zip-analyzer.test.js` | Tests for new pure functions |
| `main.js` | Add `findCollidingSite`, `isSiteRunning`, `importDemoContent`; update IPC handler and post-install hook |

`renderer.js` — **not touched**.

---

## Task 1: Add pure helpers to `lib/zip-analyzer.js`

**Files:**
- Modify: `lib/zip-analyzer.js`

These are all pure functions — no I/O, fully unit-testable.

- [ ] **Step 1: Write the failing tests first** (see Task 2 — write tests before changing `zip-analyzer.js`)

- [ ] **Step 2: Add `extractFolder` after the `parseHeader` function**

```js
// Returns the first path component of any zip entry — the on-disk theme/plugin folder name.
// e.g. entries ['pm-bulletin/style.css', 'pm-bulletin/functions.php'] → 'pm-bulletin'
function extractFolder(names) {
	for (const n of names) {
		const parts = n.split('/').filter(Boolean);
		if (parts.length >= 1) return parts[0];
	}
	return '';
}
```

- [ ] **Step 3: Add `isWxr` after `extractFolder`**

```js
// Returns true if text contains the two markers present in every WXR export file.
function isWxr(text) {
	return text.includes('<rss') && text.includes('xmlns:excerpt');
}
```

- [ ] **Step 4: Add `findWxrCandidates` after `isWxr`**

```js
// Returns zip entry names that could be WXR files: .xml, depth ≤ 3, no traversal.
function findWxrCandidates(names) {
	return names.filter((n) =>
		!n.includes('..') &&
		!path.isAbsolute(n) &&
		n.toLowerCase().endsWith('.xml') &&
		n.split('/').filter(Boolean).length <= 3,
	);
}
```

- [ ] **Step 5: Update `analyzeZip` to populate `folder` and `demoContentEntries`**

Replace the existing `analyzeZip` function body with:

```js
async function analyzeZip(filePath) {
	const zip = await openZip(filePath);
	try {
		const names = Object.keys(zip.entries());

		const folder = extractFolder(names);

		// Reject traversal entries, limit theme/plugin detection to depth ≤ 2.
		const shallow = names.filter((n) =>
			!n.includes('..') &&
			!path.isAbsolute(n) &&
			n.split('/').filter(Boolean).length <= 2,
		);

		// Theme: style.css with "Theme Name:" header
		const styleCss = shallow.find((n) => {
			const parts = n.split('/').filter(Boolean);
			return parts[parts.length - 1] === 'style.css';
		});
		if (styleCss) {
			const text = await readEntryText(zip, styleCss);
			const name = parseHeader(text, 'Theme Name');
			if (name) {
				const demoContentEntries = await detectDemoContent(zip, names);
				return { type: 'theme', name, folder, demoContentEntries };
			}
		}

		// Plugin: PHP file with "Plugin Name:" header
		const phpFiles = shallow.filter((n) => n.endsWith('.php'));
		for (const phpFile of phpFiles) {
			const text = await readEntryText(zip, phpFile);
			const name = parseHeader(text, 'Plugin Name');
			if (name) {
				const demoContentEntries = await detectDemoContent(zip, names);
				return { type: 'plugin', name, folder, demoContentEntries };
			}
		}

		return null;
	} finally {
		zip.close();
	}
}
```

- [ ] **Step 6: Add `detectDemoContent` helper (place it before `analyzeZip`)**

```js
async function detectDemoContent(zip, names) {
	const candidates = findWxrCandidates(names);
	const wxrEntries = [];
	for (const candidate of candidates) {
		try {
			const text = await readEntryText(zip, candidate, 2048);
			if (isWxr(text)) wxrEntries.push(candidate);
		} catch (_) {
			// Unreadable entry — skip silently
		}
	}
	return wxrEntries;
}
```

- [ ] **Step 7: Update `module.exports` to export the new helpers**

```js
module.exports = {
	validateFilePath,
	openZip,
	readEntryText,
	parseHeader,
	extractFolder,
	isWxr,
	findWxrCandidates,
	analyzeZip,
	slugify,
	getUniqueSlug,
};
```

---

## Task 2: Tests for new pure functions

**Files:**
- Modify: `tests/zip-analyzer.test.js`

Add these three `describe` blocks **before** the existing `slugify` block. Write them first (TDD), run to confirm they fail, then go back to Task 1.

- [ ] **Step 1: Add `extractFolder` tests**

```js
const { validateFilePath, parseHeader, extractFolder, isWxr, findWxrCandidates, slugify, getUniqueSlug } = require('../lib/zip-analyzer');

// (update the existing require line at the top of the file to include the new exports)

describe('extractFolder', () => {
	test('returns the root folder from a single-root zip', () => {
		expect(extractFolder(['pm-bulletin/style.css', 'pm-bulletin/functions.php'])).toBe('pm-bulletin');
	});

	test('works for depth-1 root files (flat zip)', () => {
		expect(extractFolder(['style.css', 'functions.php'])).toBe('style.css');
	});

	test('returns first component of a deeply nested entry', () => {
		expect(extractFolder(['my-theme/demo/content.xml'])).toBe('my-theme');
	});

	test('returns empty string for an empty names array', () => {
		expect(extractFolder([])).toBe('');
	});
});
```

- [ ] **Step 2: Add `isWxr` tests**

```js
describe('isWxr', () => {
	test('returns true for text containing both WXR markers', () => {
		const wxr = '<?xml version="1.0"?>\n<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/">';
		expect(isWxr(wxr)).toBe(true);
	});

	test('returns false when rss marker is absent', () => {
		const notWxr = '<?xml version="1.0"?>\n<feed xmlns:excerpt="http://wordpress.org/export/">';
		expect(isWxr(notWxr)).toBe(false);
	});

	test('returns false when xmlns:excerpt marker is absent', () => {
		const notWxr = '<?xml version="1.0"?>\n<rss version="2.0">';
		expect(isWxr(notWxr)).toBe(false);
	});

	test('returns false for empty string', () => {
		expect(isWxr('')).toBe(false);
	});
});
```

- [ ] **Step 3: Add `findWxrCandidates` tests**

```js
describe('findWxrCandidates', () => {
	test('includes xml files at depth 1', () => {
		expect(findWxrCandidates(['demo.xml'])).toEqual(['demo.xml']);
	});

	test('includes xml files at depth 3', () => {
		expect(findWxrCandidates(['theme/demo/content.xml'])).toEqual(['theme/demo/content.xml']);
	});

	test('excludes xml files deeper than depth 3', () => {
		expect(findWxrCandidates(['a/b/c/d.xml'])).toEqual([]);
	});

	test('excludes non-xml files', () => {
		expect(findWxrCandidates(['theme/demo/content.json'])).toEqual([]);
	});

	test('excludes entries with path traversal', () => {
		expect(findWxrCandidates(['../evil.xml'])).toEqual([]);
	});

	test('excludes absolute paths', () => {
		expect(findWxrCandidates(['/etc/passwd.xml'])).toEqual([]);
	});

	test('is case-insensitive for the .xml extension', () => {
		expect(findWxrCandidates(['theme/demo/CONTENT.XML'])).toEqual(['theme/demo/CONTENT.XML']);
	});
});
```

- [ ] **Step 4: Run tests to confirm new tests fail (functions not yet exported)**

```bash
cd /Users/jeremy.pollock/development/wpengine/local-addon-zip-launcher
npm test
```

Expected: failures for `extractFolder`, `isWxr`, `findWxrCandidates`.

- [ ] **Step 5: Go implement Task 1 (Steps 2–7)**

- [ ] **Step 6: Run tests to confirm all pass**

```bash
npm test
```

Expected: all tests pass including 22 existing + 15 new = 37 total.

- [ ] **Step 7: Commit**

```bash
git add lib/zip-analyzer.js tests/zip-analyzer.test.js
git commit -m "feat: analyzeZip returns folder and demoContentEntries"
```

---

## Task 3: Add helpers to `main.js`

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Add `fs` to the requires at the top of `main.js`**

```js
const fs = require('fs');
```

Add this line after `const os = require('os');`.

- [ ] **Step 2: Add `findCollidingSite` after `getExistingSiteNames`**

```js
// Returns the first existing Local site that already has this theme/plugin installed,
// or null if none found. Uses a synchronous filesystem check — works on stopped sites.
function findCollidingSite(type, folder) {
	const cradle = getCradle();
	if (!cradle) return null;
	const subdir = type === 'theme' ? 'themes' : 'plugins';
	let sites;
	try {
		sites = Object.values(cradle.siteData.getSites());
	} catch (_) {
		return null;
	}
	for (const site of sites) {
		const checkPath = path.join(site.longPath, 'app', 'public', 'wp-content', subdir, folder);
		if (fs.existsSync(checkPath)) return site;
	}
	return null;
}
```

- [ ] **Step 3: Add `isSiteRunning` after `findCollidingSite`**

```js
// Returns true if the site's services are running. Uses siteProcessManager from the
// service container; falls back to checking for an nginx PID file.
function isSiteRunning(site) {
	const cradle = getCradle();
	if (cradle && cradle.siteProcessManager) {
		try {
			return cradle.siteProcessManager.getSiteStatus(site) === 'running';
		} catch (_) {}
	}
	// Fallback: nginx PID file exists when the site is running
	return fs.existsSync(path.join(site.longPath, 'logs', 'nginx', 'nginx.pid'));
}
```

- [ ] **Step 4: Add `importDemoContent` after `isSiteRunning`**

```js
// Extracts WXR files from the zip, installs wordpress-importer, and imports them.
// Leaves temp files on disk if import fails so the user can import manually.
async function importDemoContent(filePath, demoContentEntries, site, wpCli, logger) {
	if (!demoContentEntries.length) return;

	const { openZip } = require('./lib/zip-analyzer');
	const zip = await openZip(filePath);
	try {
		for (const entry of demoContentEntries) {
			const tmpFile = path.join(os.tmpdir(), `zip-launcher-${crypto.randomBytes(4).toString('hex')}.xml`);
			let succeeded = false;
			try {
				const data = zip.entryDataSync(entry);
				fs.writeFileSync(tmpFile, data);
				await wpCli.run(site, ['plugin', 'install', 'wordpress-importer', '--activate']);
				await wpCli.run(site, ['import', tmpFile, '--authors=create']);
				succeeded = true;
				logger.info(`[zip-launcher] Imported demo content: ${entry}`);
			} catch (err) {
				logger.error(`[zip-launcher] Demo content import failed for ${entry}: ${err.message}`);
				sendToRenderer('showToast', {
					toastType: 'error',
					message: `Demo content import failed. File saved at ${tmpFile} — import via WP Admin → Tools → Import.`,
				});
			} finally {
				if (succeeded) {
					try { fs.unlinkSync(tmpFile); } catch (_) {}
				}
			}
		}
	} finally {
		zip.close();
	}
}
```

- [ ] **Step 5: Update the `wordPressInstaller:standardInstall` hook to pass `demoContentEntries`**

The hook currently destructures `{ filePath, type, name }` from `pendingZip`. Add `demoContentEntries` and call `importDemoContent` after the WP-CLI install:

```js
context.hooks.addAction('wordPressInstaller:standardInstall', async (site) => {
	if (!pendingZip) return;
	if (site.name !== pendingZip.expectedSiteName) return;

	const { filePath, type, name, demoContentEntries } = pendingZip;
	clearPendingZip();

	logger.info(`[zip-launcher] Post-install: installing ${type} "${name}" on "${site.name}"`);

	const cradle = getCradle();
	if (!cradle || !cradle.wpCli) {
		logger.warn('[zip-launcher] wpCli not available');
		sendToRenderer('showToast', {
			toastType: 'error',
			message: `Couldn't activate "${name}" — WP-CLI unavailable. Install manually from WP admin.`,
		});
		sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
		return;
	}

	try {
		const cmd = type === 'theme' ? 'theme' : 'plugin';
		await cradle.wpCli.run(site, [cmd, 'install', filePath, '--activate']);
		logger.info(`[zip-launcher] Installed and activated ${type} "${name}"`);
	} catch (err) {
		logger.error('[zip-launcher] WP-CLI install failed', err);
		sendToRenderer('showToast', {
			toastType: 'error',
			message: `Couldn't install "${name}". Install manually from WP admin. Zip: ${filePath}`,
		});
	}

	await importDemoContent(filePath, demoContentEntries || [], site, cradle.wpCli, logger);
	sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
});
```

- [ ] **Step 6: Update the `zip-launcher:process` IPC handler**

Replace the entire `ipcMain.handle('zip-launcher:process', ...)` block:

```js
ipcMain.handle('zip-launcher:process', async (_event, data) => {
	const { dialog } = require('electron');

	const filePath = data && data.filePath;
	if (!validateFilePath(filePath)) {
		logger.warn(`[zip-launcher] Invalid file path rejected: ${filePath}`);
		return { error: 'Invalid file path.' };
	}

	logger.info(`[zip-launcher] Analyzing: ${filePath}`);

	let detected;
	try {
		detected = await analyzeZip(filePath);
	} catch (err) {
		logger.warn(`[zip-launcher] analyzeZip error: ${err.message}`);
		return { passthrough: true };
	}

	if (!detected) {
		logger.info('[zip-launcher] Not a theme or plugin zip — passing through');
		return { passthrough: true };
	}

	const { type, name, folder, demoContentEntries } = detected;
	logger.info(`[zip-launcher] Detected ${type}: "${name}" (folder: ${folder})`);

	// --- Collision detection ---------------------------------------------------
	const collidingSite = findCollidingSite(type, folder);
	if (collidingSite) {
		const { response } = await dialog.showMessageBox({
			type: 'question',
			title: 'Already installed',
			message: `"${name}" is already installed on ${collidingSite.name}.`,
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
			// Update existing site
			if (!isSiteRunning(collidingSite)) {
				logger.info(`[zip-launcher] Site "${collidingSite.name}" is not running`);
				sendToRenderer('showToast', {
					toastType: 'error',
					message: `Start "${collidingSite.name}" first, then drop the zip again.`,
				});
				return { ok: true };
			}

			const cradle = getCradle();
			if (!cradle || !cradle.wpCli) {
				sendToRenderer('showToast', {
					toastType: 'error',
					message: 'WP-CLI unavailable — cannot update.',
				});
				return { ok: true };
			}

			const cmd = type === 'theme' ? 'theme' : 'plugin';
			try {
				await cradle.wpCli.run(collidingSite, [cmd, 'install', filePath, '--force']);
				logger.info(`[zip-launcher] Updated ${type} "${name}" on "${collidingSite.name}"`);
			} catch (err) {
				logger.error(`[zip-launcher] --force update failed: ${err.message}`);
				sendToRenderer('showToast', {
					toastType: 'error',
					message: `Couldn't update "${name}": ${err.message}`,
				});
			}

			await importDemoContent(filePath, demoContentEntries, collidingSite, cradle.wpCli, logger);
			sendToRenderer('goToRoute', `/main/site-info/${collidingSite.id}/overview`);
			return { ok: true };
		}

		// response === 1: "Create new site" — fall through to normal create flow
		logger.info('[zip-launcher] User chose to create a new site despite collision');
	}

	// --- Create new site -------------------------------------------------------
	let slug;
	try {
		slug = getUniqueSlug(slugify(name), getExistingSiteNames());
	} catch (err) {
		return { error: err.message };
	}

	const sitePath = path.join(getSitesDir(), slug);
	const adminPassword = crypto.randomBytes(8).toString('hex');

	setPendingZip({ filePath, type, name, folder, expectedSiteName: slug, demoContentEntries });

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

	logger.info(`[zip-launcher] addSite emitted for "${slug}"`);
	return { ok: true };
});
```

- [ ] **Step 7: Run the full test suite to confirm no regressions**

```bash
cd /Users/jeremy.pollock/development/wpengine/local-addon-zip-launcher
npm test
```

Expected: all 37 tests pass.

- [ ] **Step 8: Commit**

```bash
git add main.js
git commit -m "feat: collision detection, update path, demo content import"
```

---

## Task 4: Version bump + end-to-end smoke test

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version to 0.2.0**

In `package.json`, change:
```json
"version": "0.2.0"
```

- [ ] **Step 2: Commit version bump**

```bash
git add package.json
git commit -m "chore: bump version to 0.2.0"
git tag v0.2.0
```

- [ ] **Step 3: Restart Local and smoke test — collision path**

1. Drop `The Great Product Knowledge Site (1).zip` (pm-bulletin already exists on disk)
2. Expected: native dialog appears — "PM Bulletin is already installed on pm-bulletin"
3. Click *Update existing*
4. Expected: site must be running toast, OR WP-CLI runs `--force`, demo content imports, navigate to site

- [ ] **Step 4: Smoke test — create new path**

1. Drop any theme or plugin zip that is NOT installed on any existing site
2. Expected: no dialog, site creation starts immediately, theme/plugin installed, navigate to new site

- [ ] **Step 5: Smoke test — demo content**

1. Drop `The Great Product Knowledge Site (1).zip` and choose *Create new site*
2. Expected: new site created, pm-bulletin theme activated, WXR file at `pm-bulletin/demo/pm-bulletin-demo-content.xml` imported automatically

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `folder` field in `analyzeZip` return | Task 1, Step 2+5 |
| `demoContentEntries` field in `analyzeZip` return | Task 1, Step 4+5 |
| WXR detection: `.xml`, depth ≤ 3, `<rss` + `xmlns:excerpt` | Task 1, Steps 3+4 |
| `folder` extraction from first zip path component | Task 1, Step 2 |
| Filesystem collision check | Task 3, Step 2 |
| Native Electron dialog with 3 buttons | Task 3, Step 6 |
| Update path: `--force` install | Task 3, Step 6 |
| Update path: site-not-running toast | Task 3, Step 6 |
| Update path: demo content import | Task 3, Step 6 |
| Create new path: unchanged | Task 3, Step 6 |
| Demo content import in `standardInstall` hook | Task 3, Steps 4+5 |
| `importDemoContent`: extract → install importer → wp import → cleanup | Task 3, Step 4 |
| temp file preserved on error | Task 3, Step 4 |
| Tests for `extractFolder` | Task 2, Step 1 |
| Tests for `isWxr` | Task 2, Step 2 |
| Tests for `findWxrCandidates` | Task 2, Step 3 |

**Placeholder scan:** None found.

**Type consistency:** `demoContentEntries` is `string[]` throughout — set in `analyzeZip`, stored in `pendingZip`, destructured in hook and IPC handler, passed to `importDemoContent`. `folder` is `string` throughout. Consistent.
