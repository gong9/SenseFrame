import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Aperture,
  Brain,
  Check,
  Download,
  Eye,
  FolderOpen,
  HardDrive,
  Home,
  Image as ImageIcon,
  KeyRound,
  Layers,
  Loader2,
  ScanFace,
  Server,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  Send,
  Trash2,
  TriangleAlert,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import type {
  BatchView,
  BrainPhotoReview,
  BrainProgressEvent,
  BrainRunResult,
  BrainUiLogEvent,
  Cluster,
  Decision,
  ImportProgress,
  ModelSettings,
  PhotoView,
  SearchResult,
  SmartView,
  SmartViewSummary,
  XiaogongProgressEvent,
  XiaogongRunResult
} from '../electron/shared/types';
import { createTranslator, normalizeLanguage } from './i18n';
import './styles.css';

type ViewMode = 'featured' | 'keepers' | 'lowPriority' | 'reviewQueue' | 'closedEyes' | 'eyeReview' | 'subject' | 'technical' | 'duplicates' | 'similarBursts' | 'pending' | 'search' | 'smartView';
type Translator = ReturnType<typeof createTranslator>;

function pct(value?: number): string {
  return `${Math.round((value || 0) * 100)}`;
}

function decisionLabel(decision: Decision, t: Translator): string {
  return t(`decision.${decision}`);
}

function riskLabel(flag: string, t: Translator): string {
  const label = t(`risk.${flag}`);
  return label === `risk.${flag}` ? flag : label;
}

function localizeTechnicalMessage(message: string, t: Translator): string {
  return productReviewText(message, t)
    .replace(/正在/g, t('import.waiting').replace('...', ''))
    .trim();
}

const eyeFlags = new Set(['closed_eyes', 'eyes_uncertain']);
const closedEyeFlags = new Set(['closed_eyes']);
const eyeReviewFlags = new Set(['eyes_uncertain']);
const subjectFlags = new Set(['subject_cropped', 'subject_cropped_mild', 'subject_cropped_severe', 'weak_subject']);
const technicalFlags = new Set(['possible_blur', 'bad_exposure', 'face_blur', 'unsupported_preview', 'raw_decode_failed', 'heic_decode_failed']);

function hasAnyFlag(photo: PhotoView, flags: Set<string>): boolean {
  return Boolean(photo.analysis?.riskFlags.some((flag) => flags.has(flag)));
}

function duplicatePhotoIds(batch: BatchView): Set<string> {
  const ids = new Set<string>();
  for (const cluster of batch.clusters) {
    if (cluster.size <= 1) continue;
    for (const member of cluster.members) ids.add(member.photoId);
  }
  return ids;
}

type ClusterMeta = {
  clusterNumber: number;
  clusterSize: number;
  rank: number;
  recommended: boolean;
  similarityToBest: number;
};

type BurstMeta = {
  burstNumber: number;
  burstSize: number;
  rank: number;
  label: string;
};

const BURST_RANGES: Array<{ start: number; end: number; label: string }> = [
  { start: 8973, end: 9002, label: '正面跑跳' },
  { start: 9003, end: 9017, label: '转身背影' },
  { start: 9018, end: 9027, label: '回身近景' },
  { start: 9036, end: 9055, label: '背影侧跑' },
  { start: 9056, end: 9068, label: '远景奔跑' },
  { start: 9069, end: 9082, label: '跳起抬腿' },
  { start: 9083, end: 9091, label: '正面笑脸' }
];

function imageNumber(fileName: string): number {
  return Number(fileName.match(/(\d+)/)?.[1] || 0);
}

function similarBurstMetaByPhoto(batch: BatchView): Map<string, BurstMeta> {
  const meta = new Map<string, BurstMeta>();
  const photos = [...batch.photos].sort((a, b) => imageNumber(a.fileName) - imageNumber(b.fileName));
  BURST_RANGES.forEach((range, index) => {
    const members = photos.filter((photo) => {
      const num = imageNumber(photo.fileName);
      return num >= range.start && num <= range.end;
    });
    members.forEach((photo, memberIndex) => {
      meta.set(photo.id, {
        burstNumber: index + 1,
        burstSize: members.length,
        rank: memberIndex + 1,
        label: range.label
      });
    });
  });
  return meta;
}

function clusterMetaByPhoto(batch: BatchView): Map<string, ClusterMeta> {
  const meta = new Map<string, ClusterMeta>();
  batch.clusters.forEach((cluster, index) => {
    if (cluster.size <= 1) return;
    for (const member of cluster.members) {
      meta.set(member.photoId, {
        clusterNumber: index + 1,
        clusterSize: cluster.size,
        rank: member.rank,
        recommended: member.recommended,
        similarityToBest: member.similarityToBest
      });
    }
  });
  return meta;
}

function reviewScore(photo: PhotoView): number {
  const analysis = photo.analysis;
  const flags = new Set<string>(analysis?.riskFlags || []);
  let score = analysis?.finalScore ?? 0;
  if (flags.has('closed_eyes')) score -= 0.28;
  if (flags.has('eyes_uncertain')) score -= 0.08;
  if (flags.has('subject_cropped') || flags.has('subject_cropped_severe')) score -= 0.22;
  if (flags.has('subject_cropped_mild')) score -= 0.08;
  if (flags.has('weak_subject')) score -= 0.14;
  if (flags.has('possible_blur')) score -= 0.16;
  if (flags.has('bad_exposure')) score -= 0.12;
  if (flags.has('face_blur')) score -= 0.08;
  if (analysis?.eyeState === 'open') score += 0.04;
  if (analysis?.eyeState === 'closed') score -= 0.24;
  if (analysis?.eyeState === 'uncertain') score -= 0.07;
  if (analysis?.faceVisibility === 'visible') score += 0.03;
  if (photo.decision === 'pick') score += 0.18;
  if (photo.decision === 'reject') score -= 0.4;
  if (photo.brainReview?.primaryBucket === 'featured') score += 0.16;
  if (brainBlocksFeatured(photo)) score -= 0.45;
  if (photo.rating) score += Math.min(0.14, photo.rating * 0.025);
  return Math.max(0, Math.min(1, score));
}

function brainBlocksFeatured(photo: PhotoView): boolean {
  const review = photo.brainReview;
  if (!review) return false;
  if (photo.decision === 'pick') return false;
  if (review.primaryBucket !== 'featured') return true;
  if (review.needsHumanReview) return true;
  return review.recommendedAction === 'reject' || review.recommendedAction === 'maybe' || review.recommendedAction === 'review';
}

function isBrainKeeper(photo: PhotoView): boolean {
  const review = photo.brainReview;
  if (!review || photo.decision === 'reject') return false;
  if (review.recommendedAction === 'pick') return true;
  if (review.recommendedAction !== 'maybe') return false;
  if (review.needsHumanReview) return false;
  if (review.primaryBucket === 'technical' || review.primaryBucket === 'eyeReview' || review.primaryBucket === 'pending') return false;
  return (review.visualScores.deliverableScore ?? 0) >= 0.6;
}

function isLowPriorityKeeper(photo: PhotoView): boolean {
  const review = photo.brainReview;
  if (!review || photo.decision === 'reject') return false;
  if (isBrainKeeper(photo)) return false;
  return review.recommendedAction === 'maybe';
}

function isBrainReviewQueue(photo: PhotoView): boolean {
  const review = photo.brainReview;
  if (!review || photo.decision === 'reject') return false;
  return review.recommendedAction === 'review' || review.needsHumanReview;
}

function canFeature(photo: PhotoView): boolean {
  const flags = new Set<string>(photo.analysis?.riskFlags || []);
  if (photo.status !== 'ready') return false;
  if (flags.has('unsupported_preview') || flags.has('raw_decode_failed') || flags.has('heic_decode_failed')) return false;
  if (flags.has('closed_eyes') || photo.analysis?.eyeState === 'closed') return false;
  if (photo.decision === 'reject') return false;
  if (brainBlocksFeatured(photo)) return false;
  return reviewScore(photo) >= 0.58;
}

function featuredPhotoIds(batch: BatchView, burstMeta: Map<string, BurstMeta>, clusterMeta: Map<string, ClusterMeta>): Set<string> {
  const selected = new Set<string>();
  const selectedClusters = new Set<number>();
  const byBurst = new Map<number, PhotoView[]>();

  for (const photo of batch.photos) {
    const burst = burstMeta.get(photo.id);
    if (!burst) continue;
    byBurst.set(burst.burstNumber, [...(byBurst.get(burst.burstNumber) || []), photo]);
  }

  const addBest = (photos: PhotoView[], quota: number, requireStrong = false) => {
    const ranked = [...photos]
      .filter((photo) => canFeature(photo) && (!requireStrong || reviewScore(photo) >= 0.7))
      .sort((a, b) => reviewScore(b) - reviewScore(a));
    for (const photo of ranked) {
      if (selected.size >= batch.photos.length) break;
      const cluster = clusterMeta.get(photo.id);
      if (cluster && cluster.rank > 1) continue;
      if (cluster && selectedClusters.has(cluster.clusterNumber)) continue;
      selected.add(photo.id);
      if (cluster) selectedClusters.add(cluster.clusterNumber);
      if ([...selected].filter((id) => photos.some((photo) => photo.id === id)).length >= quota) break;
    }
  };

  for (const photos of byBurst.values()) {
    const quota = Math.min(4, Math.max(1, Math.ceil(photos.length * 0.16)));
    addBest(photos, quota);
  }

  const nonBurst = batch.photos.filter((photo) => !burstMeta.has(photo.id));
  if (nonBurst.length) {
    addBest(nonBurst, Math.min(12, Math.max(3, Math.ceil(nonBurst.length * 0.15))), true);
  }

  if (!selected.size) {
    addBest(batch.photos, Math.min(12, Math.max(1, Math.ceil(batch.photos.length * 0.12))));
  }

  return selected;
}

