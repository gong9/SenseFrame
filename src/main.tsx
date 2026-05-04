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
import './styles.css';

type ViewMode = 'featured' | 'keepers' | 'lowPriority' | 'reviewQueue' | 'closedEyes' | 'eyeReview' | 'subject' | 'technical' | 'duplicates' | 'similarBursts' | 'pending' | 'search' | 'smartView';

function pct(value?: number): string {
  return `${Math.round((value || 0) * 100)}`;
}

function decisionLabel(decision: Decision): string {
  const labels: Record<Decision, string> = {
    none: '未标记',
    pick: '已保留',
    reject: '已淘汰',
    maybe: '待复核'
  };
  return labels[decision];
}

function riskLabel(flag: string): string {
  const labels: Record<string, string> = {
    possible_blur: '疑似模糊',
    bad_exposure: '曝光异常',
    closed_eyes: '疑似闭眼',
    eyes_uncertain: '眼部不确定',
    face_blur: '人脸不够清晰',
    face_missing: '未检测到人脸（信息）',
    subject_cropped: '主体被裁切',
    weak_subject: '主体不明确',
    unsupported_preview: '预览不可用',
    raw_decode_failed: 'RAW 解析失败',
    heic_decode_failed: 'HEIC 解析失败'
  };
  return labels[flag] || flag;
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
  const [modelSettings, setModelSettings] = useState<ModelSettings>({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', apiKey: '' });
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
      setNotice(next.apiKey ? '模型设置已保存，小宫会使用新的模型配置。' : '模型设置已保存，但 API Key 为空。');
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
    const confirmed = window.confirm(
      `删除批次「${name}」并删除本地原片？\n\n这会删除 SenseFrame 记录、分析结果、预览缓存，以及这个批次里登记的本地照片文件。原片删除后不能从 SenseFrame 恢复。`
    );
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
        ? `批次已删除，原片删除 ${result.deletedOriginals} 张，失败 ${result.failedOriginals} 张。`
        : `批次已删除，原片删除 ${result.deletedOriginals} 张。`
    );
  }

  async function rebuildCurrentClusters(): Promise<void> {
    if (!batch || !window.senseframe) return;
    setBusy('正在按近重复规则重建分组...');
    try {
      const next = await window.senseframe.rebuildClusters(batch.id);
      setBatch(next);
      setMode('duplicates');
      setPhotoIndex(0);
      setNotice('近重复分组已重建。');
    } finally {
      setBusy('');
    }
  }

  async function reanalyzeCurrentBatch(): Promise<void> {
    if (!batch || !window.senseframe) return;
    setBusy('正在用原图重跑人脸与眼部分析...');
    try {
      const next = await window.senseframe.reanalyzeBatch(batch.id);
      setBatch(next);
      setPhotoIndex(0);
      setNotice('已用原图重跑人脸与眼部分析。');
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
      setBusy(progress.total ? `${progress.message} ${progress.current || 0}/${progress.total}` : progress.message);
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
  }, []);

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
        label: '精选候选',
        description: hasBrainCuration ? '大脑最终优先看的照片' : '每段优先看的照片',
        count: featuredIds.size,
        icon: <Sparkles size={16} />
      },
      {
        id: 'keepers',
        label: '建议保留',
        description: hasBrainCuration ? '质量过线、无需复核的 keeper' : '运行小宫审片后生成',
        count: hasBrainCuration ? brainBucketCount('keepers') : 0,
        icon: <Check size={16} />
      },
      {
        id: 'lowPriority',
        label: '低优先级备选',
        description: hasBrainCuration ? '有保留价值但不强' : '运行小宫审片后生成',
        count: hasBrainCuration ? brainBucketCount('lowPriority') : 0,
        icon: <Star size={16} />
      },
      {
        id: 'reviewQueue',
        label: '人工复核',
        description: hasBrainCuration ? '眼神、焦点或语义需确认' : '运行小宫审片后生成',
        count: hasBrainCuration ? brainBucketCount('reviewQueue') : 0,
        icon: <Brain size={16} />
      },
      {
        id: 'closedEyes',
        label: '疑似闭眼',
        description: hasBrainCuration ? '大脑确认更像失败闭眼' : '双眼高置信闭合',
        count: hasBrainCuration ? brainBucketCount('closedEyes') : batch.photos.filter((photo) => hasAnyFlag(photo, closedEyeFlags)).length,
        icon: <Eye size={16} />
      },
      {
        id: 'eyeReview',
        label: '眼部复核',
        description: hasBrainCuration ? '大脑认为需要人工看眼部' : '侧脸、远景或遮挡',
        count: hasBrainCuration ? brainBucketCount('eyeReview') : batch.photos.filter((photo) => hasAnyFlag(photo, eyeReviewFlags)).length,
        icon: <Eye size={16} />
      },
      {
        id: 'subject',
        label: '主体问题',
        description: hasBrainCuration ? '大脑确认主体/构图风险' : '裁切或主体弱',
        count: hasBrainCuration ? brainBucketCount('subject') : batch.photos.filter((photo) => hasAnyFlag(photo, subjectFlags)).length,
        icon: <ImageIcon size={16} />
      },
      {
        id: 'technical',
        label: '技术问题',
        description: hasBrainCuration ? '大脑确认技术风险' : '模糊、曝光、解析失败',
        count: hasBrainCuration ? brainBucketCount('technical') : batch.photos.filter((photo) => hasAnyFlag(photo, technicalFlags) || photo.status !== 'ready').length,
        icon: <TriangleAlert size={16} />
      },
      {
        id: 'duplicates',
        label: '近重复',
        description: hasBrainCuration ? '大脑组内排序后的近重复' : '构图几乎一致的照片',
        count: hasBrainCuration ? brainBucketCount('duplicates') : duplicateIds.size,
        icon: <Layers size={16} />
      },
      {
        id: 'similarBursts',
        label: '相似连拍',
        description: '同一动作段的照片',
        count: hasBrainCuration ? brainBucketCount('similarBursts') : burstMeta.size,
        icon: <Layers size={16} />
      },
      {
        id: 'pending',
        label: '待判断',
        description: hasBrainCuration ? '大脑明确留给人工判断' : 'AI 不确定，建议人工看',
        count: hasBrainCuration ? brainBucketCount('pending') : batch.photos.filter((photo) => {
          const flags = photo.analysis?.riskFlags || [];
          return photo.analysis?.eyeState === 'uncertain' || photo.analysis?.faceVisibility === 'unknown' || (flags.length > 0 && !featuredIds.has(photo.id));
        }).length,
        icon: <Brain size={16} />
      }
    ];
    return buckets;
  }, [batch, duplicateIds, burstMeta, featuredIds, hasBrainCuration]);
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
      setNotice('当前是浏览器预览页面。请使用 Electron 弹出的 SenseFrame 桌面窗口导入素材。');
      return;
    }
    setImportProgress({
      stage: kind === 'archive' ? 'extracting' : 'scanning',
      message: kind === 'archive' ? '正在打开 RAR 选择框...' : '正在打开文件夹选择框...'
    });
    const source = kind === 'archive' ? await window.senseframe.chooseArchive() : await window.senseframe.chooseFolder();
    if (!source) {
      setNotice('已取消选择。');
      setImportProgress(null);
      return;
    }
    setBusy(source.toLowerCase().endsWith('.rar') ? '正在解压 RAR 并分析照片...' : '正在导入与分析照片，RAW/HEIC 和人脸检测会调用 Python worker...');
    setImportProgress({
      stage: source.toLowerCase().endsWith('.rar') ? 'extracting' : 'scanning',
      message: source.toLowerCase().endsWith('.rar') ? '正在解压 RAR 并准备分析...' : '正在扫描照片...'
    });
    try {
      const result = await window.senseframe.importSource(source);
      await refreshBatches();
      await loadBatch(result.batchId);
      setNotice(`${result.sourceType === 'archive' ? 'RAR 解压并导入完成' : '导入完成'}：${result.imported} 张，预览失败/受限 ${result.unsupported} 张`);
    } catch (error) {
      const hint = await window.senseframe.workerHint();
      setNotice(`${error instanceof Error ? error.message : String(error)}。${hint}`);
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
    setBusy('正在生成语义标签与推荐解释...');
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
    setBusy('正在语义搜索...');
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
    setNotice(`已导出：${path}`);
  }

  async function exportSelected(): Promise<void> {
    if (!batch) return;
    if (!window.senseframe) return;
    if (!stats.picked) {
      setNotice('还没有标记为“保留”的照片。');
      return;
    }

    const result = await window.senseframe.exportSelected(batch.id);
    if (result) setNotice(`已导出 ${result.count} 张已选照片：${result.dir}`);
  }

  async function runBrainReview(): Promise<void> {
    if (!batch || !window.senseframe || !batch.photos.length) return;
    setBrainBusy(`小宫正在接管整批审片 · ${batch.photos.length} 张...`);
    setBrainProgress(null);
    setBrainActivity([]);
    setLastBrainRun(null);
    try {
      const result = await window.senseframe.startBrainReview({
        batchId: batch.id,
        scope: 'batch',
        focusMode: mode,
        activePhotoId: activePhoto?.id
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
      setNotice(result.status === 'completed' ? result.uiPatch?.notice || result.message : `小宫审片失败：${result.message}`);
    } catch (error) {
      setNotice(`小宫审片失败：${error instanceof Error ? error.message : String(error)}`);
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
    setXiaogongBusy('正在交给小宫...');
    setXiaogongProgress(null);
    setXiaogongActivity([]);
    setLastXiaogongResult(null);
    try {
      const result = await window.senseframe.runXiaogong({
        batchId: batch.id,
        message: message.trim(),
        currentMode: mode,
        activePhotoId: activePhoto?.id,
        smartViewId: activeSmartView?.id
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
      setNotice(`小宫任务失败：${error instanceof Error ? error.message : String(error)}`);
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
      setNotice('已按大脑建议更新标记。');
      return;
    }
    await window.senseframe.recordBrainFeedback({ photoId: activePhoto.id, runId: review.runId, action: 'reviewed', note: 'no direct decision' });
    setNotice('已记录大脑建议为人工复核。');
  }

  async function rejectBrainSuggestion(review: BrainPhotoReview, note?: string): Promise<void> {
    if (!activePhoto || !window.senseframe) return;
    await window.senseframe.recordBrainFeedback({ photoId: activePhoto.id, runId: review.runId, action: 'rejected', note: note?.trim() || undefined });
    setNotice(note?.trim() ? '已记录不采纳和理由。' : '已记录不采纳这条大脑评价。');
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
            <FolderOpen size={16} /> 导入
          </button>
          <button className="secondary-action" onClick={() => importSource('archive')} disabled={Boolean(importProgress)}>RAR</button>
        </div>

        {batch && (
          <div className="stats">
            <Metric label="总数" value={batch.photos.length} />
            <Metric label="精选" value={stats.candidates} />
            <Metric label="复核" value={stats.review} />
            <Metric label="已选" value={stats.picked} />
            <button className="mini-tool" onClick={rebuildCurrentClusters}>重建近重复</button>
            <button className="mini-tool" onClick={reanalyzeCurrentBatch}>重跑分析</button>
          </div>
        )}

        <div className="batch-list">
          <div className="section-label">批次</div>
          {batches.map((item, index) => (
            <div key={item.id} className={`batch-item ${batch?.id === item.id ? 'active' : ''}`}>
              <button className="batch-open" onClick={() => loadBatch(item.id)}>
                <span>批次 {String(index + 1).padStart(2, '0')}</span>
                <small>{item.name}</small>
              </button>
              <span className="batch-count">{item.totalPhotos}</span>
              <button
                className="batch-delete"
                title="删除批次"
                aria-label={`删除批次 ${item.name}`}
                onClick={() => removeBatch(item.id, item.name)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>

        {batch && (
          <div className="ai-buckets">
            <div className="section-label">AI 分组</div>
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
            <div className="section-label">小宫视图</div>
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
              <button className="home-command" onClick={goHome} title="返回首页" aria-label="返回首页">
                <Home size={15} />
                <span>首页</span>
              </button>
            )}
            <div>
              <h1>{batch ? `${mode === 'smartView' ? activeSmartView?.name || '小宫视图' : activeBucket?.label || '语义搜索'} · ${visiblePhotos.length}` : '选择一个拍摄批次开始'}</h1>
              <p>{batch ? (mode === 'smartView' && activeSmartView ? activeSmartView.summary : `${batch.name} · ${batch.clusters.length} 个相似组 · ${stats.rejected} 张淘汰建议已确认`) : '导入后会自动生成缩略图、RAW 预览、质量分、人脸闭眼检测和相似组。'}</p>
            </div>
          </div>
          <div className="toolbar">
            {batch && (
              <>
              <button className="brain-action" onClick={runBrainReview} disabled={Boolean(brainBusy || busy)} title="小宫审片">
                {brainBusy ? <Loader2 className="spin" size={16} /> : <Brain size={16} />} 小宫
              </button>
              <button onClick={exportSelected} title="导出已选"><Download size={16} /> 导出</button>
              <button
                className={!modelSettings.apiKey ? 'needs-settings' : ''}
                onClick={() => {
                  setSettingsDraft(modelSettings);
                  setSettingsOpen(true);
                }}
                title="模型设置"
              >
                <Settings size={16} /> 设置
              </button>
              </>
            )}
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
                    <span>{mode === 'smartView' ? activeSmartView?.name || '小宫视图' : activeBucket?.label || '审片'}</span>
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
                  <div className="missing-preview"><Layers size={46} />当前分组没有照片</div>
                ) : (
                  <div className="missing-preview"><ImageIcon size={46} />预览不可用</div>
                )}
                {activePhoto?.previewPath && (
                  <div className="zoom-controls" aria-label="图片缩放" onPointerDown={(event) => event.stopPropagation()}>
                    <button title="缩小" onClick={() => setZoom(imageZoom - 0.25)}>
                      <ZoomOut size={16} />
                    </button>
                    <button className={isFitZoom ? 'selected' : ''} onClick={() => { setImageZoom(1); setImagePan({ x: 0, y: 0 }); }}>适屏</button>
                    <button className="zoom-value">{Math.round(imageZoom * 100)}%</button>
                    <button title="放大" onClick={() => setZoom(imageZoom + 0.25)}>
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
                          ? `近重复 G${meta.clusterNumber} · 第 ${meta.rank}/${meta.clusterSize} · 相似 ${pct(meta.similarityToBest)}`
                          : burst
                            ? `相似连拍 B${burst.burstNumber} ${burst.label} · 第 ${burst.rank}/${burst.burstSize}`
                            : photo.fileName
                      }
                      onClick={() => setPhotoIndex(index)}
                    >
                      {photo.thumbPath ? <img src={window.senseframe?.fileUrl(photo.thumbPath)} alt="" /> : <ImageIcon size={20} />}
                      {meta && <span className="cluster-badge">G{meta.clusterNumber}</span>}
                      {!meta && burst && <span className="cluster-badge burst">B{burst.burstNumber}</span>}
                      {meta && <span className="rank-badge">{meta.rank}/{meta.clusterSize}</span>}
                      {!meta && burst && <span className="rank-badge">{burst.rank}/{burst.burstSize}</span>}
                      {featured && <span className="badge">精选</span>}
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
                  <span>第 {activeClusterMeta.rank}/{activeClusterMeta.clusterSize} · 相似 {pct(activeClusterMeta.similarityToBest)} · {activeClusterMeta.recommended ? '组内推荐' : '备选'}</span>
                </div>
              )}
              {activeBurstMeta && !activeClusterMeta && (
                <div className="cluster-note">
                  <strong>相似连拍 B{activeBurstMeta.burstNumber}</strong>
                  <span>{activeBurstMeta.label} · 第 {activeBurstMeta.rank}/{activeBurstMeta.burstSize}</span>
                </div>
              )}
              <BrainActivityPanel
                progress={brainProgress}
                activity={brainActivity}
                active={Boolean(brainBusy)}
                lastRun={lastBrainRun}
              />
              <PhotoPanel
                photo={activePhoto}
                onDecide={decide}
                onApplyBrainSuggestion={applyBrainSuggestion}
                onRejectBrainSuggestion={rejectBrainSuggestion}
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
              />
            </aside>
          </div>
        )}

        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>
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
          />
        )}
        {importProgress && <ImportOverlay progress={importProgress} />}
      </section>
    </main>
  );
}

function ModelSettingsDialog({
  value,
  saving,
  onChange,
  onCancel,
  onSave
}: {
  value: ModelSettings;
  saving: boolean;
  onChange: (value: ModelSettings) => void;
  onCancel: () => void;
  onSave: () => void;
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
              <h2 id="model-settings-title">模型设置</h2>
              <p>小宫大脑连接</p>
            </div>
          </div>
          <button type="button" onClick={onCancel} aria-label="关闭设置">
            <X size={16} />
          </button>
        </div>

        <div className={`settings-status ${configured ? 'ready' : 'empty'}`}>
          <div>
            <strong>{configured ? '已配置 API Key' : '等待配置 API Key'}</strong>
            <span>{configured ? `${value.model || '未选择模型'} · ${value.baseUrl || '未设置地址'}` : '保存后，小宫审片和语义分析会使用这里的模型服务。'}</span>
          </div>
          <em>{configured ? 'Ready' : 'Setup'}</em>
        </div>

        <div className="settings-fields">
          <label className="settings-field">
            <span><Server size={14} /> 服务地址</span>
            <div>
              <input
                value={value.baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
              />
            </div>
          </label>

          <label className="settings-field">
            <span><SlidersHorizontal size={14} /> 模型</span>
            <div>
              <input
                value={value.model}
                placeholder="gpt-5.5"
                onChange={(event) => onChange({ ...value, model: event.target.value })}
              />
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
          <button type="button" onClick={onCancel}>取消</button>
          <button type="button" className="primary" onClick={onSave} disabled={!canSave || saving}>
            {saving ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
            保存
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
  disabled
}: {
  batches: Array<{ id: string; name: string; status: string; totalPhotos: number; createdAt: string }>;
  onImportFolder: () => void;
  onImportArchive: () => void;
  onOpenBatch: (batchId: string) => void | Promise<void>;
  onRemoveBatch: (batchId: string, name: string) => void | Promise<void>;
  disabled: boolean;
}): React.ReactElement {
  return (
    <div className="empty studio-empty">
      <section className="studio-hero">
        <div className="hero-copy">
          <span className="frame-kicker">光影入席，取舍有据</span>
          <h2>拣尽寒枝，留住一瞬光</h2>
          <p>SenseFrame 先用本机分析把整批照片按重复、眼神、主体和技术风险分层，再由小宫理解画面语义与审美取舍，直接生成可确认的精选、保留和复核结果。</p>
          <div className="hero-actions">
            <button className="import-button" onClick={onImportFolder} disabled={disabled}><FolderOpen size={18} /> 导入文件夹</button>
            <button className="archive-button" onClick={onImportArchive} disabled={disabled}>RAR</button>
          </div>
          {batches.length > 0 && (
            <div className="home-batches">
              <div className="home-batches-head">
                <span>最近批次</span>
                <em>{batches.length}</em>
              </div>
              <div className="home-batch-list">
                {batches.slice(0, 4).map((item, index) => (
                  <div key={item.id} className="home-batch-item">
                    <button onClick={() => onOpenBatch(item.id)}>
                      <strong>批次 {String(index + 1).padStart(2, '0')}</strong>
                      <span>{item.name}</span>
                    </button>
                    <em>{item.totalPhotos}</em>
                    <button
                      className="home-batch-delete"
                      title="删除批次"
                      aria-label={`删除批次 ${item.name}`}
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
          <span>导入预览</span>
        </div>
        <div className="readiness-card">
          <Eye size={20} />
          <span>风险识别</span>
        </div>
        <div className="readiness-card">
          <Aperture size={20} />
          <span>相似分组</span>
        </div>
        <div className="readiness-card">
          <Sparkles size={20} />
          <span>小宫审片</span>
        </div>
      </section>
    </div>
  );
}

function ImportOverlay({ progress }: { progress: ImportProgress }): React.ReactElement {
  const hasTotal = typeof progress.total === 'number' && progress.total > 0;
  const value = hasTotal ? Math.min(100, Math.round(((progress.current || 0) / progress.total!) * 100)) : undefined;
  const stageLabel: Record<ImportProgress['stage'], string> = {
    extracting: '解压',
    scanning: '扫描',
    analyzing: '分析',
    clustering: '成组',
    done: '完成',
    error: '错误'
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
        <small>{hasTotal ? `${progress.current || 0} / ${progress.total} · ${value}%` : '请稍候...'}</small>
      </div>
    </div>
  );
}

function PhotoPanel({
  photo,
  onDecide,
  onApplyBrainSuggestion,
  onRejectBrainSuggestion
}: {
  photo?: PhotoView;
  onDecide: (decision: Decision, rating?: number) => void;
  onApplyBrainSuggestion: (review: BrainPhotoReview) => void;
  onRejectBrainSuggestion: (review: BrainPhotoReview) => void;
}): React.ReactElement {
  if (!photo) return <div className="panel empty-panel">没有可显示的照片</div>;
  const eyeStateLabel = eyeStateText(photo.analysis?.eyeState);
  return (
    <div className="panel">
      <div className="photo-title">
        <div>
          <h2>{photo.fileName}</h2>
          <p>{photo.cameraModel || 'Unknown camera'} · ISO {photo.iso || '-'} · f/{photo.aperture || '-'}</p>
        </div>
        <span className={`decision ${photo.decision}`}>{decisionLabel(photo.decision)}</span>
      </div>

      <div className="decision-dock">
        <div className="actions">
          <button className={photo.decision === 'pick' ? 'selected pick-action' : 'pick-action'} onClick={() => onDecide('pick')} title="保留"><Check size={16} /><span>保留</span></button>
          <button className={photo.decision === 'maybe' ? 'selected maybe-action' : 'maybe-action'} onClick={() => onDecide('maybe')} title="待定"><Eye size={16} /><span>待定</span></button>
          <button className={photo.decision === 'reject' ? 'selected reject-action' : 'reject-action'} onClick={() => onDecide('reject')} title="淘汰"><X size={16} /><span>淘汰</span></button>
        </div>

        <div className="rating-row" aria-label="星级">
          {[1, 2, 3, 4, 5].map((star) => (
            <button key={star} onClick={() => onDecide('pick', star)} className={photo.rating && photo.rating >= star ? 'lit' : ''}><Star size={16} /></button>
          ))}
        </div>
      </div>

      <div className="score-grid">
        <Score label="清晰" value={photo.analysis?.sharpnessScore} />
        <Score label="曝光" value={photo.analysis?.exposureScore} />
        <Score label="人脸" value={photo.analysis?.faceScore} />
        <Score label="眼部" value={photo.analysis?.eyeConfidence} display={eyeStateLabel} />
      </div>

      <div className="risk-row">
        {(photo.analysis?.riskFlags || []).length ? photo.analysis?.riskFlags.map((flag) => <span key={flag}>{riskLabel(flag)}</span>) : <span>无明显技术风险</span>}
      </div>

      <BrainReviewPanel
        review={photo.brainReview}
        photoDecision={photo.decision}
        onApply={onApplyBrainSuggestion}
        onReject={onRejectBrainSuggestion}
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
  onRun
}: {
  busy: string;
  input: string;
  activity: BrainUiLogEvent[];
  result: XiaogongRunResult | null;
  activeSmartView: SmartView | null;
  activeItem?: SmartView['items'][number];
  onInput: (value: string) => void;
  onRun: (message?: string) => void;
}): React.ReactElement {
  const quickTasks = ['找最好看的', '找封面候选', '复核闭眼', '每组选 1 张'];
  return (
    <section className="xiaogong-console">
      <div className="xiaogong-head">
        <span><Brain size={15} /> 小宫</span>
        <em>{busy ? '运行中' : activeSmartView ? '视图控制' : '待命'}</em>
      </div>

      <div className="xiaogong-input-row">
        <input
          value={input}
          placeholder="对小宫说：找出最好看的"
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onRun();
            }
          }}
          disabled={Boolean(busy)}
        />
        <button onClick={() => onRun()} disabled={Boolean(busy || !input.trim())} title="发送">
          {busy ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
        </button>
      </div>

      <div className="xiaogong-chips">
        {quickTasks.map((task) => (
          <button key={task} onClick={() => onRun(task)} disabled={Boolean(busy)}>{task}</button>
        ))}
      </div>

      <XiaogongLogTimeline activity={activity} active={Boolean(busy)} />

      {result?.confirmation && (
        <div className="xiaogong-confirmation">
          <strong>{result.confirmation.title}</strong>
          <p>{result.confirmation.message}</p>
          <span>{result.confirmation.permissionLevel}</span>
          <div>
            <button type="button" disabled>等待确认功能接入</button>
          </div>
        </div>
      )}
    </section>
  );
}

function XiaogongLogTimeline({ activity, active }: { activity: BrainUiLogEvent[]; active: boolean }): React.ReactElement | null {
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
        <span>任务日志</span>
        <em>{active ? '运行中' : hasActivity ? '已记录' : '等待事件'}</em>
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
            title={item.photoFileName || xiaogongDisplayTitle(item)}
          >
            <span>{xiaogongPhaseLabel(item.phase)}</span>
            <div>
              <strong>{xiaogongDisplayTitle(item)}</strong>
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
          有新进展
        </button>
      )}
    </div>
  );
}

function xiaogongToolTitle(toolName?: string): string | undefined {
  if (!toolName) return undefined;
  const titles: Record<string, string> = {
    GetWorkspaceContext: '读取工作台状态',
    GetBatchOverview: '理解整批照片',
    DecideReviewStrategy: '制定审片策略',
    GetCurrentPhoto: '读取当前照片',
    GenerateLocalCandidates: '整理候选线索',
    CreateSmartView: '生成智能视图',
    ShowSmartView: '打开智能视图',
    ReviewPhotoWithVision: '查看照片画面',
    CompareSimilarGroupWithVision: '比较连拍组',
    WriteBrainReviewResult: '写入小宫审片结果',
    ExplainCurrentPhoto: '解释当前照片',
    ApplyDecision: '准备修改照片选择',
    BatchApplyDecisions: '准备批量修改选择',
    SetRating: '准备修改星级',
    ExportSelected: '准备导出已选照片',
    DeleteBatch: '准备删除批次',
    DeleteOriginalFiles: '准备删除原片'
  };
  return titles[toolName];
}

function xiaogongDisplayTitle(item: BrainUiLogEvent): string {
  const toolTitle = xiaogongToolTitle(item.toolName);
  if (!toolTitle) return item.title;
  if (item.title.startsWith('工具失败')) return `${toolTitle}失败`;
  if (item.title.startsWith('需要确认')) return `需要确认：${toolTitle}`;
  if (item.title.startsWith('调用工具')) return toolTitle;
  return item.title.includes(item.toolName || '') ? item.title.replace(item.toolName || '', toolTitle).replace('调用工具：', '') : item.title;
}

function xiaogongPhaseLabel(phase: BrainUiLogEvent['phase']): string {
  const labels: Record<BrainUiLogEvent['phase'], string> = {
    understanding: '理解',
    workspace: '读取',
    planning: '规划',
    tool: '工具',
    vision: '看图',
    compare: '比较',
    write: '写入',
    ui: '界面',
    confirmation: '确认',
    done: '完成',
    failed: '错误'
  };
  return labels[phase];
}

function BrainActivityPanel({
  progress,
  activity,
  active,
  lastRun
}: {
  progress: BrainProgressEvent | null;
  activity: BrainProgressEvent[];
  active: boolean;
  lastRun: BrainRunResult | null;
}): React.ReactElement | null {
  if (!active && !progress && !lastRun) return null;
  const status = progress?.status || lastRun?.status || 'running';
  const total = !active && lastRun ? lastRun.reviewed : progress?.total || lastRun?.reviewed || 0;
  const current = !active && lastRun ? lastRun.reviewed : progress?.current ?? lastRun?.reviewed ?? 0;
  const pctValue = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const recentActivity = (activity.length ? activity : progress ? [progress] : []).slice(0, 3);
  const statusLabel = active ? '审片中' : status === 'completed' ? '上次审片' : status === 'failed' ? '审片失败' : '审片状态';
  const statusMeta = total
    ? `${current}/${total}`
    : status === 'completed'
      ? '完成'
      : status === 'failed'
        ? '失败'
        : active
          ? '进行中'
          : '待开始';

  return (
    <section className={`brain-activity-panel ${status}`}>
      <div className="brain-activity-head">
        <span>{active ? <Loader2 className="spin" size={15} /> : <Brain size={15} />} {statusLabel}</span>
        <em>{statusMeta}</em>
      </div>
      <div className="brain-activity-track">
        <i style={{ width: `${pctValue}%` }} />
      </div>
      <strong>{progress?.message || lastRun?.message || '小宫会把当前分组的单张判断写入右侧。'}</strong>
      {active && recentActivity.length > 0 && (
        <div className="brain-activity-list">
          {recentActivity.map((item, index) => (
            <div key={`${item.phase}-${item.photoId || item.runId}-${index}`}>
              <span>{activityLabel(item.phase)}</span>
              <p>{item.message}</p>
            </div>
          ))}
        </div>
      )}
      {status === 'failed' && (progress?.debugLogPath || lastRun?.debugLogPath) && (
        <small>日志：{progress?.debugLogPath || lastRun?.debugLogPath}</small>
      )}
    </section>
  );
}

function activityLabel(phase: BrainProgressEvent['phase']): string {
  const labels: Record<BrainProgressEvent['phase'], string> = {
    started: '开始',
    context: '读取',
    planning: '规划',
    photo_started: '看图',
    photo_completed: '完成',
    group_started: '比较',
    group_completed: '组内',
    reducing: '归并',
    persisting: '写入',
    completed: '结束',
    failed: '错误'
  };
  return labels[phase];
}

function bucketText(bucket?: string): string {
  const labels: Record<string, string> = {
    featured: '精选候选',
    keepers: '建议保留',
    lowPriority: '低优先级备选',
    reviewQueue: '人工复核',
    closedEyes: '疑似闭眼',
    eyeReview: '眼部复核',
    subject: '主体问题',
    technical: '技术问题',
    duplicates: '近重复',
    similarBursts: '相似连拍',
    pending: '待判断'
  };
  return labels[bucket || ''] || '未分组';
}

function actionText(action?: string): string {
  const labels: Record<string, string> = {
    pick: '建议保留',
    reject: '建议淘汰',
    maybe: '建议保留',
    review: '建议人工复核',
    none: '不改人工标记'
  };
  return labels[action || ''] || '建议人工复核';
}

function productReviewText(value?: string): string {
  if (!value) return '';
  return value
    .replace(/\bcell\s*#?\s*\d+\b/gi, '同组相邻照片')
    .replace(/\bfeatured\b/gi, '精选候选')
    .replace(/\bkeeper(s)?\b/gi, '保留备选')
    .replace(/\bmaybe\b/gi, '备选保留')
    .replace(/\breject\b/gi, '淘汰')
    .replace(/\bpick\b/gi, '保留')
    .replace(/\bprimaryBucket\b/g, '主分组')
    .replace(/\bsecondaryBuckets\b/g, '辅助分组')
    .replace(/\brecommendedAction\b/g, '建议动作')
    .replace(/\bneedsHumanReview\b/g, '人工复核')
    .replace(/\bsimilarBursts\b/g, '相似连拍')
    .replace(/\bclosedEyes\b/g, '闭眼风险')
    .replace(/\beyeReview\b/g, '眼神复核')
    .replace(/\bface[_ ]?blur\b/gi, '脸部清晰度风险')
    .replace(/\bface[_ ]?missing\b/gi, '主体缺失风险')
    .replace(/\blocal\b/gi, '自动')
    .replace(/\s+/g, ' ')
    .trim();
}

function smallModelOverrideText(value: string): string {
  const text = value.trim();
  const lower = text.toLowerCase();
  const mappings: Array<[RegExp, string]> = [
    [/local[_ ]?score|final[_ ]?score|score.*overstates|overestimate|overstates|overstated|does not reflect|偏高|高分.*下调/i, '自动评分偏高'],
    [/^score$|score/i, '自动评分需复核'],
    [/exposure[_ ]?score|exposure/i, '曝光判断需复核'],
    [/face[_ ]?score/i, '人像清晰度需复核'],
    [/featured value|cover-level|not featured|featured/i, '未达精选门槛'],
    [/background clutter|busy background|background.*clutter/i, '背景干扰明显'],
    [/average lighting|harsh backlight|backlight|lighting/i, '光线影响质感'],
    [/deliverablescore|deliverable score/i, '交付完成度不足'],
    [/face_blur|face blur|missed_focus|focus/i, '脸部清晰度风险'],
    [/eyes_uncertain|eye/i, '眼神需要复核'],
    [/face_missing|back view/i, '主体表达偏弱'],
    [/snapshot|low finish|finish/i, '画面完成度偏随拍'],
    [/crop|cropped/i, '裁切不够理想']
  ];
  const hit = mappings.find(([pattern]) => pattern.test(lower));
  if (hit) return hit[1];
  if (lower === '[object object]' || lower.includes('[object object]')) return '修正依据需复核';
  const asciiChars = text.match(/[a-z0-9_()[\].:-]/gi)?.length || 0;
  const visibleChars = text.replace(/\s/g, '').length || 1;
  if (asciiChars / visibleChars > 0.6) return '自动判断需复核';
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
}

function smallModelOverrideTitle(value: string): string {
  const display = smallModelOverrideText(value);
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
  onReject
}: {
  review?: BrainPhotoReview;
  photoDecision: Decision;
  onApply: (review: BrainPhotoReview) => void;
  onReject: (review: BrainPhotoReview, note?: string) => void;
}): React.ReactElement {
  const [rejecting, setRejecting] = React.useState(false);
  const [rejectNote, setRejectNote] = React.useState('');

  if (!review) {
    return (
      <section className="brain-review-panel empty-brain-review">
        <div className="brain-review-head">
          <span><Brain size={15} /> 小宫判断</span>
          <em>尚未审片</em>
        </div>
        <p>运行“小宫审片”后，这里只保留当前照片的结论和关键证据。</p>
      </section>
    );
  }

  const scores = [
    ['画面', review.visualScores.visualQuality],
    ['表情', review.visualScores.expression],
    ['瞬间', review.visualScores.moment],
    ['构图', review.visualScores.composition],
    ['背景', review.visualScores.backgroundCleanliness],
    ['故事', review.visualScores.storyValue]
  ] as const;
  const recommendedDecision: Decision | undefined =
    review.recommendedAction === 'pick' || review.recommendedAction === 'reject' || review.recommendedAction === 'maybe'
      ? review.recommendedAction
      : undefined;
  const accepted = Boolean(recommendedDecision && photoDecision === recommendedDecision);
  const decisionText = recommendedDecision ? decisionLabel(recommendedDecision) : '';
  const deliverableScore = review.visualScores.deliverableScore;
  const curationScore = reviewCurationScore(review);
  const reasonText = productReviewText(review.reason);
  const groupReasonText = productReviewText(review.groupReason);

  return (
    <section className="brain-review-panel">
      <div className="brain-review-head">
        <span><Brain size={15} /> 小宫判断</span>
        <em title="这是小宫对当前判断的置信度，不是审美排序分。">判断置信度 {scorePct(review.confidence)}%</em>
      </div>
      <div className="brain-score-summary">
        <div title="照片作为交付/展示候选的完成度。">
          <span>交付分</span>
          <strong>{scorePct(deliverableScore)}</strong>
        </div>
        <div title="由画面、表情、瞬间、构图、背景和故事综合得到的参考分。">
          <span>综合参考</span>
          <strong>{scorePct(curationScore)}</strong>
        </div>
      </div>
      <div className="brain-bucket-line">
        <strong>{bucketText(review.primaryBucket)}</strong>
        <span className={`brain-action-chip ${accepted ? 'accepted' : review.recommendedAction || 'review'}`}>
          {accepted ? `已采纳：${decisionText}` : actionText(review.recommendedAction)}
        </span>
      </div>
      <p className="brain-reason" title={reasonText}>{reasonText}</p>
      {review.smallModelOverrides.length > 0 && (
        <div className="brain-overrides">
          <strong>小宫修正</strong>
          {review.smallModelOverrides.map((item) => <span key={item} title={smallModelOverrideTitle(item)}>{smallModelOverrideText(item)}</span>)}
        </div>
      )}
      {review.needsHumanReview && <div className="brain-review-alert">需要人工复核</div>}
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
          <div className="brain-review-accepted"><Check size={14} /> 已按小宫判断更新当前照片状态</div>
        ) : (
          rejecting ? (
            <div className="brain-reject-box">
              <textarea
                value={rejectNote}
                onChange={(event) => setRejectNote(event.target.value)}
                placeholder="填写不采纳理由，例如：人物表情更自然、构图更完整、闭眼其实是情绪瞬间"
                rows={3}
              />
              <div className="brain-reject-actions">
                <button onClick={() => { onReject(review, rejectNote); setRejecting(false); setRejectNote(''); }}>
                  <X size={14} /> 确认不采纳
                </button>
                <button onClick={() => { setRejecting(false); setRejectNote(''); }}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <button onClick={() => onApply(review)} disabled={review.recommendedAction === 'none'}>
                <Check size={14} /> 采纳
              </button>
              <button onClick={() => setRejecting(true)}>
                <X size={14} /> 不采纳
              </button>
            </>
          )
        )}
      </div>
    </section>
  );
}

function eyeStateText(state?: string): string {
  const labels: Record<string, string> = {
    open: '睁眼',
    closed: '闭眼',
    uncertain: '不确定',
    not_applicable: '不适用',
    unknown: '未知'
  };
  return labels[state || 'unknown'] || '未知';
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
