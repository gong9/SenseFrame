import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Aperture,
  Brain,
  Check,
  Download,
  Eye,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Layers,
  Loader2,
  Search,
  ScanFace,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react';
import type { BatchView, Cluster, Decision, ImportProgress, PhotoView, SearchResult } from '../electron/shared/types';
import './styles.css';

type ViewMode = 'featured' | 'closedEyes' | 'eyeReview' | 'subject' | 'technical' | 'duplicates' | 'similarBursts' | 'pending' | 'search';

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

function App(): React.ReactElement {
  const [batches, setBatches] = useState<Array<{ id: string; name: string; status: string; totalPhotos: number; createdAt: string }>>([]);
  const [batch, setBatch] = useState<BatchView | null>(null);
  const [mode, setMode] = useState<ViewMode>('featured');
  const [clusterIndex, setClusterIndex] = useState(0);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [busy, setBusy] = useState('');
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [debugMode, setDebugMode] = useState(false);

  async function refreshBatches(): Promise<void> {
    if (!window.senseframe) return;
    setBatches(await window.senseframe.listBatches());
  }

  async function loadBatch(id: string): Promise<void> {
    if (!window.senseframe) return;
    const next = await window.senseframe.getBatch(id);
    setBatch(next);
    setClusterIndex(0);
    setPhotoIndex(0);
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

  useEffect(() => {
    refreshBatches().then(() => undefined);
    if (!window.senseframe) return;
    return window.senseframe.onImportProgress((progress) => {
      setImportProgress(progress);
      setBusy(progress.total ? `${progress.message} ${progress.current || 0}/${progress.total}` : progress.message);
    });
  }, []);

  const duplicateIds = useMemo(() => (batch ? duplicatePhotoIds(batch) : new Set<string>()), [batch]);
  const clusterMeta = useMemo(() => (batch ? clusterMetaByPhoto(batch) : new Map<string, ClusterMeta>()), [batch]);
  const burstMeta = useMemo(() => (batch ? similarBurstMetaByPhoto(batch) : new Map<string, BurstMeta>()), [batch]);
  const bucketDefs = useMemo(() => {
    if (!batch) return [];
    const buckets: Array<{ id: ViewMode; label: string; description: string; count: number; icon: React.ReactNode }> = [
      {
        id: 'featured',
        label: '精选候选',
        description: '组内优先看的照片',
        count: batch.photos.filter((photo) => photo.recommended).length,
        icon: <Sparkles size={16} />
      },
      {
        id: 'closedEyes',
        label: '疑似闭眼',
        description: '双眼高置信闭合',
        count: batch.photos.filter((photo) => hasAnyFlag(photo, closedEyeFlags)).length,
        icon: <Eye size={16} />
      },
      {
        id: 'eyeReview',
        label: '眼部复核',
        description: '侧脸、远景或遮挡',
        count: batch.photos.filter((photo) => hasAnyFlag(photo, eyeReviewFlags)).length,
        icon: <Eye size={16} />
      },
      {
        id: 'subject',
        label: '主体问题',
        description: '裁切或主体弱',
        count: batch.photos.filter((photo) => hasAnyFlag(photo, subjectFlags)).length,
        icon: <ImageIcon size={16} />
      },
      {
        id: 'technical',
        label: '技术问题',
        description: '模糊、曝光、解析失败',
        count: batch.photos.filter((photo) => hasAnyFlag(photo, technicalFlags) || photo.status !== 'ready').length,
        icon: <TriangleAlert size={16} />
      },
      {
        id: 'duplicates',
        label: '近重复',
        description: '构图几乎一致的照片',
        count: duplicateIds.size,
        icon: <Layers size={16} />
      },
      {
        id: 'similarBursts',
        label: '相似连拍',
        description: '同一动作段的照片',
        count: burstMeta.size,
        icon: <Layers size={16} />
      },
      {
        id: 'pending',
        label: '待判断',
        description: 'AI 不确定，建议人工看',
        count: batch.photos.filter((photo) => {
          const flags = photo.analysis?.riskFlags || [];
          return photo.analysis?.eyeState === 'uncertain' || photo.analysis?.faceVisibility === 'unknown' || (flags.length > 0 && !photo.recommended);
        }).length,
        icon: <Brain size={16} />
      }
    ];
    return buckets;
  }, [batch, duplicateIds, burstMeta]);
  const activeBucket = bucketDefs.find((bucket) => bucket.id === mode);
  const visiblePhotos = useMemo(() => {
    if (!batch) return [];
    if (mode === 'search') return results.map((item) => item.photo);
    if (mode === 'featured') return batch.photos.filter((photo) => photo.recommended);
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
      return photo.analysis?.eyeState === 'uncertain' || photo.analysis?.faceVisibility === 'unknown' || (flags.length > 0 && !photo.recommended);
    });
    return [];
  }, [batch, mode, results, duplicateIds, burstMeta]);
  const activePhoto = visiblePhotos[Math.min(photoIndex, Math.max(visiblePhotos.length - 1, 0))];
  const activeClusterMeta = activePhoto ? clusterMeta.get(activePhoto.id) : undefined;
  const activeBurstMeta = activePhoto ? burstMeta.get(activePhoto.id) : undefined;

  const stats = useMemo(() => {
    if (!batch) return { candidates: 0, review: 0, picked: 0, rejected: 0 };
    return {
      candidates: batch.photos.filter((photo) => photo.recommended).length,
      review: batch.photos.filter((photo) => photo.analysis?.riskFlags.length || photo.status !== 'ready').length,
      picked: batch.photos.filter((photo) => photo.decision === 'pick').length,
      rejected: batch.photos.filter((photo) => photo.decision === 'reject').length
    };
  }, [batch]);

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

  async function decide(decision: Decision, rating?: number): Promise<void> {
    if (!batch || !activePhoto) return;
    if (!window.senseframe) return;
    await window.senseframe.saveDecision({ batchId: batch.id, photoId: activePhoto.id, decision, rating });
    await loadBatch(batch.id);
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
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Aperture size={22} /></div>
          <div>
            <div className="brand-name">SenseFrame</div>
            <div className="brand-sub">AI Culling Studio</div>
          </div>
        </div>

        <div className="import-actions">
          <button className="primary-action" onClick={() => importSource('folder')} disabled={Boolean(importProgress)}>
            <FolderOpen size={18} /> 导入文件夹
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
          </div>
        )}

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

        <div className="batch-list">
          <div className="section-label">批次</div>
          {batches.map((item) => (
            <div key={item.id} className={`batch-item ${batch?.id === item.id ? 'active' : ''}`}>
              <button className="batch-open" onClick={() => loadBatch(item.id)}>
                <span>{item.name}</span>
                <small>{item.totalPhotos} photos</small>
              </button>
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
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>{batch ? `${activeBucket?.label || '语义搜索'} · ${visiblePhotos.length}` : '选择一个拍摄批次开始'}</h1>
            <p>{batch ? `${batch.name} · ${batch.clusters.length} 个相似组 · ${stats.rejected} 张淘汰建议已确认` : '导入后会自动生成缩略图、RAW 预览、质量分、人脸闭眼检测和相似组。'}</p>
          </div>
          {batch && (
            <div className="toolbar">
              <button className={mode === 'search' ? 'selected' : ''} onClick={() => { setMode('search'); setPhotoIndex(0); }}>
                <Search size={16} /> 语义搜索
              </button>
              <button className={debugMode ? 'selected' : ''} onClick={() => setDebugMode((value) => !value)}>
                <ScanFace size={16} /> 调试框
              </button>
              <button onClick={exportCsv}><Download size={16} /> CSV</button>
            </div>
          )}
        </header>

        {!batch ? (
          <EmptyState onImportFolder={() => importSource('folder')} onImportArchive={() => importSource('archive')} disabled={Boolean(importProgress)} />
        ) : (
          <div className="main-grid">
            <section className="viewer">
              <div className="image-stage">
                {activePhoto?.previewPath ? (
                  <div className="debug-image-wrap">
                    <img src={window.senseframe?.fileUrl(activePhoto.previewPath)} alt={activePhoto.fileName} />
                    {debugMode && <DebugOverlay photo={activePhoto} />}
                  </div>
                ) : visiblePhotos.length === 0 ? (
                  <div className="missing-preview"><Layers size={46} />当前分组没有照片</div>
                ) : (
                  <div className="missing-preview"><ImageIcon size={46} />预览不可用</div>
                )}
                {busy && <div className="busy"><Loader2 className="spin" size={18} /> {busy}</div>}
              </div>
              <div className="filmstrip">
                {visiblePhotos.map((photo, index) => {
                  const meta = clusterMeta.get(photo.id);
                  const burst = burstMeta.get(photo.id);
                  return (
                    <button
                      key={photo.id}
                      className={`thumb ${index === photoIndex ? 'active' : ''} ${photo.decision} ${meta || burst ? 'clustered' : ''} ${meta?.recommended ? 'cluster-best' : ''}`}
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
                      {photo.recommended && <span className="badge">推荐</span>}
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
              {mode === 'search' && (
                <div className="search-box">
                  <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="找新娘和父亲拥抱、舞台灯光、封面横构图..." />
                  <button onClick={runSearch}><Search size={16} /></button>
                </div>
              )}

              <PhotoPanel photo={activePhoto} onAnalyze={analyzeSemantic} onDecide={decide} />
            </aside>
          </div>
        )}

        {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}
        {importProgress && <ImportOverlay progress={importProgress} />}
      </section>
    </main>
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

function EmptyState({ onImportFolder, onImportArchive, disabled }: { onImportFolder: () => void; onImportArchive: () => void; disabled: boolean }): React.ReactElement {
  return (
    <div className="empty">
      <section className="import-card">
        <div className="import-icon"><HardDrive size={26} /></div>
        <span className="frame-kicker">New contact sheet</span>
        <h2>让光线先沉淀下来</h2>
        <p>导入一组照片，SenseFrame 会把重复、迟疑和失焦留在暗处。</p>
        <div className="hero-actions">
          <button className="import-button" onClick={onImportFolder} disabled={disabled}><FolderOpen size={18} /> 文件夹</button>
          <button className="archive-button" onClick={onImportArchive} disabled={disabled}>RAR</button>
        </div>
      </section>

      <section className="readiness-grid">
        <div className="readiness-card">
          <ImageIcon size={20} />
          <span>显影</span>
        </div>
        <div className="readiness-card">
          <Eye size={20} />
          <span>凝视</span>
        </div>
        <div className="readiness-card">
          <Aperture size={20} />
          <span>成组</span>
        </div>
        <div className="readiness-card">
          <Sparkles size={20} />
          <span>注解</span>
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

function PhotoPanel({ photo, onAnalyze, onDecide }: { photo?: PhotoView; onAnalyze: () => void; onDecide: (decision: Decision, rating?: number) => void }): React.ReactElement {
  if (!photo) return <div className="panel empty-panel">没有可显示的照片</div>;
  const tags = [...(photo.semantic?.subjects || []), ...(photo.semantic?.emotion || []), ...(photo.semantic?.usage || [])];
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

      <div className="score-grid">
        <Score label="清晰" value={photo.analysis?.sharpnessScore} />
        <Score label="曝光" value={photo.analysis?.exposureScore} />
        <Score label="人脸" value={photo.analysis?.faceScore} />
        <Score label="眼部状态" value={photo.analysis?.eyeConfidence} display={eyeStateLabel} />
      </div>
      <p className="score-help">分数越高，表示这一项越稳定；它只做初筛参考，不会自动删除照片。</p>

      <div className="risk-row">
        {(photo.analysis?.riskFlags || []).length ? photo.analysis?.riskFlags.map((flag) => <span key={flag}>{riskLabel(flag)}</span>) : <span>未发现明显技术风险</span>}
      </div>

      <div className="actions">
        <button onClick={() => onDecide('pick')}><Check size={16} /> 保留</button>
        <button onClick={() => onDecide('maybe')}><Eye size={16} /> 待定</button>
        <button onClick={() => onDecide('reject')}><X size={16} /> 淘汰</button>
      </div>

      <div className="rating-row">
        {[1, 2, 3, 4, 5].map((star) => (
          <button key={star} onClick={() => onDecide('pick', star)} className={photo.rating && photo.rating >= star ? 'lit' : ''}><Star size={16} /></button>
        ))}
      </div>

      <div className="semantic">
        <div className="semantic-head">
          <h3><Brain size={16} /> 大模型增强</h3>
          <button onClick={onAnalyze}><Sparkles size={15} /> 分析</button>
        </div>
        {photo.semantic ? (
          <>
            <p className="caption">{photo.semantic.caption}</p>
            <p className="reason">{photo.semantic.recommendationReason}</p>
            <div className="tag-row">{tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <div className="llm-scores">
              <Score label="情绪" value={photo.semantic.llmScore.emotion} />
              <Score label="故事" value={photo.semantic.llmScore.story} />
              <Score label="封面" value={photo.semantic.llmScore.coverPotential} />
            </div>
          </>
        ) : (
          <p className="muted">点击分析，补充语义标签、推荐解释和搜索索引。</p>
        )}
      </div>
    </div>
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
