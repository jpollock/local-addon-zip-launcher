'use strict';

const { ipcMain } = require('electron');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { validateFilePath, analyzeZip, slugify, getUniqueSlug } = require('./lib/zip-analyzer');

// ---------------------------------------------------------------------------
// Pending zip state — set atomically before ipcMain.emit('addSite'), cleared
// by the wordPressInstaller:standardInstall hook or by a 5-minute TTL.
// ---------------------------------------------------------------------------

let pendingZip = null;
let pendingZipTimer = null;

function clearPendingZip() {
	if (pendingZipTimer) { clearTimeout(pendingZipTimer); pendingZipTimer = null; }
	pendingZip = null;
}

function setPendingZip(data) {
	clearPendingZip();
	pendingZip = data;
	pendingZipTimer = setTimeout(() => {
		if (pendingZip) {
			// If TTL fires it means site creation never completed — clear stale state.
			pendingZip = null;
			pendingZipTimer = null;
		}
	}, 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Service container — lazy, cached after first successful resolution.
// ---------------------------------------------------------------------------

let _cradle = null;

function getCradle() {
	if (_cradle) return _cradle;
	try {
		const LocalMain = require('@getflywheel/local/main');
		_cradle = LocalMain.getServiceContainer().cradle;
	} catch (_) {}
	return _cradle;
}

function getSitesDir() {
	const cradle = getCradle();
	if (cradle) {
		try {
			const raw = cradle.userData.get('settings.sitesPath') || '~/Local Sites/';
			return raw.replace(/^~/, os.homedir()).replace(/\/$/, '');
		} catch (_) {}
	}
	return path.join(os.homedir(), 'Local Sites');
}

function getExistingSiteNames() {
	const cradle = getCradle();
	if (cradle) {
		try {
			const sites = Object.values(cradle.siteData.getSites());
			return new Set(sites.map((s) => s.name));
		} catch (_) {}
	}
	return new Set();
}

// ---------------------------------------------------------------------------
// Renderer messaging — guard against destroyed window.
// ---------------------------------------------------------------------------

function sendToRenderer(channel, ...args) {
	const win = global.mainWindow;
	if (win && !win.isDestroyed()) {
		win.webContents.send(channel, ...args);
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
			sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
		} catch (err) {
			logger.error('[zip-launcher] WP-CLI install failed', err);
			sendToRenderer('showToast', {
				toastType: 'error',
				message: `Couldn't install "${name}". Install manually from WP admin. Zip: ${filePath}`,
			});
			sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
		}
	});

	// --- IPC: single atomic handler ------------------------------------------
	// Renderer sends one invoke; main process does everything: analyze, validate,
	// set pending state, and emit addSite — all before returning to the renderer.
	ipcMain.handle('zip-launcher:process', async (_event, data) => {
		// Validate input
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

		const { type, name } = detected;
		logger.info(`[zip-launcher] Detected ${type}: "${name}"`);

		let slug;
		try {
			slug = getUniqueSlug(slugify(name), getExistingSiteNames());
		} catch (err) {
			return { error: err.message };
		}

		const sitePath = path.join(getSitesDir(), slug);
		const adminPassword = crypto.randomBytes(8).toString('hex');

		// Set pending zip atomically before emitting addSite.
		setPendingZip({ filePath, type, name, expectedSiteName: slug });

		// Trigger Local's existing addSite IPC handler from the main process.
		// AddSiteService.listen() registers ipcMain.on('addSite', (event, args) => this.addSite(args)).
		// The handler only uses args, not event, so an empty event object is safe.
		ipcMain.emit('addSite', {}, {
			newSiteInfo: {
				siteName: slug,
				sitePath,
				siteDomain: `${slug}.local`,
				multiSite: '', // Local.MultiSite.No = ''
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
};
