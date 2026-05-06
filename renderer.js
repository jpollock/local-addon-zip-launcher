'use strict';

module.exports = function zipLauncherRenderer(context) {
	const { webUtils, ipcRenderer } = context.electron || require('electron');

	const ipcAsync = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
	const sendIPCEvent = (channel, ...args) => ipcRenderer.send(channel, ...args);

	function isZip(file) {
		return file.name.toLowerCase().endsWith('.zip');
	}

	async function onDrop(e) {
		const files = Array.from(e.dataTransfer.files);
		const zipFile = files.find(isZip);

		// Not a zip — let MainDragDrop handle it normally.
		if (!zipFile) return;

		// It's a zip — we take ownership.
		e.preventDefault();
		e.stopPropagation();

		// MainDragDrop adds the 'drag' class to #root for the overlay. Since we
		// stopped propagation its onDrop never fires, so we clear it manually.
		document.getElementById('root')?.classList.remove('drag');

		const filePath = webUtils.getPathForFile(zipFile);

		let result;
		try {
			result = await ipcAsync('zip-launcher:process', { filePath });
		} catch (err) {
			console.error('[zip-launcher] IPC error', err);
			return;
		}

		if (result && result.passthrough) {
			// Not a theme/plugin zip — hand off to Local's import flow.
			global.droppedFiles = [{ path: filePath, name: zipFile.name }];
			sendIPCEvent('goToRoute', '/main/import-site-analyze');
		}
		// On success or error, main process drives navigation via sendIPCEvent.
	}

	// Capture phase fires before MainDragDrop's bubble-phase listener on #root.
	document.addEventListener('drop', onDrop, { capture: true });
};
