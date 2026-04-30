import { contextBridge, ipcRenderer } from 'electron';
import type { BatchView, DeleteBatchResult, ImportProgress, ImportResult, SearchResult, SemanticAnalysis } from '../shared/types';

const api = {
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseFolder'),
  chooseArchive: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseArchive'),
  importSource: (source: string): Promise<ImportResult> => ipcRenderer.invoke('library:importSource', source),
  onImportProgress: (callback: (progress: ImportProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ImportProgress): void => callback(progress);
    ipcRenderer.on('library:importProgress', listener);
    return () => ipcRenderer.removeListener('library:importProgress', listener);
  },
  listBatches: (): Promise<Array<{ id: string; name: string; status: string; totalPhotos: number; createdAt: string }>> => ipcRenderer.invoke('library:listBatches'),
  getBatch: (batchId: string): Promise<BatchView> => ipcRenderer.invoke('library:getBatch', batchId),
  rebuildClusters: (batchId: string): Promise<BatchView> => ipcRenderer.invoke('library:rebuildClusters', batchId),
  deleteBatch: (payload: { batchId: string; deleteOriginals?: boolean }): Promise<DeleteBatchResult> => ipcRenderer.invoke('library:deleteBatch', payload),
  saveDecision: (payload: { photoId: string; batchId: string; decision: string; rating?: number }): Promise<boolean> => ipcRenderer.invoke('library:saveDecision', payload),
  analyzeSemantic: (payload: { batchId: string; photoId: string }): Promise<SemanticAnalysis> => ipcRenderer.invoke('ai:analyzeSemantic', payload),
  search: (payload: { batchId: string; query: string }): Promise<SearchResult[]> => ipcRenderer.invoke('ai:search', payload),
  exportCsv: (batchId: string): Promise<string> => ipcRenderer.invoke('export:csv', batchId),
  workerHint: (): Promise<string> => ipcRenderer.invoke('system:workerHint'),
  fileUrl: (path?: string): string => (path ? `senseframe://image?path=${encodeURIComponent(path)}` : '')
};

contextBridge.exposeInMainWorld('senseframe', api);

export type SenseFrameApi = typeof api;
