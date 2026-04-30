import crypto from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { app } from 'electron';
import exifr from 'exifr';
import { createExtractorFromFile } from 'node-unrar-js';
import sharp from 'sharp';
import { getDb } from './db';
import { analyzeWithPython, makePythonPreview, pythonSetupHint } from './pythonWorker';
import type { BatchView, Cluster, DeleteBatchResult, EyeState, FaceVisibility, ImportProgress, ImportResult, PhotoAnalysis, PhotoView, RiskFlag, SingleEyeState } from '../shared/types';

const IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.arw',
  '.cr2',
  '.cr3',
  '.nef',
  '.raf',
  '.dng',
  '.orf',
  '.rw2',
  '.pef',
  '.srw'
]);

const RAW_EXTS = new Set(['.arw', '.cr2', '.cr3', '.nef', '.raf', '.dng', '.orf', '.rw2', '.pef', '.srw']);
const HEIC_EXTS = new Set(['.heic', '.heif']);
const ARCHIVE_EXTS = new Set(['.rar']);

function eyesOpenScoreFromState(state: EyeState): number {
  if (state === 'open') return 1;
  if (state === 'closed') return 0;
  if (state === 'not_applicable') return 0;
  return 0.5;
}

function normalizeAnalysis(result: Omit<PhotoAnalysis, 'photoId'>): Omit<PhotoAnalysis, 'photoId'> {
  const eyeState = (result.eyeState || 'unknown') as EyeState;
  return {
    ...result,
    faceVisibility: (result.faceVisibility || 'unknown') as FaceVisibility,
    eyeState,
    eyeConfidence: Number(result.eyeConfidence || 0),
    leftEyeState: (result.leftEyeState || 'missing') as SingleEyeState,
    rightEyeState: (result.rightEyeState || 'missing') as SingleEyeState,
    debugRegions: Array.isArray(result.debugRegions) ? result.debugRegions : [],
    eyesOpenScore: typeof result.eyesOpenScore === 'number' ? result.eyesOpenScore : eyesOpenScoreFromState(eyeState)
  };
}

function now(): string {
  return new Date().toISOString();
}

function appCacheDir(batchId: string): string {
  const dir = join(app.getPath('userData'), 'senseframe-cache', batchId);
  mkdirSync(join(dir, 'thumbs'), { recursive: true });
  mkdirSync(join(dir, 'previews'), { recursive: true });
  return dir;
}

function appImportDir(importId: string): string {
  const dir = join(app.getPath('userData'), 'senseframe-imports', importId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function idFor(filePath: string, size: number, mtime: string): string {
  return crypto.createHash('sha1').update(`${filePath}:${size}:${mtime}`).digest('hex').slice(0, 20);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...walk(full));
    if (stats.isFile() && IMAGE_EXTS.has(extname(full).toLowerCase())) out.push(full);
  }
  return out;
}

async function extractRarArchive(archivePath: string): Promise<string> {
  const stats = statSync(archivePath);
  const importId = crypto.createHash('sha1').update(`${archivePath}:${stats.size}:${stats.mtime.toISOString()}`).digest('hex').slice(0, 20);
  const outDir = appImportDir(importId);
  try {
    const extractor = await createExtractorFromFile({
      filepath: archivePath,
      targetPath: outDir
    });
    const extracted = extractor.extract();
    for (const file of extracted.files) {
      if (file.fileHeader.flags.encrypted) throw new Error(`压缩包包含加密文件：${file.fileHeader.name}`);
    }
    return outDir;
  } catch (error) {
    throw new Error(`RAR 解压失败：${error instanceof Error ? error.message : String(error)}。请确认压缩包没有损坏、加密或使用不支持的 RAR 特性。`);
  }
}

async function readExif(filePath: string): Promise<Record<string, any>> {
  try {
    return (await exifr.parse(filePath, {
      tiff: true,
      exif: true,
      gps: false,
      translateValues: false,
      translateKeys: false,
      reviveValues: true
    } as any)) || {};
  } catch {
    return {};
  }
}

