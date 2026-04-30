export type Decision = 'none' | 'pick' | 'reject' | 'maybe';

export type BatchStatus = 'idle' | 'scanning' | 'processing' | 'ready' | 'failed';

export type RiskFlag =
  | 'possible_blur'
  | 'bad_exposure'
  | 'closed_eyes'
  | 'eyes_uncertain'
  | 'face_blur'
  | 'face_missing'
  | 'subject_cropped'
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
