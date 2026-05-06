'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const StreamZip = require('node-stream-zip');

// Pending zip — set by renderer before addSite fires, cleared after hook runs.
let pendingZip = null;

// ---------------------------------------------------------------------------
// Zip analysis helpers
// ---------------------------------------------------------------------------

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

function parseHeader(text, key) {
	const match = text.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+)$`, 'm'));
	return match ? match[1].trim() : null;
}

async function analyzeZip(filePath) {
	const zip = new StreamZip.async({ file: filePath });
	try {
		const entries = await zip.entries();
		const names = Object.keys(entries);

		// Only look one folder deep.
		const shallow = names.filter((n) => n.split('/').filter(Boolean).length <= 2);

		// Theme: style.css with "Theme Name:" header
		const styleCss = shallow.find((n) => {
			const parts = n.split('/').filter(Boolean);
			return parts[parts.length - 1] === 'style.css';
		});
		if (styleCss) {
			const text = await readEntryText(zip, styleCss);
			const name = parseHeader(text, 'Theme Name');
			if (name) return { type: 'theme', name };
		}

		// Plugin: root-level PHP file with "Plugin Name:" header
		const phpFiles = shallow.filter((n) => {
			const parts = n.split('/').filter(Boolean);
			return parts.length <= 2 && parts[parts.length - 1].endsWith('.php');
		});
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

function slugify(name) {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function getUniqueSlug(base, existingNames) {
	if (!existingNames.has(base)) return base;
	for (let i = 2; i <= 99; i++) {
		const candidate = `${base}-${i}`;
		if (!existingNames.has(candidate)) return candidate;
	}
	throw new Error(`Could not find a unique name for "${base}" after 99 attempts.`);
}

// ---------------------------------------------------------------------------
// Optional service container access — fails gracefully
// ---------------------------------------------------------------------------

function tryGetServiceContainer() {
	try {
		const LocalMain = require('@getflywheel/local/main');
		return LocalMain.getServiceContainer().cradle;
	} catch (_) {
		return null;
	}
}

function getSitesDir() {
	const cradle = tryGetServiceContainer();
	if (cradle) {
		try {
			const raw = cradle.userData.get('settings.sitesPath') || '~/Local Sites/';
			return raw.replace(/^~/, os.homedir()).replace(/\/$/, '');
		} catch (_) {}
	}
	return path.join(os.homedir(), 'Local Sites');
}

function getExistingSiteNames() {
	const cradle = tryGetServiceContainer();
	if (cradle) {
		try {
			const sites = Object.values(cradle.siteData.getSites());
			return new Set(sites.map((s) => s.name));
		} catch (_) {}
	}
	return new Set();
}

// Send a message to the renderer via Local's global mainWindow.
function sendToRenderer(channel, ...args) {
	if (global.mainWindow) {
		global.mainWindow.webContents.send(channel, ...args);
	}
}

// ---------------------------------------------------------------------------
// Addon entry point
// ---------------------------------------------------------------------------

module.exports = function zipLauncher(context) {
	const logger = (context.environment && context.environment.logger) || console;

	// --- Post-install hook ---------------------------------------------------
	// Fires after WordPress is fully installed on any new site.
	context.hooks.addAction('wordPressInstaller:standardInstall', async (site) => {
		if (!pendingZip) return;
		if (site.name !== pendingZip.expectedSiteName) return;

		const { filePath, type, name } = pendingZip;
		pendingZip = null;

		logger.info(`[zip-launcher] Post-install: installing ${type} "${name}" on "${site.name}"`);

		const cradle = tryGetServiceContainer();
		if (!cradle || !cradle.wpCli) {
			logger.warn('[zip-launcher] wpCli not available — cannot activate zip');
			sendToRenderer('showToast', {
				toastType: 'error',
				message: `Couldn't activate "${name}" — WP-CLI unavailable. Install it manually from WordPress admin. Zip at: ${filePath}`,
			});
			sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
			return;
		}

		try {
			if (type === 'theme') {
				await cradle.wpCli.run(site, ['theme', 'install', filePath, '--activate']);
			} else {
				await cradle.wpCli.run(site, ['plugin', 'install', filePath, '--activate']);
			}
			sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
		} catch (err) {
			logger.error('[zip-launcher] WP-CLI install failed', err);
			sendToRenderer('showToast', {
				toastType: 'error',
				message: `Couldn't install "${name}". Zip at: ${filePath} — install manually from WordPress admin.`,
			});
			sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
		}
	});

	// --- IPC: store pending zip state ----------------------------------------
	// Called by the renderer immediately before it sends 'addSite'.
	ipcMain.on('zip-launcher:set-pending', (_event, data) => {
		logger.info(`[zip-launcher] Pending: ${data.type} "${data.name}" → site "${data.siteName}"`);
		pendingZip = {
			filePath: data.filePath,
			type: data.type,
			name: data.name,
			expectedSiteName: data.siteName,
		};
	});

	// --- IPC: analyze zip ----------------------------------------------------
	// Renderer calls this, gets back detection result + site creation params.
	// No service container needed for the analysis itself.
	ipcMain.handle('zip-launcher:analyze', async (_event, { filePath }) => {
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

		const { type, name } = detected;
		const base = slugify(name);
		const existingNames = getExistingSiteNames();

		let slug;
		try {
			slug = getUniqueSlug(base, existingNames);
		} catch (err) {
			return { error: err.message };
		}

		const sitePath = path.join(getSitesDir(), slug);

		logger.info(`[zip-launcher] Detected ${type}: "${name}" → slug "${slug}"`);
		return { type, name, slug, sitePath };
	});
};