async function makeSharpPreview(input: string, previewPath: string, thumbPath: string): Promise<{ width?: number; height?: number }> {
  const image = sharp(input, { failOn: 'none', limitInputPixels: false }).rotate();
  const meta = await image.metadata();
  await image.clone().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(previewPath);
  await image.clone().resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(thumbPath);
  return { width: meta.width, height: meta.height };
}

async function createPreview(filePath: string, previewPath: string, thumbPath: string): Promise<{ width?: number; height?: number; riskFlags: RiskFlag[]; status: string }> {
  const ext = extname(filePath).toLowerCase();
  try {
    if (RAW_EXTS.has(ext)) {
      const meta = await makePythonPreview(filePath, previewPath, thumbPath);
      return { ...meta, riskFlags: [], status: 'ready' };
    }
    try {
      const meta = await makeSharpPreview(filePath, previewPath, thumbPath);
      return { ...meta, riskFlags: [], status: 'ready' };
    } catch (sharpError) {
      const meta = await makePythonPreview(filePath, previewPath, thumbPath);
      return { ...meta, riskFlags: [], status: 'ready' };
    }
  } catch (error) {
    const flag: RiskFlag = RAW_EXTS.has(ext) ? 'raw_decode_failed' : HEIC_EXTS.has(ext) ? 'heic_decode_failed' : 'unsupported_preview';
    return {
      riskFlags: [flag],
      status: `${flag}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function analyzePhoto(filePath: string, photoId: string, previewPath?: string, baseFlags: RiskFlag[] = []): Promise<PhotoAnalysis> {
  try {
    const source = previewPath && existsSync(previewPath) ? previewPath : filePath;
    const result = normalizeAnalysis(await analyzeWithPython(source));
    return {
      photoId,
      ...result,
      riskFlags: Array.from(new Set([...baseFlags, ...result.riskFlags]))
    };
  } catch {
    if (!previewPath || !existsSync(previewPath)) {
      return {
        photoId,
        sharpnessScore: 0,
        exposureScore: 0,
        highlightClipRatio: 0,
        shadowClipRatio: 0,
        faceScore: 0,
        eyesOpenScore: 0,
        faceVisibility: 'unknown',
        eyeState: 'unknown',
        eyeConfidence: 0,
        leftEyeState: 'missing',
        rightEyeState: 'missing',
        debugRegions: [],
        faceCount: 0,
        finalScore: 0,
        riskFlags: Array.from(new Set([...baseFlags, 'unsupported_preview']))
      };
    }

    const image = sharp(previewPath, { failOn: 'none' }).greyscale().resize({ width: 256, height: 256, fit: 'inside' });
    const raw = await image.raw().toBuffer({ resolveWithObject: true });
    const pixels = raw.data;
    let mean = 0;
    let highlights = 0;
    let shadows = 0;
    for (const value of pixels) {
      mean += value;
      if (value >= 245) highlights += 1;
      if (value <= 10) shadows += 1;
    }
    mean /= pixels.length * 255;
    const highlightRatio = highlights / pixels.length;
    const shadowRatio = shadows / pixels.length;
    const exposureScore = Math.max(0, Math.min(1, 1 - Math.abs(mean - 0.5) * 0.55 - Math.min(0.75, highlightRatio * 2.2 + shadowRatio * 1.6)));
    return {
      photoId,
      sharpnessScore: 0.5,
      exposureScore,
      highlightClipRatio: highlightRatio,
      shadowClipRatio: shadowRatio,
      faceScore: 0.5,
      eyesOpenScore: 0.5,
      faceVisibility: 'unknown',
      eyeState: 'unknown',
      eyeConfidence: 0,
      leftEyeState: 'missing',
      rightEyeState: 'missing',
      debugRegions: [],
      faceCount: 0,
      finalScore: exposureScore * 0.55 + 0.225,
      riskFlags: Array.from(new Set(baseFlags))
    };
  }
}

async function hashPreview(previewPath?: string): Promise<string> {
  if (!previewPath || !existsSync(previewPath)) return '';
  const averageImage = await sharp(previewPath).greyscale().resize(16, 16, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const average = averageImage.data.reduce((sum, value) => sum + value, 0) / averageImage.data.length;
  const averageHash = Array.from(averageImage.data)
    .map((value) => (value > average ? '1' : '0'))
    .join('');

  const differenceImage = await sharp(previewPath).greyscale().resize(17, 16, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const differenceHash: string[] = [];
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const left = differenceImage.data[y * 17 + x];
      const right = differenceImage.data[y * 17 + x + 1];
      differenceHash.push(left > right ? '1' : '0');
    }
  }
  return `${averageHash}:${differenceHash.join('')}`;
}

function hammingSimilarity(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 0;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
  return 1 - diff / a.length;
}

function visualSimilarity(a: string, b: string): number {
  const [averageA, differenceA] = a.split(':');
  const [averageB, differenceB] = b.split(':');
  if (!averageA || !differenceA || !averageB || !differenceB) return hammingSimilarity(a, b);
  return Math.min(hammingSimilarity(averageA, averageB), hammingSimilarity(differenceA, differenceB));
}

async function buildClusters(batchId: string, photos: PhotoView[]): Promise<Cluster[]> {
  const sorted = [...photos].sort((a, b) => (a.shotAt || a.fileName).localeCompare(b.shotAt || b.fileName));
  const hashById = new Map<string, string>();
  for (const photo of sorted) hashById.set(photo.id, await hashPreview(photo.previewPath));

  const used = new Set<string>();
  const groups: PhotoView[][] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const seed = sorted[i];
    if (used.has(seed.id)) continue;
    const group = [seed];
    used.add(seed.id);
    for (let j = i + 1; j < Math.min(sorted.length, i + 16); j += 1) {
      const candidate = sorted[j];
      if (used.has(candidate.id)) continue;
      const similarity = visualSimilarity(hashById.get(seed.id) || '', hashById.get(candidate.id) || '');
      if (similarity >= 0.94) {
        group.push(candidate);
        used.add(candidate.id);
      }
    }
    groups.push(group);
  }

  const clusters: Cluster[] = [];
  let index = 1;
  for (const group of groups) {
    const adjustedScore = (photo: PhotoView): number => {
      const flags = new Set(photo.analysis?.riskFlags || []);
      let score = photo.analysis?.finalScore || 0;
      if (flags.has('subject_cropped')) score -= 0.35;
      if (flags.has('weak_subject')) score -= 0.16;
      if (flags.has('possible_blur')) score -= 0.12;
      if (flags.has('bad_exposure')) score -= 0.1;
      if (flags.has('closed_eyes')) score -= 0.18;
      return score;
    };
    const ranked = [...group].sort((a, b) => adjustedScore(b) - adjustedScore(a));
    const best = ranked[0];
    const size = ranked.length;
    const recommendCount = size > 8 ? 3 : size > 3 ? 2 : 1;
    const clusterId = `${batchId}-c${String(index).padStart(3, '0')}`;
    clusters.push({
      id: clusterId,
      batchId,
      size,
      bestPhotoId: best?.id,
      confidence: size > 1 ? 0.88 : 0.6,
      members: ranked.map((photo, rank) => ({
        photoId: photo.id,
        rank: rank + 1,
        similarityToBest: visualSimilarity(hashById.get(best.id) || '', hashById.get(photo.id) || ''),
        recommended: rank < recommendCount
      }))
    });
    index += 1;
  }
  return clusters;
}

export async function importFolder(rootPath: string, onProgress?: (progress: ImportProgress) => void): Promise<ImportResult> {
  const db = getDb();
  const batchId = crypto.randomUUID();
  const createdAt = now();
  db.prepare('INSERT INTO batches (id, name, root_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    batchId,
    basename(rootPath),
    rootPath,
    'processing',
    createdAt,
    createdAt
  );

  onProgress?.({ stage: 'scanning', message: '正在扫描照片...' });
  const files = walk(rootPath);
  onProgress?.({ stage: 'analyzing', message: `发现 ${files.length} 张照片，正在生成预览与分析...`, current: 0, total: files.length });
  const cacheDir = appCacheDir(batchId);
  let unsupported = 0;

  for (const [index, filePath] of files.entries()) {
    onProgress?.({ stage: 'analyzing', message: `正在处理 ${basename(filePath)}`, current: index + 1, total: files.length });
    const stats = statSync(filePath);
    const mtime = stats.mtime.toISOString();
    const photoId = idFor(filePath, stats.size, mtime);
    const ext = extname(filePath).toLowerCase();
    const thumbPath = join(cacheDir, 'thumbs', `${photoId}.jpg`);
    const previewPath = join(cacheDir, 'previews', `${photoId}.jpg`);
    const exif = await readExif(filePath);
    const preview = await createPreview(filePath, previewPath, thumbPath);
    if (preview.riskFlags.length) unsupported += 1;
    const analysis = await analyzePhoto(filePath, photoId, preview.status === 'ready' ? previewPath : undefined, preview.riskFlags);

    db.prepare(`
      INSERT OR REPLACE INTO photos (
        id, batch_id, file_path, file_name, file_ext, file_size, file_mtime, shot_at,
        camera_model, lens_model, iso, aperture, focal_length, shutter_speed,
        width, height, thumb_path, preview_path, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      photoId,
      batchId,
      filePath,
      basename(filePath),
      ext,
      stats.size,
      mtime,
      exif.DateTimeOriginal ? new Date(exif.DateTimeOriginal).toISOString() : mtime,
      exif.Model || '',
      exif.LensModel || '',
      exif.ISO || null,
      exif.FNumber || null,
      exif.FocalLength || null,
      exif.ExposureTime ? String(exif.ExposureTime) : '',
      preview.width || null,
      preview.height || null,
      preview.status === 'ready' ? thumbPath : '',
      preview.status === 'ready' ? previewPath : '',
      preview.status,
      now(),
      now()
    );

    db.prepare(`
      INSERT OR REPLACE INTO photo_analysis (
        photo_id, sharpness_score, exposure_score, highlight_clip_ratio, shadow_clip_ratio,
        face_score, eyes_open_score, face_count, final_score, risk_flags,
        face_visibility, eye_state, eye_confidence, left_eye_state, right_eye_state,
        debug_regions,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      photoId,
      analysis.sharpnessScore,
      analysis.exposureScore,
      analysis.highlightClipRatio,
      analysis.shadowClipRatio,
      analysis.faceScore,
      analysis.eyesOpenScore,
      analysis.faceCount,
      analysis.finalScore,
      JSON.stringify(analysis.riskFlags),
      analysis.faceVisibility,
      analysis.eyeState,
      analysis.eyeConfidence,
      analysis.leftEyeState,
      analysis.rightEyeState,
      JSON.stringify(analysis.debugRegions),
      now(),
      now()
    );
  }

  onProgress?.({ stage: 'clustering', message: '正在分组相似照片...', current: files.length, total: files.length });
  const view = getBatch(batchId);
  const clusters = await buildClusters(batchId, view.photos);
  saveClusters(batchId, clusters);
  db.prepare('UPDATE batches SET status = ?, total_photos = ?, processed_photos = ?, updated_at = ? WHERE id = ?').run('ready', files.length, files.length, now(), batchId);
  onProgress?.({ stage: 'done', message: '导入完成', current: files.length, total: files.length });
  return { batchId, imported: files.length, unsupported };
}

export async function importSource(sourcePath: string, onProgress?: (progress: ImportProgress) => void): Promise<ImportResult> {
  const ext = extname(sourcePath).toLowerCase();
  if (ARCHIVE_EXTS.has(ext)) {
    onProgress?.({ stage: 'extracting', message: `正在解压 ${basename(sourcePath)}...` });
    const extractedPath = await extractRarArchive(sourcePath);
    const result = await importFolder(extractedPath, onProgress);
    return {
      ...result,
      sourceType: 'archive',
      extractedPath
    };
  }
  return {
    ...(await importFolder(sourcePath, onProgress)),
    sourceType: 'folder'
  };
}

function saveClusters(batchId: string, clusters: Cluster[]): void {
  const db = getDb();
  db.prepare('DELETE FROM clusters WHERE batch_id = ?').run(batchId);
  db.prepare('DELETE FROM cluster_members WHERE cluster_id LIKE ?').run(`${batchId}-%`);
  const insertCluster = db.prepare('INSERT INTO clusters (id, batch_id, size, best_photo_id, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertMember = db.prepare('INSERT INTO cluster_members (cluster_id, photo_id, rank_in_cluster, similarity_to_best, recommended) VALUES (?, ?, ?, ?, ?)');
  for (const cluster of clusters) {
    insertCluster.run(cluster.id, cluster.batchId, cluster.size, cluster.bestPhotoId || '', cluster.confidence, now(), now());
    for (const member of cluster.members) {
      insertMember.run(cluster.id, member.photoId, member.rank, member.similarityToBest, member.recommended ? 1 : 0);
    }
  }
}

export function listBatches(): Array<{ id: string; name: string; status: string; totalPhotos: number; createdAt: string }> {
  return getDb()
    .prepare('SELECT id, name, status, total_photos as totalPhotos, created_at as createdAt FROM batches ORDER BY created_at DESC')
    .all() as Array<{ id: string; name: string; status: string; totalPhotos: number; createdAt: string }>;
}

export async function rebuildClusters(batchId: string): Promise<BatchView> {
  const view = getBatch(batchId);
  const clusters = await buildClusters(batchId, view.photos);
  saveClusters(batchId, clusters);
  return getBatch(batchId);
}

export function deleteBatch(batchId: string, deleteOriginals = false): DeleteBatchResult {
  const db = getDb();
  const clusterIds = db.prepare('SELECT id FROM clusters WHERE batch_id = ?').all(batchId) as Array<{ id: string }>;
  const photos = db.prepare('SELECT file_path as filePath FROM photos WHERE batch_id = ?').all(batchId) as Array<{ filePath: string }>;
  let deletedOriginals = 0;
  let failedOriginals = 0;

  if (deleteOriginals) {
    const paths = Array.from(new Set(photos.map((photo) => photo.filePath).filter(Boolean)));
    for (const filePath of paths) {
      try {
        if (existsSync(filePath) && statSync(filePath).isFile()) {
          rmSync(filePath, { force: true });
          deletedOriginals += 1;
        }
      } catch {
        failedOriginals += 1;
      }
    }
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM semantic_analysis WHERE photo_id IN (SELECT id FROM photos WHERE batch_id = ?)').run(batchId);
    db.prepare('DELETE FROM decisions WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM photo_analysis WHERE photo_id IN (SELECT id FROM photos WHERE batch_id = ?)').run(batchId);
    for (const cluster of clusterIds) db.prepare('DELETE FROM cluster_members WHERE cluster_id = ?').run(cluster.id);
    db.prepare('DELETE FROM clusters WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM photos WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM batches WHERE id = ?').run(batchId);
  });
  tx();
  rmSync(join(app.getPath('userData'), 'senseframe-cache', batchId), { recursive: true, force: true });
  return { deletedOriginals, failedOriginals };
}

export function getBatch(batchId: string): BatchView {
  const db = getDb();
  const batch = db.prepare('SELECT id, name, root_path as rootPath, status, total_photos as totalPhotos, processed_photos as processedPhotos, created_at as createdAt FROM batches WHERE id = ?').get(batchId) as any;
  const photos = db.prepare(`
    SELECT p.*, d.decision, d.rating, cm.cluster_id as clusterId, cm.rank_in_cluster as rankInCluster, cm.recommended
    FROM photos p
    LEFT JOIN decisions d ON d.photo_id = p.id
    LEFT JOIN cluster_members cm ON cm.photo_id = p.id
    WHERE p.batch_id = ?
    ORDER BY COALESCE(p.shot_at, p.file_name)
  `).all(batchId) as any[];
  const analyses = db.prepare('SELECT * FROM photo_analysis WHERE photo_id IN (SELECT id FROM photos WHERE batch_id = ?)').all(batchId) as any[];
  const semantics = db.prepare('SELECT * FROM semantic_analysis WHERE photo_id IN (SELECT id FROM photos WHERE batch_id = ?)').all(batchId) as any[];
  const analysisById = new Map(analyses.map((row) => [row.photo_id, row]));
  const semanticById = new Map(semantics.map((row) => [row.photo_id, row]));
  const clusters = db.prepare('SELECT id, batch_id as batchId, size, best_photo_id as bestPhotoId, confidence FROM clusters WHERE batch_id = ? ORDER BY id').all(batchId) as any[];
  const members = db.prepare('SELECT cluster_id as clusterId, photo_id as photoId, rank_in_cluster as rank, similarity_to_best as similarityToBest, recommended FROM cluster_members WHERE cluster_id LIKE ?').all(`${batchId}-%`) as any[];
  const membersByCluster = new Map<string, any[]>();
  for (const member of members) membersByCluster.set(member.clusterId, [...(membersByCluster.get(member.clusterId) || []), { ...member, recommended: Boolean(member.recommended) }]);

  return {
    ...batch,
    photos: photos.map((row) => {
      const analysis = analysisById.get(row.id);
      const semantic = semanticById.get(row.id);
      return {
        id: row.id,
        batchId: row.batch_id,
        filePath: row.file_path,
        fileName: row.file_name,
        fileExt: row.file_ext,
        fileSize: row.file_size,
        shotAt: row.shot_at,
        cameraModel: row.camera_model,
        lensModel: row.lens_model,
        iso: row.iso,
        aperture: row.aperture,
        focalLength: row.focal_length,
        shutterSpeed: row.shutter_speed,
        width: row.width,
        height: row.height,
        thumbPath: row.thumb_path,
        previewPath: row.preview_path,
        status: row.status,
        decision: row.decision || 'none',
        rating: row.rating || undefined,
        clusterId: row.clusterId,
        rankInCluster: row.rankInCluster,
        recommended: Boolean(row.recommended),
        analysis: analysis
          ? {
              photoId: analysis.photo_id,
              sharpnessScore: analysis.sharpness_score,
              exposureScore: analysis.exposure_score,
              highlightClipRatio: analysis.highlight_clip_ratio,
              shadowClipRatio: analysis.shadow_clip_ratio,
              faceScore: analysis.face_score,
              eyesOpenScore: analysis.eyes_open_score,
              faceVisibility: analysis.face_visibility || 'unknown',
              eyeState: analysis.eye_state || 'unknown',
              eyeConfidence: analysis.eye_confidence || 0,
              leftEyeState: analysis.left_eye_state || 'missing',
              rightEyeState: analysis.right_eye_state || 'missing',
              debugRegions: JSON.parse(analysis.debug_regions || '[]'),
              faceCount: analysis.face_count,
              finalScore: analysis.final_score,
              riskFlags: JSON.parse(analysis.risk_flags || '[]')
            }
          : undefined,
        semantic: semantic
          ? {
              photoId: semantic.photo_id,
              scene: semantic.scene,
              subjects: JSON.parse(semantic.subjects),
              emotion: JSON.parse(semantic.emotion),
              usage: JSON.parse(semantic.usage),
              composition: semantic.composition,
              caption: semantic.caption,
              recommendationReason: semantic.recommendation_reason,
              llmScore: JSON.parse(semantic.llm_score),
              model: semantic.model,
              isMock: Boolean(semantic.is_mock)
            }
          : undefined
      } satisfies PhotoView;
    }),
    clusters: clusters.map((cluster) => ({
      ...cluster,
      members: membersByCluster.get(cluster.id) || []
    }))
  };
}

export function saveDecision(photoId: string, batchId: string, decision: string, rating?: number): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO decisions (photo_id, batch_id, decision, rating, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(photoId, batchId, decision, rating || null, now());
}

export function workerHint(): string {
  return pythonSetupHint();
}
