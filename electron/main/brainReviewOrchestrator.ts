import { runSenseFrameBrainRuntime } from './brainRuntime/runtime';
import type { BrainProgressEvent, BrainRunRequest, BrainRunResult, XiaogongProgressEvent } from '../shared/types';

function mapPhase(phase: XiaogongProgressEvent['phase']): BrainProgressEvent['phase'] {
  if (phase === 'workspace' || phase === 'context') return 'context';
  if (phase === 'vision') return 'photo_started';
  if (phase === 'compare') return 'group_started';
  if (phase === 'write') return 'persisting';
  if (phase === 'done' || phase === 'completed') return 'completed';
  if (phase === 'failed') return 'failed';
  return 'planning';
}

export async function startBrainReviewThroughRuntime(
  request: BrainRunRequest,
  onProgress?: (event: BrainProgressEvent) => void
): Promise<BrainRunResult> {
  const output = await runSenseFrameBrainRuntime({
    mode: 'review',
    batchId: request.batchId,
    message: `执行小宫审片。范围：${request.scope}。${request.focusMode ? `重点：${request.focusMode}` : ''}`,
    currentMode: request.focusMode,
    activePhotoId: request.activePhotoId,
    scope: request.scope,
    focusMode: request.focusMode
  }, (progress) => {
    const log = progress.uiLog;
    onProgress?.({
      runId: log?.runId || outputIdPlaceholder(progress.sessionId),
      status: progress.status === 'completed' ? 'completed' : progress.status === 'failed' ? 'failed' : 'running',
      phase: mapPhase(progress.phase),
      batchId: request.batchId,
      scope: 'batch',
      message: progress.message,
      current: log?.progress?.current || 0,
      total: log?.progress?.total || 0,
      photoId: log?.photoId,
      fileName: log?.photoFileName,
      debugLogPath: log?.traceId
    });
  });

  const brainArtifact = output.artifacts?.find((artifact) => artifact.type === 'brain_run');
  const runId = brainArtifact?.refId || output.debugTraceId || output.sessionId;
  const reviewed = output.stateWrites?.find((item) => item.target === 'brain_runs')?.count || 0;

  return {
    runId,
    status: output.status === 'failed' ? 'failed' : 'completed',
    batchId: request.batchId,
    scope: 'batch',
    reviewed,
    message: output.message,
    summary: output.summary,
    strategy: output.summary,
    debugLogPath: output.debugTraceId,
    smartView: output.smartView,
    uiPatch: output.uiPatch,
    reviews: []
  };
}

function outputIdPlaceholder(sessionId: string): string {
  return sessionId;
}
