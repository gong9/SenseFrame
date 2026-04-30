import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { is } from '@electron-toolkit/utils';
import { loadLocalEnv } from './env';
import { analyzeSemantic, semanticSearch } from './openaiService';
import { deleteBatch, getBatch, importSource, listBatches, rebuildClusters, saveDecision, workerHint } from './photoPipeline';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    title: 'SenseFrame',
    backgroundColor: '#090908',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

protocol.registerSchemesAsPrivileged([{ scheme: 'senseframe', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.whenReady().then(() => {
  loadLocalEnv();
  protocol.handle('senseframe', async (request) => {
    const filePath = new URL(request.url).searchParams.get('path');
    if (!filePath) return new Response('Missing file path', { status: 400 });
    const data = readFileSync(filePath);
    return new Response(data, { headers: { 'content-type': 'image/jpeg' } });
  });

  ipcMain.handle('dialog:chooseFolder', async () => {
    console.log('[SenseFrame] chooseFolder IPC received');
    const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog({
      ...(focused ? { window: focused } : {}),
      properties: ['openDirectory', 'dontAddToRecent'],
      title: '选择照片文件夹'
    } as Electron.OpenDialogOptions);
    console.log('[SenseFrame] chooseFolder result', result.canceled, result.filePaths);
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:chooseArchive', async () => {
    console.log('[SenseFrame] chooseArchive IPC received');
    const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog({
      ...(focused ? { window: focused } : {}),
      properties: ['openFile', 'dontAddToRecent'],
      title: '选择 RAR 压缩包',
      filters: [
        { name: 'RAR archive', extensions: ['rar'] }
      ]
    } as Electron.OpenDialogOptions);
    console.log('[SenseFrame] chooseArchive result', result.canceled, result.filePaths);
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('library:importSource', async (event, source: string) =>
    importSource(source, (progress) => {
      event.sender.send('library:importProgress', progress);
    })
  );
  ipcMain.handle('library:listBatches', async () => listBatches());
  ipcMain.handle('library:getBatch', async (_event, batchId: string) => getBatch(batchId));
  ipcMain.handle('library:rebuildClusters', async (_event, batchId: string) => rebuildClusters(batchId));
  ipcMain.handle('library:deleteBatch', async (_event, payload: { batchId: string; deleteOriginals?: boolean }) => {
    return deleteBatch(payload.batchId, Boolean(payload.deleteOriginals));
  });
  ipcMain.handle('library:saveDecision', async (_event, payload: { photoId: string; batchId: string; decision: string; rating?: number }) => {
    saveDecision(payload.photoId, payload.batchId, payload.decision, payload.rating);
    return true;
  });
  ipcMain.handle('ai:analyzeSemantic', async (_event, payload: { batchId: string; photoId: string }) => analyzeSemantic(payload.batchId, payload.photoId));
  ipcMain.handle('ai:search', async (_event, payload: { batchId: string; query: string }) => semanticSearch(payload.batchId, payload.query));
  ipcMain.handle('system:workerHint', async () => workerHint());
  ipcMain.handle('export:csv', async (_event, batchId: string) => {
    const batch = getBatch(batchId);
    const rows = [
      ['file_path', 'decision', 'rating', 'cluster_id', 'rank', 'risk_flags', 'semantic_tags', 'caption'],
      ...batch.photos.map((photo) => [
        photo.filePath,
        photo.decision,
        String(photo.rating || ''),
        photo.clusterId || '',
        String(photo.rankInCluster || ''),
        JSON.stringify(photo.analysis?.riskFlags || []),
        JSON.stringify([...(photo.semantic?.subjects || []), ...(photo.semantic?.emotion || []), ...(photo.semantic?.usage || [])]),
        photo.semantic?.caption || ''
      ])
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
    const dir = join(app.getPath('documents'), 'SenseFrame');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${batch.name}-${new Date().toISOString().slice(0, 10)}.csv`);
    writeFileSync(path, csv, 'utf8');
    return path;
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
