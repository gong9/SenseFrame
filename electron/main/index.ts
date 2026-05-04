import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol } from 'electron';
import { basename, extname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { is } from '@electron-toolkit/utils';
import { loadLocalEnv } from './env';
import { applyModelSettings, getModelSettings, saveModelSettings } from './appSettings';
import { analyzeSemantic, semanticSearch } from './openaiService';
import { recordBrainFeedback } from './brainService';
import { failInterruptedBrainSessions } from './brainRuntime/sessionStore';
import { startBrainReviewThroughRuntime } from './brainReviewOrchestrator';
import { runXiaogongTask } from './xiaogongOrchestrator';
import { getSmartView, listSmartViews } from './xiaogongSmartViewService';
import { deleteBatch, getBatch, importSource, listBatches, reanalyzeBatch, rebuildClusters, saveDecision, workerHint } from './photoPipeline';

function sendProgress(event: Electron.IpcMainInvokeEvent, channel: string, payload: unknown): void {
  try {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[SenseFrame] skip ${channel} progress delivery: ${message}`);
  }
}

function getAppIconPath(): string {
  return join(app.getAppPath(), 'build/icon.png');
}

function applyDockIcon(): void {
  const iconPath = getAppIconPath();
  if (process.platform === 'darwin' && existsSync(iconPath)) {
    app.dock?.setIcon(nativeImage.createFromPath(iconPath));
  }
}

app.setName('SenseFrame');

function appLanguage(): 'zh-CN' | 'en-US' {
  return getModelSettings().language === 'en-US' ? 'en-US' : 'zh-CN';
}

function mainText(zh: string, en: string): string {
  return appLanguage() === 'en-US' ? en : zh;
}

function createWindow(): void {
  const iconPath = getAppIconPath();
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    title: 'SenseFrame',
    backgroundColor: '#090908',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
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
  applyModelSettings();
  const interruptedSessions = failInterruptedBrainSessions();
  if (interruptedSessions) console.warn(`[SenseFrame] marked ${interruptedSessions} interrupted Xiaogong sessions as failed`);
  applyDockIcon();
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
      title: mainText('选择照片文件夹', 'Choose Photo Folder')
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
      title: mainText('选择 RAR 压缩包', 'Choose RAR Archive'),
      filters: [
        { name: mainText('RAR 压缩包', 'RAR archive'), extensions: ['rar'] }
      ]
    } as Electron.OpenDialogOptions);
    console.log('[SenseFrame] chooseArchive result', result.canceled, result.filePaths);
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('library:importSource', async (event, source: string) =>
    importSource(source, (progress) => {
      sendProgress(event, 'library:importProgress', progress);
    })
  );
  ipcMain.handle('library:listBatches', async () => listBatches());
  ipcMain.handle('library:getBatch', async (_event, batchId: string) => getBatch(batchId));
  ipcMain.handle('library:rebuildClusters', async (_event, batchId: string) => rebuildClusters(batchId));
  ipcMain.handle('library:reanalyzeBatch', async (_event, batchId: string) => reanalyzeBatch(batchId));
  ipcMain.handle('library:deleteBatch', async (_event, payload: { batchId: string; deleteOriginals?: boolean }) => {
    return deleteBatch(payload.batchId, Boolean(payload.deleteOriginals));
  });
  ipcMain.handle('library:saveDecision', async (_event, payload: { photoId: string; batchId: string; decision: string; rating?: number }) => {
    saveDecision(payload.photoId, payload.batchId, payload.decision, payload.rating);
    return true;
  });
  ipcMain.handle('ai:analyzeSemantic', async (_event, payload: { batchId: string; photoId: string }) => analyzeSemantic(payload.batchId, payload.photoId));
  ipcMain.handle('ai:search', async (_event, payload: { batchId: string; query: string }) => semanticSearch(payload.batchId, payload.query));
  ipcMain.handle('brain:startReview', async (event, payload) => startBrainReviewThroughRuntime(payload, (progress) => {
    sendProgress(event, 'brain:progress', progress);
  }));
  ipcMain.handle('brain:feedback', async (_event, payload) => recordBrainFeedback(payload));
  ipcMain.handle('xiaogong:run', async (event, payload) => runXiaogongTask(payload, (progress) => {
    sendProgress(event, 'xiaogong:progress', progress);
  }));
  ipcMain.handle('xiaogong:getSmartView', async (_event, viewId: string) => getSmartView(viewId));
  ipcMain.handle('xiaogong:listSmartViews', async (_event, batchId: string) => listSmartViews(batchId));
  ipcMain.handle('system:workerHint', async () => workerHint());
  ipcMain.handle('settings:getModel', async () => getModelSettings());
  ipcMain.handle('settings:saveModel', async (_event, settings) => saveModelSettings(settings));
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
  ipcMain.handle('export:selected', async (_event, batchId: string) => {
    const batch = getBatch(batchId);
    const picked = batch.photos.filter((photo) => photo.decision === 'pick');
    if (!picked.length) return null;

    const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog({
      ...(focused ? { window: focused } : {}),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      title: mainText('选择导出已选照片的位置', 'Choose Export Folder for Selected Photos')
    } as Electron.OpenDialogOptions);
    if (result.canceled || !result.filePaths[0]) return null;

    const safeBatchName = batch.name.replace(/[\\/:*?"<>|]/g, '_');
    const exportDir = join(result.filePaths[0], `${safeBatchName}-selected`);
    mkdirSync(exportDir, { recursive: true });

    picked.forEach((photo, index) => {
      const sourceName = basename(photo.filePath);
      const ext = extname(sourceName);
      const stem = ext ? sourceName.slice(0, -ext.length) : sourceName;
      let target = join(exportDir, sourceName);
      let suffix = 1;
      while (existsSync(target)) {
        target = join(exportDir, `${stem}-${suffix}${ext}`);
        suffix += 1;
      }
      copyFileSync(photo.filePath, target);
      if ((index + 1) % 25 === 0) console.log(`[SenseFrame] exported ${index + 1}/${picked.length} selected photos`);
    });

    return { dir: exportDir, count: picked.length };
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
