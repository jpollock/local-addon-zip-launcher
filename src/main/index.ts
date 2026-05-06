'use strict';

import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
  validateFilePath,
  analyzeZip,
  slugify,
  getUniqueSlug,
  openZip,
  ZipBundle,
  ZipComponent,
} from '../lib/zip-analyzer';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ipcMain, dialog } = require('electron') as {
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>): void;
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
    emit(event: string, ...args: unknown[]): boolean;
  };
  dialog: {
    showMessageBox(window: unknown, options: unknown): Promise<{ response: number }>;
  };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AddonLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface AddonContext {
  hooks: {
    addAction(hook: string, callback: (...args: unknown[]) => void | Promise<void>): void;
  };
  environment?: {
    logger?: AddonLogger;
  };
}

interface LocalSite {
  id: string;
  name: string;
  longPath: string;
}

interface PendingZip {
  filePath: string;
  components: ZipComponent[];  // all detected themes/plugins, plugins first
  prefix: string;              // common wrapper prefix in the zip (e.g. 'wp/')
  expectedSiteName: string;
  demoContentEntries: string[];
}

interface ServiceCradle {
  userData: { get(key: string, fallback?: string): string };
  siteData: { getSites(): Record<string, LocalSite> };
  wpCli: {
    run(site: LocalSite, args: string[], opts?: { skipPlugins?: boolean }): Promise<string | null>;
  };
  siteProcessManager: {
    getSiteStatus(site: LocalSite): string;
    start(site: LocalSite): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Pending zip state
// ---------------------------------------------------------------------------

let pendingZip: PendingZip | null = null;
let pendingZipTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingZip(): void {
  if (pendingZipTimer) { clearTimeout(pendingZipTimer); pendingZipTimer = null; }
  pendingZip = null;
}

function setPendingZip(data: PendingZip): void {
  clearPendingZip();
  pendingZip = data;
  pendingZipTimer = setTimeout(() => {
    pendingZip = null;
    pendingZipTimer = null;
  }, 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Service container — lazy, cached after first successful resolution.
// ---------------------------------------------------------------------------

let _cradle: ServiceCradle | null = null;

function getCradle(): ServiceCradle | null {
  if (_cradle) return _cradle;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const LocalMain = require('@getflywheel/local/main');
    _cradle = LocalMain.getServiceContainer().cradle as ServiceCradle;
  } catch (_) {
    // Local service container not available
  }
  return _cradle;
}

function getSitesDir(): string {
  const cradle = getCradle();
  if (cradle) {
    try {
      const raw = cradle.userData.get('settings.sitesPath') || '~/Local Sites/';
      return raw.replace(/^~/, os.homedir()).replace(/\/$/, '');
    } catch (_) {
      // Fall back to default sites directory
    }
  }
  return path.join(os.homedir(), 'Local Sites');
}

function getExistingSiteNames(): Set<string> {
  const cradle = getCradle();
  if (cradle) {
    try {
      const sites = Object.values(cradle.siteData.getSites());
      return new Set(sites.map((s) => s.name));
    } catch (_) {
      // Site data unavailable
    }
  }
  return new Set();
}

/**
 * Derives a site slug from bundle component names.
 * Deduplicates (MarkShare + MarkShare → markshare) and joins (Astra + WooCommerce → astra-woocommerce).
 */
function slugBundleName(components: ZipComponent[]): string {
  const slugs = components.map((c) => slugify(c.name));
  return [...new Set(slugs)].join('-');
}

/**
 * Synchronously extracts all entries under `{prefix}{folderName}/` from the zip
 * into `{destParent}/{folderName}/`, overwriting existing files.
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
    if (!relativePath) continue;

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

function isSiteRunning(site: LocalSite): boolean {
  const cradle = getCradle();
  if (cradle && cradle.siteProcessManager) {
    try {
      return cradle.siteProcessManager.getSiteStatus(site) === 'running';
    } catch (_) {
      // Fallback to pid check below
    }
  }
  return fs.existsSync(path.join(site.longPath, 'logs', 'nginx', 'nginx.pid'));
}

// ---------------------------------------------------------------------------
// Renderer messaging
// ---------------------------------------------------------------------------

function sendToRenderer(channel: string, ...args: unknown[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = (global as any).mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

// ---------------------------------------------------------------------------
// Demo content import
// ---------------------------------------------------------------------------

async function importDemoContent(
  filePath: string,
  demoContentEntries: string[],
  site: LocalSite,
  wpCli: ServiceCradle['wpCli'],
  logger: AddonLogger,
): Promise<void> {
  if (!demoContentEntries.length) return;

  const zip = await openZip(filePath);
  try {
    sendToRenderer('updateSiteMessage', site.id, 'Installing demo content importer…');
    await wpCli.run(site, ['plugin', 'install', 'wordpress-importer', '--activate']);
    for (const entry of demoContentEntries) {
      sendToRenderer('updateSiteMessage', site.id, 'Importing demo content…');
      const tmpFile = path.join(os.tmpdir(), `zip-launcher-${crypto.randomBytes(4).toString('hex')}.xml`);
      let succeeded = false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (zip as any).entryDataSync(entry);
        fs.writeFileSync(tmpFile, data);
        // skipPlugins must be false so wordpress-importer can load during import.
        await wpCli.run(site, ['import', tmpFile, '--authors=create'], { skipPlugins: false });
        succeeded = true;
        logger.info(`[zip-launcher] Imported demo content: ${entry}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[zip-launcher] Demo content import failed for ${entry}: ${message}`);
        sendToRenderer('showToast', {
          toastTrigger: 'import',
          toastType: 'error',
          message: `Demo content import failed. File saved at ${tmpFile} — import via WP Admin → Tools → Import.`,
        });
      } finally {
        if (succeeded) {
          try { fs.unlinkSync(tmpFile); } catch (_) {
            // Cleanup best effort
          }
        }
      }
    }
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (zip as any).close();
  }
}

// ---------------------------------------------------------------------------
// Addon entry point
// ---------------------------------------------------------------------------

export default function zipLauncher(context: AddonContext): void {
  const logger: AddonLogger = (context.environment && context.environment.logger) || console;

  // --- Post-install hook ---------------------------------------------------
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let zip: any;
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
          extractZipFolderSync(zip, prefix, component.folder, destParent);
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
      zip.close();
    }

    if (anyInstalled) {
      await importDemoContent(filePath, demoContentEntries || [], site, cradle.wpCli, logger);
    }
    sendToRenderer('updateSiteMessage', site.id, null);
    sendToRenderer('goToRoute', `/main/site-info/${site.id}/overview`);
  });

  // --- IPC: single atomic handler ------------------------------------------
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

    // --- Collision detection ---
    const collidingSite = findCollidingSite(components);
    if (collidingSite) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
            logger.info(`[zip-launcher] "${collidingSite.name}" started`);
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
}
