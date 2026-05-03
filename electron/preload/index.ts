import { contextBridge, ipcRenderer } from 'electron';
import type {
  BatchView,
  BrainProgressEvent,
  BrainRunRequest,
  BrainRunResult,
  DeleteBatchResult,
  ImportProgress,
  ImportResult,
  ModelSettings,
  SearchResult,
  SemanticAnalysis,
  SmartView,
  SmartViewSummary,
  XiaogongProgressEvent,
  XiaogongRunRequest,
  XiaogongRunResult
} from '../shared/types';

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
  reanalyzeBatch: (batchId: string): Promise<BatchView> => ipcRenderer.invoke('library:reanalyzeBatch', batchId),
  deleteBatch: (payload: { batchId: string; deleteOriginals?: boolean }): Promise<DeleteBatchResult> => ipcRenderer.invoke('library:deleteBatch', payload),
  saveDecision: (payload: { photoId: string; batchId: string; decision: string; rating?: number }): Promise<boolean> => ipcRenderer.invoke('library:saveDecision', payload),
  analyzeSemantic: (payload: { batchId: string; photoId: string }): Promise<SemanticAnalysis> => ipcRenderer.invoke('ai:analyzeSemantic', payload),
  search: (payload: { batchId: string; query: string }): Promise<SearchResult[]> => ipcRenderer.invoke('ai:search', payload),
  startBrainReview: (payload: BrainRunRequest): Promise<BrainRunResult> => ipcRenderer.invoke('brain:startReview', payload),
  onBrainProgress: (callback: (event: BrainProgressEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: BrainProgressEvent): void => callback(progress);
    ipcRenderer.on('brain:progress', listener);
    return () => ipcRenderer.removeListener('brain:progress', listener);
  },
  recordBrainFeedback: (payload: { photoId: string; runId?: string; action: string; note?: string }): Promise<boolean> => ipcRenderer.invoke('brain:feedback', payload),
  runXiaogong: (payload: XiaogongRunRequest): Promise<XiaogongRunResult> => ipcRenderer.invoke('xiaogong:run', payload),
  getSmartView: (viewId: string): Promise<SmartView> => ipcRenderer.invoke('xiaogong:getSmartView', viewId),
  listSmartViews: (batchId: string): Promise<SmartViewSummary[]> => ipcRenderer.invoke('xiaogong:listSmartViews', batchId),
  onXiaogongProgress: (callback: (event: XiaogongProgressEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: XiaogongProgressEvent): void => callback(progress);
    ipcRenderer.on('xiaogong:progress', listener);
    return () => ipcRenderer.removeListener('xiaogong:progress', listener);
  },
  exportCsv: (batchId: string): Promise<string> => ipcRenderer.invoke('export:csv', batchId),
  exportSelected: (batchId: string): Promise<{ dir: string; count: number } | null> => ipcRenderer.invoke('export:selected', batchId),
  workerHint: (): Promise<string> => ipcRenderer.invoke('system:workerHint'),
  getModelSettings: (): Promise<ModelSettings> => ipcRenderer.invoke('settings:getModel'),
  saveModelSettings: (settings: ModelSettings): Promise<ModelSettings> => ipcRenderer.invoke('settings:saveModel', settings),
  fileUrl: (path?: string): string => (path ? `senseframe://image?path=${encodeURIComponent(path)}` : '')
};

contextBridge.exposeInMainWorld('senseframe', api);

export type SenseFrameApi = typeof api;
