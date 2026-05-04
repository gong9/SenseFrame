export type Decision = 'none' | 'pick' | 'reject' | 'maybe';

export type AppLanguage = 'zh-CN' | 'en-US';

export type BatchStatus = 'idle' | 'scanning' | 'processing' | 'ready' | 'failed';

export type RiskFlag =
  | 'possible_blur'
  | 'bad_exposure'
  | 'closed_eyes'
  | 'eyes_uncertain'
  | 'face_blur'
  | 'face_missing'
  | 'subject_cropped'
  | 'subject_cropped_mild'
  | 'subject_cropped_severe'
  | 'weak_subject'
  | 'unsupported_preview'
  | 'raw_decode_failed'
  | 'heic_decode_failed';

export type FaceVisibility = 'visible' | 'partial' | 'back' | 'not_visible' | 'unknown';

export type EyeState = 'open' | 'closed' | 'uncertain' | 'not_applicable' | 'unknown';

export type SingleEyeState = 'open' | 'closed' | 'uncertain' | 'missing';

export type DebugRegion = {
  kind: 'face' | 'eye' | 'landmark';
  label: string;
  source?: string;
  score?: number;
  box?: [number, number, number, number];
  point?: [number, number];
};

export type Photo = {
  id: string;
  batchId: string;
  filePath: string;
  fileName: string;
  fileExt: string;
  fileSize: number;
  shotAt?: string;
  cameraModel?: string;
  lensModel?: string;
  iso?: number;
  aperture?: number;
  focalLength?: number;
  shutterSpeed?: string;
  width?: number;
  height?: number;
  thumbPath?: string;
  previewPath?: string;
  status: string;
};

export type PhotoAnalysis = {
  photoId: string;
  sharpnessScore: number;
  exposureScore: number;
  highlightClipRatio: number;
  shadowClipRatio: number;
  faceScore: number;
  eyesOpenScore: number;
  faceVisibility: FaceVisibility;
  eyeState: EyeState;
  eyeConfidence: number;
  leftEyeState: SingleEyeState;
  rightEyeState: SingleEyeState;
  debugRegions: DebugRegion[];
  faceCount: number;
  finalScore: number;
  riskFlags: RiskFlag[];
};

export type SemanticAnalysis = {
  photoId: string;
  scene: string;
  subjects: string[];
  emotion: string[];
  usage: string[];
  composition: string;
  caption: string;
  recommendationReason: string;
  llmScore: {
    emotion: number;
    story: number;
    coverPotential: number;
  };
  model: string;
  isMock: boolean;
};

export type Cluster = {
  id: string;
  batchId: string;
  size: number;
  bestPhotoId?: string;
  confidence: number;
  members: Array<{
    photoId: string;
    rank: number;
    similarityToBest: number;
    recommended: boolean;
  }>;
};

export type PhotoView = Photo & {
  analysis?: PhotoAnalysis;
  semantic?: SemanticAnalysis;
  brainReview?: BrainPhotoReview;
  decision: Decision;
  rating?: number;
  clusterId?: string;
  rankInCluster?: number;
  recommended?: boolean;
};

export type BatchView = {
  id: string;
  name: string;
  rootPath: string;
  status: BatchStatus;
  totalPhotos: number;
  processedPhotos: number;
  createdAt: string;
  photos: PhotoView[];
  clusters: Cluster[];
  brainRun?: BrainRunSummary;
};

export type ImportResult = {
  batchId: string;
  imported: number;
  unsupported: number;
  sourceType?: 'folder' | 'archive';
  extractedPath?: string;
};

export type DeleteBatchResult = {
  deletedOriginals: number;
  failedOriginals: number;
};

export type ModelSettings = {
  baseUrl: string;
  model: string;
  apiKey: string;
  language?: AppLanguage;
};

export type ImportProgress = {
  stage: 'extracting' | 'scanning' | 'analyzing' | 'clustering' | 'done' | 'error';
  message: string;
  current?: number;
  total?: number;
};

export type SearchResult = {
  photo: PhotoView;
  score: number;
  reason: string;
};

