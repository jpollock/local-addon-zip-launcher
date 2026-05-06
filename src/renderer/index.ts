'use strict';

interface AddonContext {
  electron?: unknown;
}

interface IpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
}

interface WebUtils {
  getPathForFile(file: File): string;
}

interface ProcessResult {
  ok?: boolean;
  error?: string;
  passthrough?: boolean;
}

export default function zipLauncherRenderer(_context: AddonContext): void {
  // Require electron directly — most reliable in Local's renderer context.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron');
  const ipcRenderer = electron.ipcRenderer as IpcRenderer;
  const webUtils = electron.webUtils as WebUtils | undefined;

  // Navigate within Local's renderer — must go renderer→renderer via webContents.send,
  // not ipcRenderer.send (main has no goToRoute handler).
  function goToRoute(route: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const remote = require('@electron/remote');
      const win = remote.getCurrentWindow();
      if (win) { win.webContents.send('goToRoute', route); return; }
    } catch (_) {
      // Fallback to ipcRenderer.send below
    }
    ipcRenderer.send('goToRoute', route);
  }

  function showToast(message: string, toastType = 'error'): void {
    ipcRenderer.send('showToast', { toastTrigger: 'import', toastType, message });
  }

  function getFilePath(file: File): string | null {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      return webUtils.getPathForFile(file);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (file as any).path || null;
  }

  async function onDrop(e: DragEvent): Promise<void> {
    if (!e.dataTransfer) return;
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
      } catch (_) {
        // DataTransfer not available — best effort cleanup
      }
    }, 50);

    const filePath = getFilePath(zipFile);
    if (!filePath) {
      showToast('Zip Launcher: Could not read file path.');
      return;
    }

    // Single IPC call — main process validates, analyzes, sets pending state,
    // and emits addSite atomically. Renderer only handles passthrough and errors.
    let result: ProcessResult;
    try {
      result = await ipcRenderer.invoke('zip-launcher:process', { filePath }) as ProcessResult;
    } catch (err) {
      console.error('[zip-launcher] process IPC failed:', err);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).droppedFiles = [{ path: filePath, name: zipFile.name }];
      goToRoute('/main/import-site-analyze');
      return;
    }

    if (result.error) {
      showToast(`Zip Launcher: ${result.error}`);
      return;
    }

    if (result.passthrough) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).droppedFiles = [{ path: filePath, name: zipFile.name }];
      goToRoute('/main/import-site-analyze');
      return;
    }

    // result.ok — main process has triggered site creation. Nothing more to do.
  }

  // Capture phase fires before MainDragDrop's bubble-phase listener on #root.
  document.addEventListener('drop', onDrop as unknown as EventListener, { capture: true });
}
