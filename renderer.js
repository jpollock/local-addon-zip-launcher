'use strict';

module.exports = function zipLauncherRenderer(_context) {
	const electron = require('electron');
	const ipcRenderer = electron.ipcRenderer;
	const webUtils = electron.webUtils; // Electron 32+; may be undefined on older builds

	// Navigate within Local's renderer — must go renderer→renderer via webContents.send,
	// not ipcRenderer.send (main has no goToRoute handler).
	function goToRoute(route) {
		try {
			const remote = require('@electron/remote');
			const win = remote.getCurrentWindow();
			if (win) { win.webContents.send('goToRoute', route); return; }
		} catch (_) {}
		ipcRenderer.send('goToRoute', route);
	}

	function showToast(message, toastType = 'error') {
		ipcRenderer.send('showToast', { toastType, message });
	}

	function getFilePath(file) {
		if (webUtils && typeof webUtils.getPathForFile === 'function') {
			return webUtils.getPathForFile(file);
		}
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

		document.getElementById('root')?.classList.remove('drag');

		// Reset MainDragDrop.isEntered so the overlay works on the next drag.
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

		// Single IPC call — main process validates, analyzes, sets pending state,
		// and emits addSite atomically. Renderer only handles passthrough and errors.
		let result;
		try {
			result = await ipcRenderer.invoke('zip-launcher:process', { filePath });
		} catch (err) {
			console.error('[zip-launcher] process IPC failed:', err);
			global.droppedFiles = [{ path: filePath, name: zipFile.name }];
			goToRoute('/main/import-site-analyze');
			return;
		}

		if (result.error) {
			showToast(`Zip Launcher: ${result.error}`);
			return;
		}

		if (result.passthrough) {
			global.droppedFiles = [{ path: filePath, name: zipFile.name }];
			goToRoute('/main/import-site-analyze');
			return;
		}

		// result.ok — main process has triggered site creation. Nothing more to do.
	}

	// Capture phase fires before MainDragDrop's bubble-phase listener on #root.
	document.addEventListener('drop', onDrop, { capture: true });
};
