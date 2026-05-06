'use strict';

module.exports = function zipLauncherRenderer(_context) {
	// Require electron directly — most reliable in Local's renderer context.
	const electron = require('electron');
	const ipcRenderer = electron.ipcRenderer;
	const webUtils = electron.webUtils; // Electron 32+; may be undefined on older builds

	// Navigate within Local's renderer — must go renderer→renderer via webContents.send,
	// not renderer→main via ipcRenderer.send (main has no goToRoute handler).
	function goToRoute(route) {
		try {
			const remote = require('@electron/remote');
			const win = remote.getCurrentWindow();
			if (win) {
				win.webContents.send('goToRoute', route);
				return;
			}
		} catch (_) {}
		// Fallback: send to main and hope it forwards (unlikely but harmless)
		ipcRenderer.send('goToRoute', route);
	}

	function showToast(message, toastType = 'error') {
		ipcRenderer.send('showToast', { toastType, message });
	}

	function getFilePath(file) {
		if (webUtils && typeof webUtils.getPathForFile === 'function') {
			return webUtils.getPathForFile(file);
		}
		// Older Electron: File object had a non-standard .path property.
		return file.path || null;
	}

	async function onDrop(e) {
		const files = Array.from(e.dataTransfer.files);
		const zipFile = files.find((f) => f.name.toLowerCase().endsWith('.zip'));

		// Not a zip — let MainDragDrop handle it normally.
		if (!zipFile) return;

		// It's a zip — we own this drop.
		e.preventDefault();
		e.stopPropagation();

		// MainDragDrop adds 'drag' class but its onDrop never fires when we
		// stopPropagation, so we clear it manually.
		document.getElementById('root')?.classList.remove('drag');

		// MainDragDrop.isEntered stays true when we stopPropagation, so the
		// overlay won't appear on the next drag. Reset it by dispatching a
		// synthetic dragleave that passes MainDragDrop's isFileEvent check.
		setTimeout(() => {
			const root = document.getElementById('root');
			if (!root) return;
			try {
				const dt = new DataTransfer();
				dt.items.add(new File([''], 'x'));
				root.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
			} catch (_) {}
		}, 50);

		const filePath = getFilePath(zipFile);
		if (!filePath) {
			showToast('Zip Launcher: Could not read file path.');
			return;
		}

		// Ask main process to analyze the zip (no service container needed there).
		let result;
		try {
			result = await ipcRenderer.invoke('zip-launcher:analyze', { filePath });
		} catch (err) {
			console.error('[zip-launcher] analyze IPC failed:', err);
			// Fall back to Local's normal import flow.
			global.droppedFiles = [{ path: filePath, name: zipFile.name }];
			goToRoute('/main/import-site-analyze');
			return;
		}

		if (result.error) {
			showToast(`Zip Launcher: ${result.error}`);
			return;
		}

		if (result.passthrough) {
			// Not a theme or plugin — hand off to Local's existing import flow.
			global.droppedFiles = [{ path: filePath, name: zipFile.name }];
			goToRoute('/main/import-site-analyze');
			return;
		}

		const { type, name, slug, sitePath } = result;

		// Store the pending zip in the main process BEFORE triggering addSite,
		// so the wordPressInstaller:standardInstall hook can find it.
		ipcRenderer.send('zip-launcher:set-pending', { filePath, type, name, siteName: slug });

		// Trigger site creation through Local's existing IPC handler.
		// Local's AddSiteService.listen() registers ipcMain.on('addSite', ...).
		ipcRenderer.send('addSite', {
			newSiteInfo: {
				siteName: slug,
				sitePath,
				siteDomain: `${slug}.local`,
				multiSite: '', // Local.MultiSite.No = '' (empty string, not 'no')
			},
			wpCredentials: {
				adminUsername: 'admin',
				adminPassword: 'admin',
				adminEmail: 'admin@example.com',
			},
			goToSite: false,
			installWP: true,
		});
	}

	// Capture phase fires before MainDragDrop's bubble-phase listener on #root.
	document.addEventListener('drop', onDrop, { capture: true });
};
