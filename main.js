'use strict';

const { ipcMain, dialog } = require('electron');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
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

// Extracts WXR files from the zip, installs wordpress-importer, and imports them.
// Leaves temp files on disk if import fails so the user can import manually.
async function importDemoContent(filePath, demoContentEntries, site, wpCli, logger) {
	if (!demoContentEntries.length) return;

	const { openZip } = require('./lib/zip-analyzer');
	const zip = await openZip(filePath);
	try {
		await wpCli.run(site, ['plugin', 'install', 'wordpress-importer', '--activate']);
		for (const entry of demoContentEntries) {
			const tmpFile = path.join(os.tmpdir(), `zip-launcher-${crypto.randomBytes(4).toString('hex')}.xml`);
			let succeeded = false;
			try {
				const data = zip.entryDataSync(entry);
				fs.writeFileSync(tmpFile, data);
				await wpCli.run(site, ['import', tmpFile, '--authors=create']);
				succeeded = true;
				logger.info(`[zip-launcher] Imported demo content: ${entry}`);
			} catch (err) {
				logger.error(`[zip-launcher] Demo content import failed for ${entry}: ${err.message}`);
				sendToRenderer('showToast', { toastTrigger: 'import',
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

		const { filePath, type, name, demoContentEntries } = pendingZip;
		clearPendingZip();

		logger.info(`[zip-launcher] Post-install: installing ${type} "${name}" on "${site.name}"`);

		const cradle = getCradle();
		if (!cradle || !cradle.wpCli) {
			logger.warn('[zip-launcher] wpCli not available');
			sendToRenderer('showToast', { toastTrigger: 'import',
				toastType: 'error',
				message: `Couldn't activate "${name}" — WP-CLI unavailable. Install manually from WP admin.`,
			});
			sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
			return;
		}

		let installSucceeded = false;
		try {
			const cmd = type === 'theme' ? 'theme' : 'plugin';
			await cradle.wpCli.run(site, [cmd, 'install', filePath, '--activate']);
			logger.info(`[zip-launcher] Installed and activated ${type} "${name}"`);
			installSucceeded = true;
		} catch (err) {
			logger.error('[zip-launcher] WP-CLI install failed', err);
			sendToRenderer('showToast', { toastTrigger: 'import',
				toastType: 'error',
				message: `Couldn't install "${name}". Install manually from WP admin. Zip: ${filePath}`,
			});
		}

		if (installSucceeded) {
			await importDemoContent(filePath, demoContentEntries || [], site, cradle.wpCli, logger);
		}
		sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
	});

	// --- IPC: single atomic handler ------------------------------------------
	// Renderer sends one invoke; main process does everything: analyze, validate,
	// set pending state, and emit addSite — all before returning to the renderer.
	ipcMain.handle('zip-launcher:process', async (_event, data) => {
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
			const { response } = await dialog.showMessageBox(global.mainWindow || undefined, {
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
					sendToRenderer('showToast', { toastTrigger: 'import',
						toastType: 'error',
						message: `Start "${collidingSite.name}" first, then drop the zip again.`,
					});
					return { ok: true };
				}

				const cradle = getCradle();
				if (!cradle || !cradle.wpCli) {
					sendToRenderer('showToast', { toastTrigger: 'import',
						toastType: 'error',
						message: 'WP-CLI unavailable — cannot update.',
					});
					return { ok: true };
				}

				const cmd = type === 'theme' ? 'theme' : 'plugin';
				let updateSucceeded = false;
				try {
					await cradle.wpCli.run(collidingSite, [cmd, 'install', filePath, '--force']);
					logger.info(`[zip-launcher] Updated ${type} "${name}" on "${collidingSite.name}"`);
					updateSucceeded = true;
				} catch (err) {
					logger.error(`[zip-launcher] --force update failed: ${err.message}`);
					sendToRenderer('showToast', { toastTrigger: 'import',
						toastType: 'error',
						message: `Couldn't update "${name}": ${err.message}`,
					});
				}

				if (updateSucceeded) {
					await importDemoContent(filePath, demoContentEntries || [], collidingSite, cradle.wpCli, logger);
				}
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
};