function App(): React.ReactElement {
  const [batches, setBatches] = useState<Array<{ id: string; name: string; status: string; totalPhotos: number; createdAt: string }>>([]);
  const [batch, setBatch] = useState<BatchView | null>(null);
  const [mode, setMode] = useState<ViewMode>('featured');
  const [clusterIndex, setClusterIndex] = useState(0);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [busy, setBusy] = useState('');
  const [brainBusy, setBrainBusy] = useState('');
  const [brainProgress, setBrainProgress] = useState<BrainProgressEvent | null>(null);
  const [brainActivity, setBrainActivity] = useState<BrainProgressEvent[]>([]);
  const [lastBrainRun, setLastBrainRun] = useState<BrainRunResult | null>(null);
  const [xiaogongBusy, setXiaogongBusy] = useState('');
  const [xiaogongInput, setXiaogongInput] = useState('');
  const [xiaogongProgress, setXiaogongProgress] = useState<XiaogongProgressEvent | null>(null);
  const [xiaogongActivity, setXiaogongActivity] = useState<BrainUiLogEvent[]>([]);
  const [lastXiaogongResult, setLastXiaogongResult] = useState<XiaogongRunResult | null>(null);
  const [smartViews, setSmartViews] = useState<SmartViewSummary[]>([]);
  const [activeSmartView, setActiveSmartView] = useState<SmartView | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [notice, setNotice] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelSettings, setModelSettings] = useState<ModelSettings>({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', apiKey: '', language: 'zh-CN' });
  const [settingsDraft, setSettingsDraft] = useState<ModelSettings>(modelSettings);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [debugMode, setDebugMode] = useState(false);
  const [canvasPhoto, setCanvasPhoto] = useState<PhotoView | undefined>(undefined);
  const [imageZoom, setImageZoom] = useState(1);
  const [imagePan, setImagePan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const activeBatchIdRef = useRef<string | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const language = normalizeLanguage(modelSettings.language);
  const t = useMemo(() => createTranslator(language), [language]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), notice.length > 100 ? 8000 : 4800);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    activeBatchIdRef.current = batch?.id || null;
  }, [batch?.id]);

  async function refreshBatches(): Promise<void> {
    if (!window.senseframe) return;
    setBatches(await window.senseframe.listBatches());
  }

  async function loadModelSettings(): Promise<void> {
    if (!window.senseframe) return;
    const next = await window.senseframe.getModelSettings();
    setModelSettings(next);
    setSettingsDraft(next);
  }

  async function saveSettings(): Promise<void> {
    if (!window.senseframe) return;
    setSettingsSaving(true);
    try {
      const next = await window.senseframe.saveModelSettings(settingsDraft);
      setModelSettings(next);
      setSettingsDraft(next);
      setSettingsOpen(false);
      setNotice(next.apiKey ? t('settings.savedWithKey') : t('settings.savedWithoutKey'));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function loadBatch(id: string, options?: { preserveSmartViewId?: string; preservePhotoId?: string; resetView?: boolean }): Promise<void> {
    if (!window.senseframe) return;
    const next = await window.senseframe.getBatch(id);
    setBatch(next);
    setSmartViews(await window.senseframe.listSmartViews(id));
    if (options?.preserveSmartViewId) {
      const view = await window.senseframe.getSmartView(options.preserveSmartViewId);
      setActiveSmartView(view);
      setMode('smartView');
      const nextIndex = options.preservePhotoId ? view.items.findIndex((item) => item.photoId === options.preservePhotoId) : -1;
      setPhotoIndex(Math.max(0, nextIndex));
      return;
    }
    if (options?.resetView !== false) setActiveSmartView(null);
    if (options?.resetView !== false && mode === 'smartView') setMode('featured');
    setClusterIndex(0);
    setPhotoIndex(0);
  }

  function goHome(): void {
    setBatch(null);
    setMode('featured');
    setActiveSmartView(null);
    setSmartViews([]);
    setClusterIndex(0);
    setPhotoIndex(0);
    setResults([]);
    setQuery('');
    setCanvasPhoto(undefined);
    setNotice('');
  }

  async function removeBatch(id: string, name: string): Promise<void> {
    if (!window.senseframe) return;
    const confirmed = window.confirm(language === 'en-US'
      ? `Delete batch "${name}" and its local originals?\n\nThis removes SenseFrame records, analysis results, preview cache, and the local photo files registered in this batch. Originals cannot be restored from SenseFrame.`
      : `删除批次「${name}」并删除本地原片？\n\n这会删除 SenseFrame 记录、分析结果、预览缓存，以及这个批次里登记的本地照片文件。原片删除后不能从 SenseFrame 恢复。`);
    if (!confirmed) return;
    const result = await window.senseframe.deleteBatch({ batchId: id, deleteOriginals: true });
    if (batch?.id === id) {
      setBatch(null);
      setMode('featured');
      setPhotoIndex(0);
      setClusterIndex(0);
    }
    await refreshBatches();
    setNotice(
      result.failedOriginals
        ? (language === 'en-US' ? `Batch deleted. Deleted ${result.deletedOriginals} originals, ${result.failedOriginals} failed.` : `批次已删除，原片删除 ${result.deletedOriginals} 张，失败 ${result.failedOriginals} 张。`)
        : (language === 'en-US' ? `Batch deleted. Deleted ${result.deletedOriginals} originals.` : `批次已删除，原片删除 ${result.deletedOriginals} 张。`)
    );
  }

  async function rebuildCurrentClusters(): Promise<void> {
    if (!batch || !window.senseframe) return;
    setBusy(language === 'en-US' ? 'Rebuilding near-duplicate groups...' : '正在按近重复规则重建分组...');
    try {
      const next = await window.senseframe.rebuildClusters(batch.id);
      setBatch(next);
      setMode('duplicates');
      setPhotoIndex(0);
      setNotice(language === 'en-US' ? 'Near-duplicate groups rebuilt.' : '近重复分组已重建。');
    } finally {
      setBusy('');
    }
  }

  async function reanalyzeCurrentBatch(): Promise<void> {
    if (!batch || !window.senseframe) return;
    setBusy(language === 'en-US' ? 'Rerunning face and eye analysis from originals...' : '正在用原图重跑人脸与眼部分析...');
    try {
      const next = await window.senseframe.reanalyzeBatch(batch.id);
      setBatch(next);
      setPhotoIndex(0);
      setNotice(language === 'en-US' ? 'Face and eye analysis rerun from originals.' : '已用原图重跑人脸与眼部分析。');
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    refreshBatches().then(() => undefined);
    loadModelSettings().then(() => undefined);
    if (!window.senseframe) return;
    const offImport = window.senseframe.onImportProgress((progress) => {
      setImportProgress(progress);
      const message = localizeTechnicalMessage(progress.message, t);
      setBusy(progress.total ? `${message} ${progress.current || 0}/${progress.total}` : message);
    });
    const offBrain = window.senseframe.onBrainProgress((progress) => {
      setBrainProgress(progress);
      setBrainActivity((items) => [progress, ...items].slice(0, 8));
      if (progress.status === 'running') setBrainBusy(`${progress.message} ${progress.current}/${progress.total}`);
      if (progress.status === 'completed' || progress.status === 'failed') {
        setBrainBusy('');
        const batchId = progress.batchId || activeBatchIdRef.current;
        if (batchId) {
          void loadBatch(batchId, { resetView: false }).then(() => refreshBatches());
        }
      }
    });
    const offXiaogong = window.senseframe.onXiaogongProgress((progress) => {
      setXiaogongProgress(progress);
      if (progress.uiLog) {
        setXiaogongActivity((items) => [...items, progress.uiLog as BrainUiLogEvent].slice(-160));
      }
      if (progress.status === 'running') setXiaogongBusy(progress.message);
      if (progress.status === 'completed' || progress.status === 'failed') setXiaogongBusy('');
    });
    return () => {
      offImport();
      offBrain();
      offXiaogong();
    };
  }, [language, t]);

  const duplicateIds = useMemo(() => (batch ? duplicatePhotoIds(batch) : new Set<string>()), [batch]);
  const clusterMeta = useMemo(() => (batch ? clusterMetaByPhoto(batch) : new Map<string, ClusterMeta>()), [batch]);
  const burstMeta = useMemo(() => (batch ? similarBurstMetaByPhoto(batch) : new Map<string, BurstMeta>()), [batch]);
  const hasBrainCuration = Boolean(batch?.brainRun?.status === 'completed');
  const featuredIds = useMemo(() => {
    if (!batch) return new Set<string>();
    if (hasBrainCuration) {
      return new Set(batch.photos
        .filter((photo) => photo.decision !== 'reject')
        .filter((photo) => photo.brainReview?.primaryBucket === 'featured')
        .map((photo) => photo.id));
    }
    return featuredPhotoIds(batch, burstMeta, clusterMeta);
  }, [batch, burstMeta, clusterMeta, hasBrainCuration]);
  const brainBucketCount = (bucket: ViewMode): number => {
    if (!batch || !hasBrainCuration || bucket === 'search') return 0;
    if (bucket === 'keepers') return batch.photos.filter(isBrainKeeper).length;
    if (bucket === 'lowPriority') return batch.photos.filter(isLowPriorityKeeper).length;
    if (bucket === 'reviewQueue') return batch.photos.filter(isBrainReviewQueue).length;
    return batch.photos.filter((photo) => photo.brainReview?.primaryBucket === bucket).length;
  };
  const bucketDefs = useMemo(() => {
    if (!batch) return [];
    const buckets: Array<{ id: ViewMode; label: string; description: string; count: number; icon: React.ReactNode }> = [
      {
        id: 'featured',
        label: t('buckets.featured'),
        description: hasBrainCuration ? t('bucketDescriptions.featuredBrain') : t('bucketDescriptions.featuredLocal'),
        count: featuredIds.size,
        icon: <Sparkles size={16} />
      },
      {
        id: 'keepers',
        label: t('buckets.keepers'),
        description: hasBrainCuration ? t('bucketDescriptions.keepersBrain') : t('bucketDescriptions.generatedByXiaogong'),
        count: hasBrainCuration ? brainBucketCount('keepers') : 0,
        icon: <Check size={16} />
      },
      {
        id: 'lowPriority',
        label: t('buckets.lowPriority'),
        description: hasBrainCuration ? t('bucketDescriptions.lowPriorityBrain') : t('bucketDescriptions.generatedByXiaogong'),
        count: hasBrainCuration ? brainBucketCount('lowPriority') : 0,
        icon: <Star size={16} />
      },
      {
        id: 'reviewQueue',
        label: t('buckets.reviewQueue'),
        description: hasBrainCuration ? t('bucketDescriptions.reviewQueueBrain') : t('bucketDescriptions.generatedByXiaogong'),
        count: hasBrainCuration ? brainBucketCount('reviewQueue') : 0,
        icon: <Brain size={16} />
      },
      {
        id: 'closedEyes',
        label: t('buckets.closedEyes'),
        description: hasBrainCuration ? t('bucketDescriptions.closedEyesBrain') : t('bucketDescriptions.closedEyesLocal'),
        count: hasBrainCuration ? brainBucketCount('closedEyes') : batch.photos.filter((photo) => hasAnyFlag(photo, closedEyeFlags)).length,
        icon: <Eye size={16} />
      },
      {
        id: 'eyeReview',
        label: t('buckets.eyeReview'),
        description: hasBrainCuration ? t('bucketDescriptions.eyeReviewBrain') : t('bucketDescriptions.eyeReviewLocal'),
        count: hasBrainCuration ? brainBucketCount('eyeReview') : batch.photos.filter((photo) => hasAnyFlag(photo, eyeReviewFlags)).length,
        icon: <Eye size={16} />
      },
      {
        id: 'subject',
        label: t('buckets.subject'),
        description: hasBrainCuration ? t('bucketDescriptions.subjectBrain') : t('bucketDescriptions.subjectLocal'),
        count: hasBrainCuration ? brainBucketCount('subject') : batch.photos.filter((photo) => hasAnyFlag(photo, subjectFlags)).length,
        icon: <ImageIcon size={16} />
      },
      {
        id: 'technical',
        label: t('buckets.technical'),
        description: hasBrainCuration ? t('bucketDescriptions.technicalBrain') : t('bucketDescriptions.technicalLocal'),
        count: hasBrainCuration ? brainBucketCount('technical') : batch.photos.filter((photo) => hasAnyFlag(photo, technicalFlags) || photo.status !== 'ready').length,
        icon: <TriangleAlert size={16} />
      },
      {
        id: 'duplicates',
        label: t('buckets.duplicates'),
        description: hasBrainCuration ? t('bucketDescriptions.duplicatesBrain') : t('bucketDescriptions.duplicatesLocal'),
        count: hasBrainCuration ? brainBucketCount('duplicates') : duplicateIds.size,
        icon: <Layers size={16} />
      },
      {
        id: 'similarBursts',
        label: t('buckets.similarBursts'),
        description: t('bucketDescriptions.similarBursts'),
        count: hasBrainCuration ? brainBucketCount('similarBursts') : burstMeta.size,
        icon: <Layers size={16} />
      },
      {
        id: 'pending',
        label: t('buckets.pending'),
        description: hasBrainCuration ? t('bucketDescriptions.pendingBrain') : t('bucketDescriptions.pendingLocal'),
        count: hasBrainCuration ? brainBucketCount('pending') : batch.photos.filter((photo) => {
          const flags = photo.analysis?.riskFlags || [];
          return photo.analysis?.eyeState === 'uncertain' || photo.analysis?.faceVisibility === 'unknown' || (flags.length > 0 && !featuredIds.has(photo.id));
        }).length,
        icon: <Brain size={16} />
      }
    ];
    return buckets;
  }, [batch, duplicateIds, burstMeta, featuredIds, hasBrainCuration, t]);
  const activeBucket = bucketDefs.find((bucket) => bucket.id === mode);
  const visiblePhotos = useMemo(() => {
    if (!batch) return [];
    if (mode === 'search') return results.map((item) => item.photo);
    if (mode === 'smartView' && activeSmartView) {
      const byId = new Map(batch.photos.map((photo) => [photo.id, photo]));
      return activeSmartView.items
        .map((item) => byId.get(item.photoId))
        .filter((photo): photo is PhotoView => Boolean(photo));
    }
    if (mode === 'featured') return batch.photos.filter((photo) => featuredIds.has(photo.id)).sort((a, b) => reviewScore(b) - reviewScore(a));
    if (mode === 'keepers') {
      return batch.photos
        .filter(isBrainKeeper)
        .sort((a, b) => reviewScore(b) - reviewScore(a));
    }
    if (mode === 'lowPriority') {
      return batch.photos
        .filter(isLowPriorityKeeper)
        .sort((a, b) => reviewScore(b) - reviewScore(a));
    }
    if (mode === 'reviewQueue') {
      return batch.photos
        .filter(isBrainReviewQueue)
        .sort((a, b) => reviewScore(b) - reviewScore(a));
    }
    if (hasBrainCuration) return batch.photos.filter((photo) => photo.brainReview?.primaryBucket === mode);
    if (mode === 'closedEyes') return batch.photos.filter((photo) => hasAnyFlag(photo, closedEyeFlags));
    if (mode === 'eyeReview') return batch.photos.filter((photo) => hasAnyFlag(photo, eyeReviewFlags));
    if (mode === 'subject') return batch.photos.filter((photo) => hasAnyFlag(photo, subjectFlags));
    if (mode === 'technical') return batch.photos.filter((photo) => hasAnyFlag(photo, technicalFlags) || photo.status !== 'ready');
    if (mode === 'duplicates') {
      const byId = new Map(batch.photos.map((photo) => [photo.id, photo]));
      return batch.clusters
        .filter((cluster) => cluster.size > 1)
        .flatMap((cluster) => cluster.members.map((member) => byId.get(member.photoId)).filter((photo): photo is PhotoView => Boolean(photo)));
    }
    if (mode === 'similarBursts') {
      return [...batch.photos]
        .filter((photo) => burstMeta.has(photo.id))
        .sort((a, b) => {
          const aMeta = burstMeta.get(a.id);
          const bMeta = burstMeta.get(b.id);
          return (aMeta?.burstNumber || 0) - (bMeta?.burstNumber || 0) || (aMeta?.rank || 0) - (bMeta?.rank || 0);
        });
    }
    if (mode === 'pending') return batch.photos.filter((photo) => {
      const flags = photo.analysis?.riskFlags || [];
      return photo.analysis?.eyeState === 'uncertain' || photo.analysis?.faceVisibility === 'unknown' || (flags.length > 0 && !featuredIds.has(photo.id));
    });
    return [];
  }, [batch, mode, results, activeSmartView, duplicateIds, burstMeta, featuredIds, hasBrainCuration]);
  const activePhoto = visiblePhotos[Math.min(photoIndex, Math.max(visiblePhotos.length - 1, 0))];
  const activeSmartViewItem = activeSmartView?.items.find((item) => item.photoId === activePhoto?.id);
  const activeClusterMeta = activePhoto ? clusterMeta.get(activePhoto.id) : undefined;
  const activeBurstMeta = activePhoto ? burstMeta.get(activePhoto.id) : undefined;
  const isFitZoom = imageZoom === 1;
  const canvasPhotoIndex = canvasPhoto ? visiblePhotos.findIndex((photo) => photo.id === canvasPhoto.id) : -1;

  useEffect(() => {
    setImageZoom(1);
    setImagePan({ x: 0, y: 0 });

    if (!activePhoto) {
      setCanvasPhoto(undefined);
      setImageSize({ width: 0, height: 0 });
      return;
    }

    if (!activePhoto.previewPath || !window.senseframe) {
      setCanvasPhoto(activePhoto);
      setImageSize({
        width: activePhoto.width || 0,
        height: activePhoto.height || 0
      });
      return;
    }

    let cancelled = false;
    const loader = new window.Image();
    loader.decoding = 'async';
    loader.onload = () => {
      const applyLoadedPhoto = () => {
        if (cancelled) return;
        setImageSize({
          width: loader.naturalWidth || activePhoto.width || 0,
          height: loader.naturalHeight || activePhoto.height || 0
        });
        setCanvasPhoto(activePhoto);
      };

      if (typeof loader.decode === 'function') {
        loader.decode().catch(() => undefined).then(applyLoadedPhoto);
        return;
      }

      applyLoadedPhoto();
    };
    loader.onerror = () => {
      if (!cancelled) setCanvasPhoto(activePhoto);
    };
    loader.src = window.senseframe.fileUrl(activePhoto.previewPath);

    return () => {
      cancelled = true;
    };
  }, [activePhoto?.id]);

  useEffect(() => {
    if (!window.senseframe || !visiblePhotos.length) return;
    const preload = new Set<number>([photoIndex - 2, photoIndex - 1, photoIndex + 1, photoIndex + 2]);
    const loaders = [...preload]
      .map((index) => visiblePhotos[index])
      .filter((photo): photo is PhotoView => Boolean(photo?.previewPath))
      .map((photo) => {
        const loader = new window.Image();
        loader.decoding = 'async';
        loader.src = window.senseframe!.fileUrl(photo.previewPath!);
        return loader;
      });

    return () => {
      loaders.forEach((loader) => {
        loader.onload = null;
        loader.onerror = null;
      });
    };
  }, [visiblePhotos, photoIndex]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setStageSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [batch?.id, activePhoto?.id]);

  const fittedImageSize = useMemo(() => {
    if (!stageSize.width || !stageSize.height || !imageSize.width || !imageSize.height) return null;
    const safeWidth = Math.max(120, stageSize.width - 32);
    const safeHeight = Math.max(120, stageSize.height - 32);
    const scale = Math.min(safeWidth / imageSize.width, safeHeight / imageSize.height);
    return {
      width: Math.max(1, imageSize.width * scale),
      height: Math.max(1, imageSize.height * scale)
    };
  }, [stageSize, imageSize]);

  const stats = useMemo(() => {
    if (!batch) return { candidates: 0, review: 0, picked: 0, rejected: 0 };
    return {
      candidates: featuredIds.size,
      review: batch.photos.filter((photo) => photo.analysis?.riskFlags.length || photo.status !== 'ready').length,
      picked: batch.photos.filter((photo) => photo.decision === 'pick').length,
      rejected: batch.photos.filter((photo) => photo.decision === 'reject').length
    };
  }, [batch, featuredIds]);

  async function importSource(kind: 'folder' | 'archive' = 'folder'): Promise<void> {
    if (importProgress) return;
    if (!window.senseframe) {
      setNotice(language === 'en-US' ? 'Please use the SenseFrame desktop window to import assets.' : '请在 SenseFrame 桌面端窗口中导入素材。');
      return;
    }
    setImportProgress({
      stage: kind === 'archive' ? 'extracting' : 'scanning',
      message: kind === 'archive' ? t('import.openingArchive') : t('import.openingFolder')
    });
    const source = kind === 'archive' ? await window.senseframe.chooseArchive() : await window.senseframe.chooseFolder();
    if (!source) {
      setNotice(t('import.cancelled'));
      setImportProgress(null);
      return;
    }
    setBusy(source.toLowerCase().endsWith('.rar') ? t('import.extractingBusy') : t('import.importingBusy'));
    setImportProgress({
      stage: source.toLowerCase().endsWith('.rar') ? 'extracting' : 'scanning',
      message: source.toLowerCase().endsWith('.rar') ? t('import.extracting') : t('import.scanning')
    });
    try {
      const result = await window.senseframe.importSource(source);
      await refreshBatches();
      await loadBatch(result.batchId);
      setNotice(result.sourceType === 'archive'
        ? t('import.doneArchive', { imported: result.imported, unsupported: result.unsupported })
        : t('import.doneFolder', { imported: result.imported, unsupported: result.unsupported }));
    } catch (error) {
      const hint = await window.senseframe.workerHint();
      setNotice(`${error instanceof Error ? error.message : String(error)}${language === 'en-US' ? '. ' : '。'}${hint}`);
    } finally {
      setBusy('');
      setImportProgress(null);
    }
  }

  function setZoom(next: number): void {
    const zoom = Math.max(1, Math.min(4, next));
    setImageZoom(zoom);
    if (zoom === 1) setImagePan({ x: 0, y: 0 });
  }

  function startCanvasPan(event: React.PointerEvent<HTMLDivElement>): void {
    if (imageZoom === 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, panX: imagePan.x, panY: imagePan.y };
  }

  function moveCanvasPan(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) return;
    setImagePan({
      x: dragRef.current.panX + event.clientX - dragRef.current.x,
      y: dragRef.current.panY + event.clientY - dragRef.current.y
    });
  }

  function stopCanvasPan(): void {
    dragRef.current = null;
  }

  async function decide(decision: Decision, rating?: number): Promise<void> {
    if (!batch || !activePhoto) return;
    if (!window.senseframe) return;
    const preserveSmartViewId = mode === 'smartView' ? activeSmartView?.id : undefined;
    const preservePhotoId = activePhoto.id;
    await window.senseframe.saveDecision({ batchId: batch.id, photoId: activePhoto.id, decision, rating });
    await loadBatch(batch.id, { preserveSmartViewId, preservePhotoId, resetView: !preserveSmartViewId });
  }

  async function analyzeSemantic(): Promise<void> {
    if (!batch || !activePhoto) return;
    if (!window.senseframe) return;
    setBusy(language === 'en-US' ? 'Generating semantic tags and recommendation notes...' : '正在生成语义标签和推荐说明...');
    try {
      await window.senseframe.analyzeSemantic({ batchId: batch.id, photoId: activePhoto.id });
      await loadBatch(batch.id);
    } finally {
      setBusy('');
    }
  }

  async function runSearch(): Promise<void> {
    if (!batch || !query.trim()) return;
    if (!window.senseframe) return;
    setBusy(language === 'en-US' ? 'Searching semantically...' : '正在语义搜索...');
    try {
      const searchResults = await window.senseframe.search({ batchId: batch.id, query });
      setResults(searchResults);
      setMode('search');
      setPhotoIndex(0);
    } finally {
      setBusy('');
    }
  }

  async function exportCsv(): Promise<void> {
    if (!batch) return;
    if (!window.senseframe) return;
    const path = await window.senseframe.exportCsv(batch.id);
    setNotice(language === 'en-US' ? `Exported: ${path}` : `已导出：${path}`);
  }

  async function exportSelected(): Promise<void> {
    if (!batch) return;
    if (!window.senseframe) return;
    if (!stats.picked) {
      setNotice(language === 'en-US' ? 'No photos are marked as kept yet.' : '还没有标记为“保留”的照片。');
      return;
    }

    const result = await window.senseframe.exportSelected(batch.id);
    if (result) setNotice(language === 'en-US' ? `Exported ${result.count} selected photos: ${result.dir}` : `已导出 ${result.count} 张已选照片：${result.dir}`);
  }

  async function runBrainReview(): Promise<void> {
    if (!batch || !window.senseframe || !batch.photos.length) return;
    setBrainBusy(t('xiaogong.busyReview', { count: batch.photos.length }));
    setBrainProgress(null);
    setBrainActivity([]);
    setLastBrainRun(null);
    try {
      const result = await window.senseframe.startBrainReview({
        batchId: batch.id,
        scope: 'batch',
        focusMode: mode,
        activePhotoId: activePhoto?.id,
        language
      });
      setLastBrainRun(result);
      await loadBatch(batch.id, { resetView: true });
      const nextSmartViewId = result.uiPatch?.smartViewId || result.smartView?.id;
      if (nextSmartViewId) {
        setSmartViews(await window.senseframe.listSmartViews(batch.id));
        await openSmartView(nextSmartViewId);
      } else {
        setMode(result.status === 'completed' ? 'keepers' : mode === 'smartView' ? 'featured' : mode);
      }
      setNotice(result.status === 'completed' ? result.uiPatch?.notice || result.message : t('xiaogong.reviewFailed', { message: result.message }));
    } catch (error) {
      setNotice(t('xiaogong.reviewFailed', { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBrainBusy('');
    }
  }

  async function openSmartView(viewId: string): Promise<void> {
    if (!window.senseframe) return;
    const view = await window.senseframe.getSmartView(viewId);
    setActiveSmartView(view);
    setMode('smartView');
    setPhotoIndex(0);
  }

  async function runXiaogong(message: string = xiaogongInput): Promise<void> {
    if (!batch || !window.senseframe || !message.trim()) return;
    setXiaogongBusy(t('xiaogong.handoff'));
    setXiaogongProgress(null);
    setXiaogongActivity([]);
    setLastXiaogongResult(null);
    try {
      const result = await window.senseframe.runXiaogong({
        batchId: batch.id,
        message: message.trim(),
        currentMode: mode,
        activePhotoId: activePhoto?.id,
        smartViewId: activeSmartView?.id,
        language
      });
      setLastXiaogongResult(result);
      setXiaogongProgress(null);
      const nextSmartViews = await window.senseframe.listSmartViews(batch.id);
      setSmartViews(nextSmartViews);
      const nextSmartViewId = result.uiPatch?.smartViewId || result.smartView?.id;
      if (nextSmartViewId) {
        await openSmartView(nextSmartViewId);
      }
      setNotice(result.uiPatch?.notice || result.message);
      setXiaogongInput('');
    } catch (error) {
      setNotice(t('xiaogong.taskFailed', { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setXiaogongBusy('');
    }
  }

  async function applyBrainSuggestion(review: BrainPhotoReview): Promise<void> {
    if (!batch || !activePhoto || !window.senseframe) return;
    if (review.recommendedAction === 'pick' || review.recommendedAction === 'reject' || review.recommendedAction === 'maybe') {
      const preserveSmartViewId = mode === 'smartView' ? activeSmartView?.id : undefined;
      const preservePhotoId = activePhoto.id;
      await window.senseframe.recordBrainFeedback({ photoId: activePhoto.id, runId: review.runId, action: 'accepted', note: review.recommendedAction });
      await window.senseframe.saveDecision({ batchId: batch.id, photoId: activePhoto.id, decision: review.recommendedAction });
      await loadBatch(batch.id, { preserveSmartViewId, preservePhotoId, resetView: !preserveSmartViewId });
      setNotice(t('xiaogong.acceptedNotice'));
      return;
    }
    await window.senseframe.recordBrainFeedback({ photoId: activePhoto.id, runId: review.runId, action: 'reviewed', note: 'no direct decision' });
    setNotice(t('xiaogong.reviewNotice'));
  }

  async function rejectBrainSuggestion(review: BrainPhotoReview, note?: string): Promise<void> {
    if (!activePhoto || !window.senseframe) return;
    await window.senseframe.recordBrainFeedback({ photoId: activePhoto.id, runId: review.runId, action: 'rejected', note: note?.trim() || undefined });
    setNotice(note?.trim() ? t('xiaogong.rejectedWithNoteNotice') : t('xiaogong.rejectedNotice'));
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'ArrowRight') setPhotoIndex((value) => Math.min(value + 1, Math.max(visiblePhotos.length - 1, 0)));
      if (event.key === 'ArrowLeft') setPhotoIndex((value) => Math.max(value - 1, 0));
      if (event.key === 'ArrowDown') {
        setClusterIndex((value) => Math.min(value + 1, Math.max((batch?.clusters.length || 1) - 1, 0)));
        setPhotoIndex(0);
      }
      if (event.key === 'ArrowUp') {
        setClusterIndex((value) => Math.max(value - 1, 0));
        setPhotoIndex(0);
      }
      if (event.key.toLowerCase() === 'p') decide('pick');
      if (event.key.toLowerCase() === 'x') decide('reject');
      if (event.key.toLowerCase() === 'u') decide('maybe');
      if (/^[1-5]$/.test(event.key)) decide('pick', Number(event.key));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visiblePhotos.length, batch, activePhoto]);

  return (
    <main className={`app-shell ${batch ? 'app-shell-ready' : 'app-shell-empty'}`}>
      {batch && <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Aperture size={22} /></div>
          <div>
            <div className="brand-name">SenseFrame</div>
            <div className="brand-sub">AI Culling Studio</div>
          </div>
        </div>

        <div className="import-actions">
          <button className="primary-action" onClick={() => importSource('folder')} disabled={Boolean(importProgress)}>
            <FolderOpen size={16} /> {t('actions.import')}
          </button>
          <button className="secondary-action" onClick={() => importSource('archive')} disabled={Boolean(importProgress)}>RAR</button>
        </div>

        {batch && (
          <div className="stats">
            <Metric label={t('sidebar.total')} value={batch.photos.length} />
            <Metric label={t('sidebar.featured')} value={stats.candidates} />
            <Metric label={t('sidebar.review')} value={stats.review} />
            <Metric label={t('sidebar.selected')} value={stats.picked} />
            <button className="mini-tool" onClick={rebuildCurrentClusters}>{t('actions.rebuildClusters')}</button>
            <button className="mini-tool" onClick={reanalyzeCurrentBatch}>{t('actions.reanalyze')}</button>
          </div>
        )}

        <div className="batch-list">
          <div className="section-label">{t('sidebar.batches')}</div>
          {batches.map((item, index) => (
            <div key={item.id} className={`batch-item ${batch?.id === item.id ? 'active' : ''}`}>
              <button className="batch-open" onClick={() => loadBatch(item.id)}>
                <span>{t('sidebar.batch', { index: String(index + 1).padStart(2, '0') })}</span>
                <small>{item.name}</small>
              </button>
              <span className="batch-count">{item.totalPhotos}</span>
              <button
                className="batch-delete"
                title={t('actions.deleteBatch')}
                aria-label={`${t('actions.deleteBatch')} ${item.name}`}
                onClick={() => removeBatch(item.id, item.name)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>

        {batch && (
          <div className="ai-buckets">
            <div className="section-label">{t('sidebar.aiBuckets')}</div>
            {bucketDefs.map((bucket) => (
              <button
                key={bucket.id}
                className={`bucket-item ${mode === bucket.id ? 'active' : ''}`}
                onClick={() => {
                  setMode(bucket.id);
                  setPhotoIndex(0);
                }}
              >
                <span className="bucket-icon">{bucket.icon}</span>
                <span className="bucket-text">
                  <strong>{bucket.label}</strong>
                  <small>{bucket.description}</small>
                </span>
                <em>{bucket.count}</em>
              </button>
            ))}
          </div>
        )}

        {batch && smartViews.length > 0 && (
          <div className="xiaogong-views">
            <div className="section-label">{t('sidebar.xiaogongViews')}</div>
            {smartViews.map((view) => (
              <button
                key={view.id}
                className={`bucket-item smart-view-item ${activeSmartView?.id === view.id && mode === 'smartView' ? 'active' : ''}`}
                onClick={() => openSmartView(view.id)}
              >
                <span className="bucket-icon"><Brain size={15} /></span>
                <span className="bucket-text">
                  <strong>{view.name}</strong>
                  <small>{view.summary}</small>
                </span>
                <em>{view.photoCount}</em>
              </button>
            ))}
          </div>
        )}
      </aside>}

      <section className={`workspace ${batch ? 'workspace-ready' : 'workspace-empty'}`}>
        <header className="topbar">
          <div className="topbar-title">
            {batch && (
              <button className="home-command" onClick={goHome} title={t('actions.home')} aria-label={t('actions.home')}>
                <Home size={15} />
                <span>{t('actions.home')}</span>
              </button>
            )}
            <div>
              <h1>{batch ? `${mode === 'smartView' ? activeSmartView?.name || t('sidebar.xiaogongViews') : activeBucket?.label || t('topbar.search')} · ${visiblePhotos.length}` : t('topbar.titleEmpty')}</h1>
              <p>{batch ? (mode === 'smartView' && activeSmartView ? activeSmartView.summary : t('topbar.batchSummary', { name: batch.name, clusters: batch.clusters.length, rejected: stats.rejected })) : t('topbar.subtitleEmpty')}</p>
            </div>
          </div>
          <div className="toolbar">
            {batch && (
              <>
              <button className="brain-action" onClick={runBrainReview} disabled={Boolean(brainBusy || busy)} title={t('xiaogong.reviewTitle')}>
                {brainBusy ? <Loader2 className="spin" size={16} /> : <Brain size={16} />} {t('xiaogong.reviewButton')}
              </button>
              <button onClick={exportSelected} title={t('actions.exportSelected')}><Download size={16} /> {t('actions.export')}</button>
              </>
            )}
            <button
              className={!modelSettings.apiKey ? 'needs-settings' : ''}
              onClick={() => {
                setSettingsDraft(modelSettings);
                setSettingsOpen(true);
              }}
              title={t('settings.title')}
            >
              <Settings size={16} /> {t('actions.settings')}
            </button>
          </div>
        </header>

        {!batch ? (
          <EmptyState
            batches={batches}
            onImportFolder={() => importSource('folder')}
            onImportArchive={() => importSource('archive')}
            onOpenBatch={loadBatch}
            onRemoveBatch={removeBatch}
            disabled={Boolean(importProgress)}
            t={t}
          />
        ) : (
          <div className="main-grid">
            <section className="viewer">
              <div
                ref={stageRef}
                className={`image-stage ${isFitZoom ? 'fit' : 'zoomed'}`}
                onPointerDown={startCanvasPan}
                onPointerMove={moveCanvasPan}
                onPointerUp={stopCanvasPan}
                onPointerCancel={stopCanvasPan}
                >
                {canvasPhoto && (
                  <div className="canvas-hud">
                    <span>{mode === 'smartView' ? activeSmartView?.name || t('sidebar.xiaogongViews') : activeBucket?.label || t('topbar.review')}</span>
                    <strong>{canvasPhoto.fileName}</strong>
                    <em>{visiblePhotos.length ? `${canvasPhotoIndex >= 0 ? canvasPhotoIndex + 1 : Math.min(photoIndex + 1, visiblePhotos.length)} / ${visiblePhotos.length}` : '0 / 0'}</em>
                  </div>
                )}
                {canvasPhoto?.previewPath ? (
                  <div
                    className="debug-image-wrap"
                    style={{
                      width: fittedImageSize ? `${fittedImageSize.width}px` : undefined,
                      height: fittedImageSize ? `${fittedImageSize.height}px` : undefined,
                      transform: `translate(${imagePan.x}px, ${imagePan.y}px) scale(${imageZoom})`
                    }}
                  >
                    <img
                      src={window.senseframe?.fileUrl(canvasPhoto.previewPath)}
                      alt={canvasPhoto.fileName}
                      onLoad={(event) => setImageSize({
                        width: event.currentTarget.naturalWidth,
                        height: event.currentTarget.naturalHeight
                      })}
                    />
                    {debugMode && <DebugOverlay photo={canvasPhoto} />}
                  </div>
                ) : visiblePhotos.length === 0 ? (
                  <div className="missing-preview"><Layers size={46} />{t('photo.missingGroup')}</div>
                ) : (
                  <div className="missing-preview"><ImageIcon size={46} />{t('photo.previewUnavailable')}</div>
                )}
                {activePhoto?.previewPath && (
                  <div className="zoom-controls" aria-label={language === 'en-US' ? 'Image zoom' : '图片缩放'} onPointerDown={(event) => event.stopPropagation()}>
                    <button title={t('actions.zoomOut')} onClick={() => setZoom(imageZoom - 0.25)}>
                      <ZoomOut size={16} />
                    </button>
                    <button className={isFitZoom ? 'selected' : ''} onClick={() => { setImageZoom(1); setImagePan({ x: 0, y: 0 }); }}>{t('actions.fit')}</button>
                    <button className="zoom-value">{Math.round(imageZoom * 100)}%</button>
                    <button title={t('actions.zoomIn')} onClick={() => setZoom(imageZoom + 0.25)}>
                      <ZoomIn size={16} />
                    </button>
                  </div>
                )}
              </div>
              <div className="filmstrip">
                {visiblePhotos.map((photo, index) => {
                  const meta = clusterMeta.get(photo.id);
                  const burst = burstMeta.get(photo.id);
                  const featured = featuredIds.has(photo.id);
                  return (
                    <button
                      key={photo.id}
                      className={`thumb ${index === photoIndex ? 'active' : ''} ${photo.decision} ${meta || burst ? 'clustered' : ''} ${featured ? 'cluster-best' : ''}`}
                      title={
                        meta
                            ? t('photo.duplicate', { group: meta.clusterNumber, rank: meta.rank, size: meta.clusterSize, similarity: pct(meta.similarityToBest) })
                            : burst
                            ? t('photo.burst', { group: burst.burstNumber, label: burst.label, rank: burst.rank, size: burst.burstSize })
                            : photo.fileName
                      }
                      onClick={() => setPhotoIndex(index)}
                    >
                      {photo.thumbPath ? <img src={window.senseframe?.fileUrl(photo.thumbPath)} alt="" /> : <ImageIcon size={20} />}
                      {meta && <span className="cluster-badge">G{meta.clusterNumber}</span>}
                      {!meta && burst && <span className="cluster-badge burst">B{burst.burstNumber}</span>}
                      {meta && <span className="rank-badge">{meta.rank}/{meta.clusterSize}</span>}
                      {!meta && burst && <span className="rank-badge">{burst.rank}/{burst.burstSize}</span>}
                      {featured && <span className="badge">{t('photo.featuredBadge')}</span>}
                      {mode === 'smartView' && activeSmartView && <span className="smart-rank">#{index + 1}</span>}
                    </button>
                  );
                })}
              </div>
            </section>

            <aside className="inspector">
              {activeClusterMeta && (
                <div className="cluster-note">
                  <strong>近重复 G{activeClusterMeta.clusterNumber}</strong>
                  <span>{language === 'en-US' ? `${activeClusterMeta.rank}/${activeClusterMeta.clusterSize} · similarity ${pct(activeClusterMeta.similarityToBest)} · ${activeClusterMeta.recommended ? t('photo.groupRecommended') : t('photo.backup')}` : `第 ${activeClusterMeta.rank}/${activeClusterMeta.clusterSize} · 相似 ${pct(activeClusterMeta.similarityToBest)} · ${activeClusterMeta.recommended ? t('photo.groupRecommended') : t('photo.backup')}`}</span>
                </div>
              )}
              {activeBurstMeta && !activeClusterMeta && (
                <div className="cluster-note">
                  <strong>{t('buckets.similarBursts')} B{activeBurstMeta.burstNumber}</strong>
                  <span>{language === 'en-US' ? `${activeBurstMeta.label} · ${activeBurstMeta.rank}/${activeBurstMeta.burstSize}` : `${activeBurstMeta.label} · 第 ${activeBurstMeta.rank}/${activeBurstMeta.burstSize}`}</span>
                </div>
              )}
              <BrainActivityPanel
                progress={brainProgress}
                activity={brainActivity}
                active={Boolean(brainBusy)}
                lastRun={lastBrainRun}
                t={t}
              />
              <PhotoPanel
                photo={activePhoto}
                onDecide={decide}
                onApplyBrainSuggestion={applyBrainSuggestion}
                onRejectBrainSuggestion={rejectBrainSuggestion}
                t={t}
              />
              <XiaogongConsole
                busy={xiaogongBusy}
                input={xiaogongInput}
                activity={xiaogongActivity}
                result={lastXiaogongResult}
                activeSmartView={activeSmartView}
                activeItem={activeSmartViewItem}
                onInput={setXiaogongInput}
                onRun={runXiaogong}
                t={t}
              />
            </aside>
          </div>
        )}

        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" aria-label={t('actions.close')} onClick={() => setNotice('')}>
              <X size={14} />
            </button>
          </div>
        )}
        {settingsOpen && (
          <ModelSettingsDialog
            value={settingsDraft}
            saving={settingsSaving}
            onChange={setSettingsDraft}
            onCancel={() => {
              setSettingsDraft(modelSettings);
              setSettingsOpen(false);
            }}
            onSave={saveSettings}
            t={t}
          />
        )}
        {importProgress && <ImportOverlay progress={importProgress} t={t} />}
      </section>
    </main>
  );
}

function ModelSettingsDialog({
  value,
  saving,
  onChange,
  onCancel,
  onSave,
  t
}: {
  value: ModelSettings;
  saving: boolean;
  onChange: (value: ModelSettings) => void;
  onCancel: () => void;
  onSave: () => void;
  t: Translator;
}): React.ReactElement {
  const canSave = Boolean(value.baseUrl.trim() && value.model.trim());
  const configured = Boolean(value.apiKey.trim());

  return (
    <div className="settings-backdrop" role="presentation">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
        <div className="settings-dialog-head">
          <div className="settings-title-lockup">
            <span><Brain size={16} /></span>
            <div>
              <h2 id="model-settings-title">{t('settings.title')}</h2>
              <p>{t('settings.subtitle')}</p>
            </div>
          </div>
          <button type="button" onClick={onCancel} aria-label={t('actions.close')}>
            <X size={16} />
          </button>
        </div>

        <div className={`settings-status ${configured ? 'ready' : 'empty'}`}>
          <div>
            <strong>{configured ? t('settings.configured') : t('settings.waiting')}</strong>
            <span>{configured ? t('settings.configuredDetail', { model: value.model || '-', baseUrl: value.baseUrl || '-' }) : t('settings.waitingDetail')}</span>
          </div>
          <em>{configured ? t('settings.ready') : t('settings.setup')}</em>
        </div>

        <div className="settings-fields">
          <label className="settings-field">
            <span><Server size={14} /> {t('settings.baseUrl')}</span>
            <div>
              <input
                value={value.baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
              />
            </div>
          </label>

          <label className="settings-field">
            <span><SlidersHorizontal size={14} /> {t('settings.model')}</span>
            <div>
              <input
                value={value.model}
                placeholder="gpt-5.5"
                onChange={(event) => onChange({ ...value, model: event.target.value })}
              />
            </div>
          </label>

          <label className="settings-field">
            <span><SlidersHorizontal size={14} /> {t('settings.language')}</span>
            <div>
              <select
                value={normalizeLanguage(value.language)}
                onChange={(event) => onChange({ ...value, language: normalizeLanguage(event.target.value) })}
              >
                <option value="zh-CN">{t('app.languageChinese')}</option>
                <option value="en-US">{t('app.languageEnglish')}</option>
              </select>
            </div>
          </label>

          <label className="settings-field">
            <span><KeyRound size={14} /> API Key</span>
            <div>
              <input
                type="password"
                value={value.apiKey}
                placeholder="sk-..."
                autoComplete="off"
                onChange={(event) => onChange({ ...value, apiKey: event.target.value })}
              />
            </div>
          </label>
        </div>

        <div className="settings-dialog-actions">
          <button type="button" onClick={onCancel}>{t('actions.cancel')}</button>
          <button type="button" className="primary" onClick={onSave} disabled={!canSave || saving}>
            {saving ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
            {t('actions.save')}
          </button>
        </div>
      </section>
    </div>
  );
}

function DebugOverlay({ photo }: { photo: PhotoView }): React.ReactElement {
  const regions = photo.analysis?.debugRegions || [];
  return (
    <div className="debug-overlay">
      {regions.map((region, index) => {
        const label = debugRegionLabel(region.label);
        if (region.kind === 'landmark' && region.point) {
          const [x, y] = region.point;
          return (
            <span
              key={`${region.kind}-${index}`}
              className="debug-point"
              title={label}
              style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
            />
          );
        }
        if (!region.box) return null;
        const [x, y, w, h] = region.box;
        return (
          <span
            key={`${region.kind}-${index}`}
            className={`debug-box ${region.kind}`}
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
          >
            <em>{label}</em>
          </span>
        );
      })}
      {!regions.length && <span className="debug-empty">暂无调试框；重新导入或重跑分析后生成</span>}
    </div>
  );
}

function debugRegionLabel(label: string): string {
  const exact: Record<string, string> = {
    right_eye: '右眼',
    left_eye: '左眼',
    nose: '鼻尖',
    mouth_right: '右嘴角',
    mouth_left: '左嘴角',
    'left landmark': '左眼裁剪 关键点',
    'right landmark': '右眼裁剪 关键点',
    'left detected': '左眼裁剪 检测',
    'right detected': '右眼裁剪 检测',
    'left estimated': '左眼裁剪 估算',
    'right estimated': '右眼裁剪 估算'
  };
  if (exact[label]) return exact[label];
  return label
    .replace(/^scrfd /, '人脸 SCRFD ')
    .replace(/^yunet /, '人脸 YuNet ')
    .replace(/^haar /, '人脸 Haar ');
}

function Metric({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function EmptyState({
  batches,
  onImportFolder,
  onImportArchive,
  onOpenBatch,
  onRemoveBatch,
  disabled,
  t
}: {
  batches: Array<{ id: string; name: string; status: string; totalPhotos: number; createdAt: string }>;
  onImportFolder: () => void;
  onImportArchive: () => void;
  onOpenBatch: (batchId: string) => void | Promise<void>;
  onRemoveBatch: (batchId: string, name: string) => void | Promise<void>;
  disabled: boolean;
  t: Translator;
}): React.ReactElement {
  return (
    <div className="empty studio-empty">
      <section className="studio-hero">
        <div className="hero-copy">
          <span className="frame-kicker">{t('home.kicker')}</span>
          <h2>{t('home.title')}</h2>
          <p>{t('home.body')}</p>
          <div className="hero-actions">
            <button className="import-button" onClick={onImportFolder} disabled={disabled}><FolderOpen size={18} /> {t('actions.importFolder')}</button>
            <button className="archive-button" onClick={onImportArchive} disabled={disabled}>RAR</button>
          </div>
          {batches.length > 0 && (
            <div className="home-batches">
              <div className="home-batches-head">
                <span>{t('home.recentBatches')}</span>
                <em>{batches.length}</em>
              </div>
              <div className="home-batch-list">
                {batches.slice(0, 4).map((item, index) => (
                  <div key={item.id} className="home-batch-item">
                    <button onClick={() => onOpenBatch(item.id)}>
                      <strong>{t('sidebar.batch', { index: String(index + 1).padStart(2, '0') })}</strong>
                      <span>{item.name}</span>
                    </button>
                    <em>{item.totalPhotos}</em>
                    <button
                      className="home-batch-delete"
                      title={t('actions.deleteBatch')}
                      aria-label={`${t('actions.deleteBatch')} ${item.name}`}
                      onClick={() => onRemoveBatch(item.id, item.name)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="light-table" aria-hidden="true">
          <div className="contact-frame main-frame">
            <span />
            <i />
          </div>
          <div className="contact-frame side-frame one"><span /><i /></div>
          <div className="contact-frame side-frame two"><span /><i /></div>
          <div className="scan-line" />
        </div>
      </section>

      <section className="readiness-grid studio-readiness">
        <div className="readiness-card">
          <ImageIcon size={20} />
          <span>{t('home.cards.importPreview')}</span>
        </div>
        <div className="readiness-card">
          <Eye size={20} />
          <span>{t('home.cards.risk')}</span>
        </div>
        <div className="readiness-card">
          <Aperture size={20} />
          <span>{t('home.cards.grouping')}</span>
        </div>
        <div className="readiness-card">
          <Sparkles size={20} />
          <span>{t('home.cards.xiaogong')}</span>
        </div>
      </section>
    </div>
  );
}

function ImportOverlay({ progress, t }: { progress: ImportProgress; t: Translator }): React.ReactElement {
  const hasTotal = typeof progress.total === 'number' && progress.total > 0;
  const value = hasTotal ? Math.min(100, Math.round(((progress.current || 0) / progress.total!) * 100)) : undefined;
  const stageLabel: Record<ImportProgress['stage'], string> = {
    extracting: t('import.stageExtracting'),
    scanning: t('import.stageScanning'),
    analyzing: t('import.stageAnalyzing'),
    clustering: t('import.stageClustering'),
    done: t('import.stageDone'),
    error: t('import.stageError')
  };
  return (
    <div className="import-overlay" role="status" aria-live="polite">
      <div className="import-progress-card">
        <div className="import-progress-head">
          <Loader2 className="spin" size={20} />
          <span>{stageLabel[progress.stage]}</span>
        </div>
        <strong>{progress.message}</strong>
        <div className="progress-track">
          <i style={{ width: hasTotal ? `${value}%` : '38%' }} />
        </div>
        <small>{hasTotal ? `${progress.current || 0} / ${progress.total} · ${value}%` : t('import.waiting')}</small>
      </div>
    </div>
  );
}

function PhotoPanel({
  photo,
  onDecide,
  onApplyBrainSuggestion,
  onRejectBrainSuggestion,
  t
}: {
  photo?: PhotoView;
  onDecide: (decision: Decision, rating?: number) => void;
  onApplyBrainSuggestion: (review: BrainPhotoReview) => void;
  onRejectBrainSuggestion: (review: BrainPhotoReview) => void;
  t: Translator;
}): React.ReactElement {
  if (!photo) return <div className="panel empty-panel">{t('photo.noPhotos')}</div>;
  const eyeStateLabel = eyeStateText(photo.analysis?.eyeState, t);
  return (
    <div className="panel">
      <div className="photo-title">
        <div>
          <h2>{photo.fileName}</h2>
          <p>{photo.cameraModel || t('photo.unknownCamera')} · ISO {photo.iso || '-'} · f/{photo.aperture || '-'}</p>
        </div>
        <span className={`decision ${photo.decision}`}>{decisionLabel(photo.decision, t)}</span>
      </div>

      <div className="decision-dock">
        <div className="actions">
          <button className={photo.decision === 'pick' ? 'selected pick-action' : 'pick-action'} onClick={() => onDecide('pick')} title={t('actions.keep')}><Check size={16} /><span>{t('actions.keep')}</span></button>
          <button className={photo.decision === 'maybe' ? 'selected maybe-action' : 'maybe-action'} onClick={() => onDecide('maybe')} title={t('actions.maybe')}><Eye size={16} /><span>{t('actions.maybe')}</span></button>
          <button className={photo.decision === 'reject' ? 'selected reject-action' : 'reject-action'} onClick={() => onDecide('reject')} title={t('actions.reject')}><X size={16} /><span>{t('actions.reject')}</span></button>
        </div>

        <div className="rating-row" aria-label={t('photo.rating')}>
          {[1, 2, 3, 4, 5].map((star) => (
            <button key={star} onClick={() => onDecide('pick', star)} className={photo.rating && photo.rating >= star ? 'lit' : ''}><Star size={16} /></button>
          ))}
        </div>
      </div>

      <div className="score-grid">
        <Score label={t('photo.scoreSharp')} value={photo.analysis?.sharpnessScore} />
        <Score label={t('photo.scoreExposure')} value={photo.analysis?.exposureScore} />
        <Score label={t('photo.scoreFace')} value={photo.analysis?.faceScore} />
        <Score label={t('photo.scoreEye')} value={photo.analysis?.eyeConfidence} display={eyeStateLabel} />
      </div>

      <div className="risk-row">
        {(photo.analysis?.riskFlags || []).length ? photo.analysis?.riskFlags.map((flag) => <span key={flag}>{riskLabel(flag, t)}</span>) : <span>{t('risk.none')}</span>}
      </div>

      <BrainReviewPanel
        review={photo.brainReview}
        photoDecision={photo.decision}
        onApply={onApplyBrainSuggestion}
        onReject={onRejectBrainSuggestion}
        t={t}
      />
    </div>
  );
}

function XiaogongConsole({
  busy,
  input,
  activity,
  result,
  activeSmartView,
  activeItem,
  onInput,
  onRun,
  t
}: {
  busy: string;
  input: string;
  activity: BrainUiLogEvent[];
  result: XiaogongRunResult | null;
  activeSmartView: SmartView | null;
  activeItem?: SmartView['items'][number];
  onInput: (value: string) => void;
  onRun: (message?: string) => void;
  t: Translator;
}): React.ReactElement {
  const quickTasks = [t('xiaogong.quickBest'), t('xiaogong.quickCover'), t('xiaogong.quickEyes'), t('xiaogong.quickGroup')];
  return (
    <section className="xiaogong-console">
      <div className="xiaogong-head">
        <span><Brain size={15} /> {t('xiaogong.name')}</span>
        <em>{busy ? t('xiaogong.running') : activeSmartView ? t('xiaogong.viewControl') : t('xiaogong.idle')}</em>
      </div>

      <div className="xiaogong-input-row">
        <input
          value={input}
          placeholder={t('xiaogong.placeholder')}
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onRun();
            }
          }}
          disabled={Boolean(busy)}
        />
        <button onClick={() => onRun()} disabled={Boolean(busy || !input.trim())} title={t('actions.send')}>
          {busy ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
        </button>
      </div>

      <div className="xiaogong-chips">
        {quickTasks.map((task) => (
          <button key={task} onClick={() => onRun(task)} disabled={Boolean(busy)}>{task}</button>
        ))}
      </div>

      <XiaogongLogTimeline activity={activity} active={Boolean(busy)} t={t} />

      {result?.confirmation && (
        <div className="xiaogong-confirmation">
          <strong>{result.confirmation.title}</strong>
          <p>{result.confirmation.message}</p>
          <span>{result.confirmation.permissionLevel}</span>
          <div>
            <button type="button" disabled>{t('xiaogong.confirmationTodo')}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function XiaogongLogTimeline({ activity, active, t }: { activity: BrainUiLogEvent[]; active: boolean; t: Translator }): React.ReactElement | null {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [followTail, setFollowTail] = useState(true);
  const hasActivity = activity.length > 0;

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node || !followTail) return;
    node.scrollTop = node.scrollHeight;
  }, [activity, followTail]);

  if (!hasActivity && !active) return null;

  return (
    <div className="xiaogong-log">
      <div className="xiaogong-log-head">
        <span>{t('xiaogong.logs')}</span>
        <em>{active ? t('xiaogong.running') : hasActivity ? t('xiaogong.recorded') : t('xiaogong.waitingEvent')}</em>
      </div>
      <div
        className="xiaogong-log-list"
        ref={scrollerRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 20;
          setFollowTail(nearBottom);
        }}
      >
        {activity.map((item) => (
          <button
            key={item.id}
            className={`xiaogong-log-item ${item.level}`}
            type="button"
            title={item.photoFileName || xiaogongDisplayTitle(item, t)}
          >
            <span>{xiaogongPhaseLabel(item.phase, t)}</span>
            <div>
              <strong>{xiaogongDisplayTitle(item, t)}</strong>
              {item.message && <p>{item.message}</p>}
              {item.progress && item.progress.total > 0 && <em>{item.progress.current}/{item.progress.total}</em>}
            </div>
          </button>
        ))}
      </div>
      {!followTail && (
        <button
          className="xiaogong-log-new"
          type="button"
          onClick={() => {
            setFollowTail(true);
            requestAnimationFrame(() => {
              const node = scrollerRef.current;
              if (node) node.scrollTop = node.scrollHeight;
            });
          }}
        >
          {t('xiaogong.newProgress')}
        </button>
      )}
    </div>
  );
}

function xiaogongToolTitle(toolName: string | undefined, t: Translator): string | undefined {
  if (!toolName) return undefined;
  const title = t(`toolTitles.${toolName}`);
  return title === `toolTitles.${toolName}` ? undefined : title;
}

function xiaogongDisplayTitle(item: BrainUiLogEvent, t: Translator): string {
  const toolTitle = xiaogongToolTitle(item.toolName, t);
  if (!toolTitle) return item.title;
  if (item.title.startsWith('工具失败')) return t('phases.failed') === '错误' ? `${toolTitle}失败` : `${toolTitle} failed`;
  if (item.title.startsWith('需要确认')) return t('phases.confirmation') === '确认' ? `需要确认：${toolTitle}` : `Confirm: ${toolTitle}`;
  if (item.title.startsWith('调用工具')) return toolTitle;
  return item.title.includes(item.toolName || '') ? item.title.replace(item.toolName || '', toolTitle).replace('调用工具：', '') : item.title;
}

function xiaogongPhaseLabel(phase: BrainUiLogEvent['phase'], t: Translator): string {
  return t(`phases.${phase}`);
}

function BrainActivityPanel({
  progress,
  activity,
  active,
  lastRun,
  t
}: {
  progress: BrainProgressEvent | null;
  activity: BrainProgressEvent[];
  active: boolean;
  lastRun: BrainRunResult | null;
  t: Translator;
}): React.ReactElement | null {
  if (!active && !progress && !lastRun) return null;
  const status = progress?.status || lastRun?.status || 'running';
  const total = !active && lastRun ? lastRun.reviewed : progress?.total || lastRun?.reviewed || 0;
  const current = !active && lastRun ? lastRun.reviewed : progress?.current ?? lastRun?.reviewed ?? 0;
  const pctValue = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const recentActivity = (activity.length ? activity : progress ? [progress] : []).slice(0, 3);
  const statusLabel = active ? t('brain.reviewing') : status === 'completed' ? t('brain.lastReview') : status === 'failed' ? t('brain.failed') : t('brain.status');
  const statusMeta = total
    ? `${current}/${total}`
    : status === 'completed'
      ? t('brain.completed')
      : status === 'failed'
        ? t('brain.failedMeta')
        : active
          ? t('brain.running')
          : t('brain.pending');

  return (
    <section className={`brain-activity-panel ${status}`}>
      <div className="brain-activity-head">
        <span>{active ? <Loader2 className="spin" size={15} /> : <Brain size={15} />} {statusLabel}</span>
        <em>{statusMeta}</em>
      </div>
      <div className="brain-activity-track">
        <i style={{ width: `${pctValue}%` }} />
      </div>
      <strong>{productReviewText(progress?.message || lastRun?.message || t('brain.defaultMessage'), t)}</strong>
      {active && recentActivity.length > 0 && (
        <div className="brain-activity-list">
          {recentActivity.map((item, index) => (
            <div key={`${item.phase}-${item.photoId || item.runId}-${index}`}>
              <span>{activityLabel(item.phase, t)}</span>
              <p>{productReviewText(item.message, t)}</p>
            </div>
          ))}
        </div>
      )}
      {status === 'failed' && (progress?.debugLogPath || lastRun?.debugLogPath) && (
        <small>{t('brain.log', { path: progress?.debugLogPath || lastRun?.debugLogPath })}</small>
      )}
    </section>
  );
}

function activityLabel(phase: BrainProgressEvent['phase'], t: Translator): string {
  const labels: Record<BrainProgressEvent['phase'], string> = {
    started: t('phases.understanding'),
    context: t('phases.workspace'),
    planning: t('phases.planning'),
    photo_started: t('phases.vision'),
    photo_completed: t('phases.done'),
    group_started: t('phases.compare'),
    group_completed: t('phases.compare'),
    reducing: t('phases.planning'),
    persisting: t('phases.write'),
    completed: t('phases.done'),
    failed: t('phases.failed')
  };
  return labels[phase];
}

function bucketText(bucket: string | undefined, t: Translator): string {
  const label = t(`buckets.${bucket || 'unknown'}`);
  return label === `buckets.${bucket || 'unknown'}` ? t('buckets.unknown') : label;
}

function actionText(action: string | undefined, t: Translator): string {
  const label = t(`actionText.${action || 'fallback'}`);
  return label === `actionText.${action || 'fallback'}` ? t('actionText.fallback') : label;
}

function productReviewText(value: string | undefined, t: Translator): string {
  if (!value) return '';
  return value
    .replace(/\bcell\s*#?\s*\d+\b/gi, t('productText.nearby'))
    .replace(/\bfeatured\b/gi, t('productText.featured'))
    .replace(/\bkeeper(s)?\b/gi, t('productText.keeper'))
    .replace(/\bmaybe\b/gi, t('productText.maybe'))
    .replace(/\breject\b/gi, t('productText.reject'))
    .replace(/\bpick\b/gi, t('productText.pick'))
    .replace(/\bprimaryBucket\b/g, t('productText.primaryBucket'))
    .replace(/\bsecondaryBuckets\b/g, t('productText.secondaryBuckets'))
    .replace(/\brecommendedAction\b/g, t('productText.recommendedAction'))
    .replace(/\bneedsHumanReview\b/g, t('productText.needsHumanReview'))
    .replace(/\bsimilarBursts\b/g, t('productText.similarBursts'))
    .replace(/\bclosedEyes\b/g, t('productText.closedEyes'))
    .replace(/\beyeReview\b/g, t('productText.eyeReview'))
    .replace(/\bface[_ ]?blur\b/gi, t('productText.faceBlur'))
    .replace(/\bface[_ ]?missing\b/gi, t('productText.faceMissing'))
    .replace(/\blocal\b/gi, t('productText.local'))
    .replace(/\s+/g, ' ')
    .trim();
}

function smallModelOverrideText(value: string, t: Translator): string {
  const text = value.trim();
  const lower = text.toLowerCase();
  const mappings: Array<[RegExp, string]> = [
    [/local[_ ]?score|final[_ ]?score|score.*overstates|overestimate|overstates|overstated|does not reflect|偏高|高分.*下调/i, t('override.scoreHigh')],
    [/^score$|score/i, t('override.scoreReview')],
    [/exposure[_ ]?score|exposure/i, t('override.exposureReview')],
    [/face[_ ]?score/i, t('override.faceReview')],
    [/featured value|cover-level|not featured|featured/i, t('override.notFeatured')],
    [/background clutter|busy background|background.*clutter/i, t('override.background')],
    [/average lighting|harsh backlight|backlight|lighting/i, t('override.lighting')],
    [/deliverablescore|deliverable score/i, t('override.deliverable')],
    [/face_blur|face blur|missed_focus|focus/i, t('override.faceBlur')],
    [/eyes_uncertain|eye/i, t('override.eyes')],
    [/face_missing|back view/i, t('override.subject')],
    [/snapshot|low finish|finish/i, t('override.finish')],
    [/crop|cropped/i, t('override.crop')]
  ];
  const hit = mappings.find(([pattern]) => pattern.test(lower));
  if (hit) return hit[1];
  if (lower === '[object object]' || lower.includes('[object object]')) return t('override.structured');
  const asciiChars = text.match(/[a-z0-9_()[\].:-]/gi)?.length || 0;
  const visibleChars = text.replace(/\s/g, '').length || 1;
  if (asciiChars / visibleChars > 0.6) return t('override.fallback');
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
}

function smallModelOverrideTitle(value: string, t: Translator): string {
  const display = smallModelOverrideText(value, t);
  const text = value.trim();
  const asciiChars = text.match(/[a-z0-9_()[\].:-]/gi)?.length || 0;
  const visibleChars = text.replace(/\s/g, '').length || 1;
  return asciiChars / visibleChars > 0.6 ? display : text;
}

function scorePct(value?: number): string {
  return `${Math.round((value || 0) * 100)}`;
}

function reviewCurationScore(review: BrainPhotoReview): number {
  const scores = review.visualScores;
  return (
    (scores.visualQuality || 0) * 0.18
    + (scores.expression || 0) * 0.18
    + (scores.moment || 0) * 0.18
    + (scores.composition || 0) * 0.16
    + (scores.backgroundCleanliness || 0) * 0.14
    + (scores.storyValue || 0) * 0.16
  );
}

function BrainReviewPanel({
  review,
  photoDecision,
  onApply,
  onReject,
  t
}: {
  review?: BrainPhotoReview;
  photoDecision: Decision;
  onApply: (review: BrainPhotoReview) => void;
  onReject: (review: BrainPhotoReview, note?: string) => void;
  t: Translator;
}): React.ReactElement {
  const [rejecting, setRejecting] = React.useState(false);
  const [rejectNote, setRejectNote] = React.useState('');

  if (!review) {
    return (
      <section className="brain-review-panel empty-brain-review">
        <div className="brain-review-head">
          <span><Brain size={15} /> {t('xiaogong.judgment')}</span>
          <em>{t('xiaogong.noReviewYet')}</em>
        </div>
        <p>{t('xiaogong.emptyReview')}</p>
      </section>
    );
  }

  const scores = [
    [t('reviewScores.visual'), review.visualScores.visualQuality],
    [t('reviewScores.expression'), review.visualScores.expression],
    [t('reviewScores.moment'), review.visualScores.moment],
    [t('reviewScores.composition'), review.visualScores.composition],
    [t('reviewScores.background'), review.visualScores.backgroundCleanliness],
    [t('reviewScores.story'), review.visualScores.storyValue]
  ] as const;
  const recommendedDecision: Decision | undefined =
    review.recommendedAction === 'pick' || review.recommendedAction === 'reject' || review.recommendedAction === 'maybe'
      ? review.recommendedAction
      : undefined;
  const accepted = Boolean(recommendedDecision && photoDecision === recommendedDecision);
  const decisionText = recommendedDecision ? decisionLabel(recommendedDecision, t) : '';
  const deliverableScore = review.visualScores.deliverableScore;
  const curationScore = reviewCurationScore(review);
  const reasonText = productReviewText(review.reason, t);
  const groupReasonText = productReviewText(review.groupReason, t);

  return (
    <section className="brain-review-panel">
      <div className="brain-review-head">
        <span><Brain size={15} /> {t('xiaogong.judgment')}</span>
        <em title={t('xiaogong.confidenceTitle')}>{t('xiaogong.confidence', { value: scorePct(review.confidence) })}</em>
      </div>
      <div className="brain-score-summary">
        <div title={t('xiaogong.deliveryTitle')}>
          <span>{t('xiaogong.deliveryScore')}</span>
          <strong>{scorePct(deliverableScore)}</strong>
        </div>
        <div title={t('xiaogong.referenceTitle')}>
          <span>{t('xiaogong.referenceScore')}</span>
          <strong>{scorePct(curationScore)}</strong>
        </div>
      </div>
      <div className="brain-bucket-line">
        <strong>{bucketText(review.primaryBucket, t)}</strong>
        <span className={`brain-action-chip ${accepted ? 'accepted' : review.recommendedAction || 'review'}`}>
          {accepted ? t('xiaogong.accepted', { decision: decisionText }) : actionText(review.recommendedAction, t)}
        </span>
      </div>
      <p className="brain-reason" title={reasonText}>{reasonText}</p>
      {review.smallModelOverrides.length > 0 && (
        <div className="brain-overrides">
          <strong>{t('xiaogong.correction')}</strong>
          {review.smallModelOverrides.map((item) => <span key={item} title={smallModelOverrideTitle(item, t)}>{smallModelOverrideText(item, t)}</span>)}
        </div>
      )}
      {review.needsHumanReview && <div className="brain-review-alert">{t('xiaogong.humanReview')}</div>}
      <div className="brain-score-grid">
        {scores.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{scorePct(value)}</strong>
          </div>
        ))}
      </div>
      {groupReasonText && <p className="brain-group-reason" title={groupReasonText}>{groupReasonText}</p>}
      <div className="brain-review-actions">
        {accepted ? (
          <div className="brain-review-accepted"><Check size={14} /> {t('xiaogong.updated')}</div>
        ) : (
          rejecting ? (
            <div className="brain-reject-box">
              <textarea
                value={rejectNote}
                onChange={(event) => setRejectNote(event.target.value)}
                placeholder={t('xiaogong.rejectPlaceholder')}
                rows={3}
              />
              <div className="brain-reject-actions">
                <button onClick={() => { onReject(review, rejectNote); setRejecting(false); setRejectNote(''); }}>
                  <X size={14} /> {t('actions.confirmReject')}
                </button>
                <button onClick={() => { setRejecting(false); setRejectNote(''); }}>
                  {t('actions.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button onClick={() => onApply(review)} disabled={review.recommendedAction === 'none'}>
                <Check size={14} /> {t('actions.accept')}
              </button>
              <button onClick={() => setRejecting(true)}>
                <X size={14} /> {t('actions.rejectSuggestion')}
              </button>
            </>
          )
        )}
      </div>
    </section>
  );
}

function eyeStateText(state: string | undefined, t: Translator): string {
  const label = t(`eyeState.${state || 'unknown'}`);
  return label === `eyeState.${state || 'unknown'}` ? t('eyeState.unknown') : label;
}

function Score({ label, value, display }: { label: string; value?: number; display?: string }): React.ReactElement {
  return (
    <div className="score">
      <span>{label}</span>
      <strong>{display || pct(value)}</strong>
      <i style={{ width: `${pct(value)}%` }} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