export type XiaogongIntentType =
  | 'best_photos'
  | 'cover_candidates'
  | 'closed_eye_misread'
  | 'group_representatives'
  | 'explain_current_photo'
  | 'batch_review'
  | 'unknown';

export type SmartViewItem = {
  photoId: string;
  rank: number;
  score: number;
  reason: string;
  actionHint?: Decision | 'review';
  needsHumanReview: boolean;
};

export type SmartView = {
  id: string;
  batchId: string;
  name: string;
  source: 'xiaogong';
  intent: XiaogongIntentType;
  query: string;
  summary: string;
  items: SmartViewItem[];
  createdAt: string;
};

export type SmartViewSummary = {
  id: string;
  batchId: string;
  name: string;
  intent: XiaogongIntentType;
  photoCount: number;
  summary: string;
  createdAt: string;
};

export type XiaogongRunRequest = {
  batchId: string;
  message: string;
  currentMode?: string;
  activePhotoId?: string;
  smartViewId?: string;
  language?: AppLanguage;
};

export type XiaogongUiPatch = {
  mode?: 'smartView';
  smartViewId?: string;
  activePhotoId?: string;
  notice?: string;
};

export type BrainUiLogEvent = {
  id: string;
  sessionId: string;
  runId?: string;
  level: 'info' | 'success' | 'warning' | 'error' | 'question';
  phase:
    | 'understanding'
    | 'workspace'
    | 'planning'
    | 'tool'
    | 'vision'
    | 'compare'
    | 'write'
    | 'ui'
    | 'confirmation'
    | 'done'
    | 'failed';
  title: string;
  message?: string;
  toolName?: string;
  photoId?: string;
  photoFileName?: string;
  groupId?: string;
  progress?: {
    current: number;
    total: number;
  };
  artifactId?: string;
  traceId?: string;
  createdAt: string;
};

export type XiaogongToolEventSummary = {
  toolName: string;
  permissionLevel: 'read' | 'view' | 'brain_write' | 'decision_write' | 'export' | 'destructive';
  status: 'completed' | 'failed' | 'skipped';
  requiresConfirmation: boolean;
};

export type BrainArtifact = {
  id: string;
  type: 'smart_view' | 'brain_run' | 'photo_explanation' | 'candidate_list' | 'confirmation';
  title: string;
  summary?: string;
  refId?: string;
};

export type BrainStateWrite = {
  target: 'brain_runs' | 'brain_bucket_assignments' | 'brain_group_rankings' | 'smart_views' | 'smart_view_items' | 'xiaogong_sessions' | 'xiaogong_tool_events';
  refId?: string;
  count?: number;
  summary?: string;
};

export type ConfirmationRequest = {
  id: string;
  title: string;
  message: string;
  permissionLevel: XiaogongToolEventSummary['permissionLevel'];
  toolName: string;
  input: unknown;
};

export type PhotoExplanation = {
  photoId: string;
  title: string;
  reason: string;
  evidence: string[];
};

export type XiaogongRunResult = {
  sessionId: string;
  status: 'completed' | 'needs_confirmation' | 'failed';
  intent: XiaogongIntentType;
  message: string;
  summary?: string;
  uiPatch?: XiaogongUiPatch;
  smartView?: SmartViewSummary;
  toolEvents: XiaogongToolEventSummary[];
  artifacts?: BrainArtifact[];
  stateWrites?: BrainStateWrite[];
  confirmation?: ConfirmationRequest;
  currentPhotoExplanation?: PhotoExplanation;
  debugTraceId?: string;
};

export type XiaogongProgressEvent = {
  sessionId: string;
  status: 'running' | 'completed' | 'failed';
  phase:
    | 'intent'
    | 'context'
    | 'ranking'
    | 'smart_view'
    | 'ui_patch'
    | 'completed'
    | 'failed'
    | BrainUiLogEvent['phase'];
  message: string;
  uiLog?: BrainUiLogEvent;
};

export type BrainBucket =
  | 'featured'
  | 'closedEyes'
  | 'eyeReview'
  | 'subject'
  | 'technical'
  | 'duplicates'
  | 'similarBursts'
  | 'pending';

