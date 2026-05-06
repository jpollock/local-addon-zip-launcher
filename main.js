'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const StreamZip = require('node-stream-zip');

let LocalMain;
try {
	LocalMain = require('@getflywheel/local/main');
} catch (e) {
	// Will be required at runtime inside Local
}

// State for the zip being installed — cleared after the hook fires.
let pendingZip = null;

/**
 * Read the first `maxBytes` of a zip entry as a string.
 */
function readEntryText(zip, entryName, maxBytes = 8192) {
	return new Promise((resolve, reject) => {
		zip.stream(entryName, (err, stream) => {
			if (err) return reject(err);
			const chunks = [];
			let total = 0;
			stream.on('data', (chunk) => {
				chunks.push(chunk);
				total += chunk.length;
				if (total >= maxBytes) stream.destroy();
			});
			stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8', 0, maxBytes)));
			stream.on('close', () => resolve(Buffer.concat(chunks).toString('utf8', 0, maxBytes)));
			stream.on('error', reject);
		});
	});
}

/**
 * Parse a WordPress file header value, e.g. "Theme Name: Astra" → "Astra".
 */
function parseHeader(text, key) {
	const match = text.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+)$`, 'm'));
	return match ? match[1].trim() : null;
}

/**
 * Inspect a zip for WordPress theme or plugin headers.
 * Returns { type: 'theme'|'plugin', name: string } or null.
 */
async function analyzeZip(filePath) {
	const zip = new StreamZip.async({ file: filePath });
	try {
		const entries = await zip.entries();
		const names = Object.keys(entries);

		// Only look one folder deep (root or single-directory wrapper like "astra/style.css")
		const isShallow = (name) => name.split('/').filter(Boolean).length <= 2;
		const shallow = names.filter(isShallow);

		// --- Theme detection: look for style.css with "Theme Name:" header ---
		const styleCss = shallow.find((n) => n.replace(/^[^/]+\//, '') === 'style.css' || n === 'style.css');
		if (styleCss) {
			const text = await readEntryText(zip, styleCss);
			const name = parseHeader(text, 'Theme Name');
			if (name) return { type: 'theme', name };
		}

		// --- Plugin detection: look for a PHP file with "Plugin Name:" header ---
		const phpFiles = shallow.filter((n) => n.endsWith('.php') && n.split('/').filter(Boolean).length <= 2);
		for (const phpFile of phpFiles) {
			const text = await readEntryText(zip, phpFile);
			const name = parseHeader(text, 'Plugin Name');
			if (name) return { type: 'plugin', name };
		}

		return null;
	} finally {
		await zip.close();
	}
}

/**
 * Convert a display name to a URL/filesystem-safe slug.
 * "My Awesome Theme" → "my-awesome-theme"
 */
function slugify(name) {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Return a slug that doesn't collide with any existing site name.
 * Appends -2, -3 ... -99 until unique.
 */
function getUniqueSlug(base, siteData) {
	const sites = Object.values(siteData.getSites ? siteData.getSites() : {});
	const existingNames = new Set(sites.map((s) => s.name));

	if (!existingNames.has(base)) return base;
	for (let i = 2; i <= 99; i++) {
		const candidate = `${base}-${i}`;
		if (!existingNames.has(candidate)) return candidate;
	}
	throw new Error(`Could not find a unique name for "${base}" after 99 attempts.`);
}

/**
 * Resolve the user's configured Local Sites directory.
 */
function getSitesDir(userData) {
	const raw = userData.get('settings.sitesPath') || '~/Local Sites/';
	return raw.replace(/^~/, os.homedir()).replace(/\/$/, '');
}

module.exports = function zipLauncher(context) {
	const logger = (context.environment && context.environment.logger) || console;

	// Delay service resolution until after Local's container is fully wired.
	function getServices() {
		const cradle = LocalMain.getServiceContainer().cradle;
		return {
			siteData: cradle.siteData,
			userData: cradle.userData,
			wpCli: cradle.wpCli,
			addSiteService: cradle.addSite,
			sendIPCEvent: cradle.sendIPCEvent,
			localLogger: cradle.localLogger || logger,
		};
	}

	// --- Lifecycle hook: fires after WordPress is installed on any new site ---
	context.hooks.addAction('wordPressInstaller:standardInstall', async (site) => {
		if (!pendingZip) return;
		if (site.name !== pendingZip.expectedSiteName) return;

		const { filePath, type, name } = pendingZip;
		pendingZip = null; // clear before any await to prevent double-fire

		const { wpCli, sendIPCEvent, localLogger } = getServices();

		try {
			localLogger.info(`[zip-launcher] Installing ${type} "${name}" on site "${site.name}"`);

			if (type === 'theme') {
				await wpCli.run(site, ['theme', 'install', filePath, '--activate']);
			} else {
				await wpCli.run(site, ['plugin', 'install', filePath, '--activate']);
			}

			sendIPCEvent('goToRoute', `/main/site-info/${site.id}/overview`);
		} catch (err) {
			localLogger.error('[zip-launcher] WP-CLI install failed', err);
			sendIPCEvent('showToast', {
				toastType: 'error',
				message: `Couldn't install "${name}". The zip is at ${filePath} — you can install it manually from WordPress admin.`,
			});
			// Still navigate to the site — it exists, just without the zip installed.
			sendIPCEvent('goToRoute', `/main/site-info/${site.id}/overview`);
		}
	});

	// --- IPC handler: called by renderer when a zip is dropped ---
	ipcMain.handle('zip-launcher:process', async (_event, { filePath }) => {
		const { siteData, userData, addSiteService, localLogger } = getServices();

		logger.info(`[zip-launcher] Processing dropped zip: ${filePath}`);

		let detected;
		try {
			detected = await analyzeZip(filePath);
		} catch (err) {
			localLogger.warn('[zip-launcher] Could not read zip, passing through', err);
			return { passthrough: true };
		}

		if (!detected) {
			localLogger.info('[zip-launcher] Not a theme or plugin zip, passing through');
			return { passthrough: true };
		}

		const { type, name } = detected;
		localLogger.info(`[zip-launcher] Detected ${type}: "${name}"`);

		let slug;
		try {
			slug = getUniqueSlug(slugify(name), siteData);
		} catch (err) {
			localLogger.error('[zip-launcher] Name collision', err);
			return { error: err.message };
		}

		const sitePath = path.join(getSitesDir(userData), slug);

		pendingZip = { filePath, type, name, expectedSiteName: slug };

		try {
			await addSiteService.addSite({
				newSiteInfo: {
					siteName: slug,
					sitePath,
					siteDomain: `${slug}.local`,
					multiSite: 'no',
				},
				wpCredentials: {
					adminUsername: 'admin',
					adminPassword: 'admin',
					adminEmail: 'admin@example.com',
				},
				goToSite: false,
				installWP: true,
			});
		} catch (err) {
			localLogger.error('[zip-launcher] addSite failed', err);
			pendingZip = null;
			return { error: err.message };
		}

		return { success: true };
	});
};
