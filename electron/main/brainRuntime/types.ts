import type {
  BrainArtifact,
  BrainPhotoReviewDraft,
  BrainStateWrite,
  BrainUiLogEvent,
  ConfirmationRequest,
  PhotoExplanation,
  XiaogongRunResult,
  XiaogongToolEventSummary,
  XiaogongUiPatch
} from '../../shared/types';

export type BrainPermissionLevel = XiaogongToolEventSummary['permissionLevel'];

export type BrainRuntimeMode = 'xiaogong' | 'review';

export type BrainRuntimeRequest = {
  mode: BrainRuntimeMode;
  sessionId?: string;
  batchId: string;
  message: string;
  currentMode?: string;
  activePhotoId?: string;
  smartViewId?: string;
  scope?: 'photo' | 'bucket' | 'group' | 'batch';
  focusMode?: string;
};

export type BrainToolContext = {
  sessionId: string;
  traceId: string;
  batchId: string;
  activePhotoId?: string;
  emitLog: (event: Omit<BrainUiLogEvent, 'id' | 'sessionId' | 'createdAt' | 'traceId'>) => void;
  getPhotoReviewDrafts?: () => BrainPhotoReviewDraft[];
};

export type BrainToolDefinition = {
  name: string;
  description: string;
  permissionLevel: BrainPermissionLevel;
  requiresConfirmation: boolean;
  parameters: Record<string, unknown>;
  handler: (input: any, context: BrainToolContext) => Promise<any> | any;
};

export type BrainToolResult = {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  content: string;
  structured?: unknown;
};

export type BrainRuntimeOutput = XiaogongRunResult & {
  artifacts: BrainArtifact[];
  stateWrites: BrainStateWrite[];
  confirmation?: ConfirmationRequest;
  currentPhotoExplanation?: PhotoExplanation;
  debugTraceId: string;
  uiPatch?: XiaogongUiPatch;
};