export type BrainVisualScores = {
  visualQuality: number;
  expression: number;
  moment: number;
  composition: number;
  backgroundCleanliness: number;
  storyValue: number;
  lighting?: number;
  subjectClarity?: number;
  finish?: number;
  deliverableScore?: number;
};

export type BrainPhotoReview = {
  photoId: string;
  runId: string;
  primaryBucket: BrainBucket;
  secondaryBuckets: BrainBucket[];
  confidence: number;
  recommendedAction: Decision | 'review';
  reason: string;
  smallModelOverrides: string[];
  needsHumanReview: boolean;
  visualScores: BrainVisualScores;
  aestheticPass?: boolean;
  aestheticRejectReasons?: string[];
  fatalFlaws?: string[];
  compositionTags?: string[];
  representativeRank?: number;
  groupReason?: string;
  groupId?: string;
  groupRank?: number;
  groupRole?: 'representative' | 'backup' | 'rejected' | 'single';
  reviewSource?: 'sheet_vision' | 'single_vision' | 'group_vision';
  sheetId?: string;
  sheetCell?: number;
  model: string;
  createdAt: string;
};

export type BrainReviewStrategy = {
  strategySummary: string;
  priorityPhotoIds: string[];
  riskPhotoIds: string[];
  groupIdsToCompare: string[];
  skipPhotoIds: string[];
};

export type BrainPhotoReviewDraft = {
  photoId: string;
  primaryBucket: BrainBucket;
  secondaryBuckets: BrainBucket[];
  confidence: number;
  recommendedAction: Decision | 'review';
  reason: string;
  smallModelOverrides: string[];
  needsHumanReview: boolean;
  visualScores: BrainVisualScores;
  aestheticPass?: boolean;
  aestheticRejectReasons?: string[];
  fatalFlaws?: string[];
  compositionTags?: string[];
  reviewSource?: 'sheet_vision' | 'single_vision' | 'group_vision';
  sheetId?: string;
  sheetCell?: number;
};

export type BrainGroupReviewDraft = {
  groupId: string;
  representativePhotoId: string;
  rankedPhotoIds: string[];
  groupReason: string;
  roles: Array<{
    photoId: string;
    groupRank: number;
    groupRole: 'representative' | 'backup' | 'rejected' | 'single';
  }>;
};

export type WriteBrainReviewResultInput = {
  batchId: string;
  strategySummary: string;
  reviews: BrainPhotoReviewDraft[];
  groupReviews: BrainGroupReviewDraft[];
};

export type BrainRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type BrainRunScope = 'photo' | 'bucket' | 'group' | 'batch';

export type BrainRunSummary = {
  runId: string;
  status: BrainRunStatus;
  scope: BrainRunScope;
  summary?: string;
  strategy?: string;
  bucketCounts?: Partial<Record<BrainBucket, number>>;
  reviewed: number;
  model: string;
  debugLogPath?: string;
  createdAt: string;
  updatedAt: string;
};

export type BrainRunRequest = {
  batchId: string;
  scope: BrainRunScope;
  focusMode?: string;
  activePhotoId?: string;
  language?: AppLanguage;
};

export type BrainRunResult = {
  runId: string;
  status: BrainRunStatus;
  batchId: string;
  scope: BrainRunScope;
  reviewed: number;
  message: string;
  summary?: string;
  strategy?: string;
  bucketCounts?: Partial<Record<BrainBucket, number>>;
  debugLogPath?: string;
  smartView?: SmartViewSummary;
  uiPatch?: XiaogongUiPatch;
  reviews: BrainPhotoReview[];
};

export type BrainProgressEvent = {
  runId: string;
  status: BrainRunStatus;
  phase: 'started' | 'context' | 'planning' | 'photo_started' | 'photo_completed' | 'group_started' | 'group_completed' | 'reducing' | 'persisting' | 'completed' | 'failed';
  batchId: string;
  scope: BrainRunScope;
  message: string;
  current: number;
  total: number;
  photoId?: string;
  fileName?: string;
  debugLogPath?: string;
};
