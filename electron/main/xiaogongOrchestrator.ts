import { runSenseFrameBrainRuntime } from './brainRuntime/runtime';
import type { XiaogongProgressEvent, XiaogongRunRequest, XiaogongRunResult } from '../shared/types';

export async function runXiaogongTask(
  request: XiaogongRunRequest,
  onProgress?: (event: XiaogongProgressEvent) => void
): Promise<XiaogongRunResult> {
  return runSenseFrameBrainRuntime({
    mode: 'xiaogong',
    batchId: request.batchId,
    message: request.message,
    currentMode: request.currentMode,
    activePhotoId: request.activePhotoId,
    smartViewId: request.smartViewId
  }, onProgress);
}
