import crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { getDb } from './db';
import { getModelConfig, type ModelConfig } from './brainRuntime/modelProvider';
import { photoAestheticPrompt } from './brainRuntime/photoAestheticRubric';
import { getBatch } from './photoPipeline';
import type {
  BatchView,
  BrainBucket,
  BrainPhotoReview,
  BrainProgressEvent,
  BrainRunRequest,
  BrainRunResult,
  BrainRunScope,
  BrainVisualScores,
  Cluster,
  Decision,
  PhotoView
} from '../shared/types';

const BRAIN_BUCKETS: BrainBucket[] = ['featured', 'closedEyes', 'eyeReview', 'subject', 'technical', 'duplicates', 'similarBursts', 'pending'];

type RawBrainReview = {
  primary_bucket?: string;
  secondary_buckets?: unknown[];
  confidence?: number;
  recommended_action?: string;
  reason?: string;
  small_model_overrides?: unknown[];
  needs_human_review?: boolean;
  visual_scores?: Partial<Record<keyof BrainVisualScores, number>>;
  deliverable_score?: number;
  deliverableScore?: number;
  aesthetic_pass?: boolean;
  aestheticPass?: boolean;
  aesthetic_reject_reasons?: unknown[];
  aestheticRejectReasons?: unknown[];
  fatal_flaws?: unknown[];
  fatalFlaws?: unknown[];
  composition_tags?: unknown[];
  compositionTags?: unknown[];
  representative_rank?: number;
  group_reason?: string;
};

export type BatchContext = {
  batch: BatchView;
  groupByPhoto: Map<string, { groupId: string; groupType: 'duplicates' | 'similarBursts'; rank: number; size: number; recommended: boolean }>;
  initialBucketCounts: Partial<Record<BrainBucket, number>>;
  inputSnapshot: {
    totalPhotos: number;
    readyPhotos: number;
    decisions: Record<Decision, number>;
    riskFlags: Record<string, number>;
    initialBucketCounts: Partial<Record<BrainBucket, number>>;
    duplicateGroups: number;
  };
};

type BrainPlan = {
  summary: string;
  focusMode?: string;
  activePhotoId?: string;
  visionPhotoIds: Set<string>;
  skippedPhotoIds: Set<string>;
  duplicateGroups: Array<{ groupId: string; members: PhotoView[] }>;
};

function now(): string {
  return new Date().toISOString();
}

function debugDir(): string {
  const dir = join(app.getPath('userData'), 'senseframe', 'brain-debug');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionDir(): string {
  const dir = join(app.getPath('userData'), 'senseframe', 'brain-sessions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function saveEvent(runId: string, eventType: string, message: string, payload?: unknown): void {
  getDb()
    .prepare('INSERT INTO brain_events (id, run_id, event_type, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), runId, eventType, message, payload ? JSON.stringify(payload) : null, now());
}

function writeDebug(runId: string, line: string): string {
  const path = join(debugDir(), `${runId}.log`);
  writeFileSync(path, `${line}\n`, { flag: 'a' });
  return path;
}

function createRun(batchId: string, scope: BrainRunScope, config: ModelConfig): { runId: string; debugLogPath: string } {
  const runId = crypto.randomUUID();
  const debugLogPath = writeDebug(runId, `[${now()}] 小宫审片开始 batch=${batchId} scope=${scope} model=${config.model}`);
  getDb()
    .prepare(`
      INSERT INTO brain_runs (id, batch_id, scope, status, model, debug_log_path, reviewed_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(runId, batchId, scope, 'running', config.model, debugLogPath, 0, now(), now());
  saveEvent(runId, 'run.started', '小宫审片开始', { batchId, scope, model: config.model });
  return { runId, debugLogPath };
}

function updateRunContext(runId: string, plan: BrainPlan, context: BatchContext): void {
  const strategy = {
    summary: plan.summary,
    focusMode: plan.focusMode,
    activePhotoId: plan.activePhotoId,
    visionPhotoCount: plan.visionPhotoIds.size,
    skippedPhotoCount: plan.skippedPhotoIds.size,
    duplicateGroupCount: plan.duplicateGroups.length
  };
  getDb()
    .prepare('UPDATE brain_runs SET strategy_json = ?, input_snapshot_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(strategy), JSON.stringify(context.inputSnapshot), now(), runId);
}

function finishRun(runId: string, status: 'completed' | 'failed', reviewed: number, summary: string, bucketCounts: Partial<Record<BrainBucket, number>>, error?: string): void {
  getDb()
    .prepare('UPDATE brain_runs SET status = ?, reviewed_count = ?, summary = ?, bucket_counts_json = ?, error = ?, updated_at = ? WHERE id = ?')
    .run(status, reviewed, summary, JSON.stringify(bucketCounts), error || null, now(), runId);
  saveEvent(runId, status === 'completed' ? 'run.completed' : 'run.failed', status === 'completed' ? summary : error || '小宫审片失败', { reviewed, bucketCounts });
}

function emitProgress(
  emit: ((event: BrainProgressEvent) => void) | undefined,
  runId: string,
  request: BrainRunRequest,
  debugLogPath: string,
  event: Omit<BrainProgressEvent, 'runId' | 'batchId' | 'scope' | 'debugLogPath'>
): void {
  emit?.({
    runId,
    batchId: request.batchId,
    scope: request.scope,
    debugLogPath,
    ...event
  });
}

function mimeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function imageDataUrl(photo: PhotoView): string {
  if (!photo.previewPath) throw new Error(`${photo.fileName} 没有可用 preview，不能让大脑真实看图。`);
  const image = readFileSync(photo.previewPath);
  return `data:${mimeFor(photo.previewPath)};base64,${image.toString('base64')}`;
}

function localPhotoContext(photo: PhotoView): string {
  const analysis = photo.analysis;
  return [
    `file=${photo.fileName}`,
    `decision=${photo.decision}`,
    `rating=${photo.rating || 'none'}`,
    `final_score=${analysis?.finalScore ?? 'unknown'}`,
    `sharpness=${analysis?.sharpnessScore ?? 'unknown'}`,
    `exposure=${analysis?.exposureScore ?? 'unknown'}`,
    `face_score=${analysis?.faceScore ?? 'unknown'}`,
    `face_visibility=${analysis?.faceVisibility ?? 'unknown'}`,
    `eye_state=${analysis?.eyeState ?? 'unknown'}`,
    `eye_confidence=${analysis?.eyeConfidence ?? 'unknown'}`,
    `risk_flags=${analysis?.riskFlags.join(',') || 'none'}`,
    `semantic_caption=${photo.semantic?.caption || 'none'}`,
    `semantic_reason=${photo.semantic?.recommendationReason || 'none'}`
  ].join('\n');
}

function clamp01(value: unknown, fallback = 0.5): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function normalizeBucket(value: unknown, fallback: BrainBucket): BrainBucket {
  return BRAIN_BUCKETS.includes(value as BrainBucket) ? value as BrainBucket : fallback;
}

function formatModelListItem(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';

  const item = value as Record<string, unknown>;
  const subject = item.flag || item.source || item.from || item.field || item.model || item.type;
  const override = item.override || item.to || item.result || item.action || item.decision;
  const reason = item.reason || item.why || item.note;
  const parts = [subject, override, reason].filter((part) => part !== undefined && part !== null && String(part).trim());
  if (parts.length) return parts.map(String).join('：');

  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(formatModelListItem).filter((item) => item.length > 0);
}

function normalizeAction(value: unknown): Decision | 'review' {
  return value === 'pick' || value === 'reject' || value === 'maybe' || value === 'none' || value === 'review' ? value : 'review';
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
  if (photo.rating) score += Math.min(0.14, photo.rating * 0.025);
  return Math.max(0, Math.min(1, score));
}

function defaultBucket(photo: PhotoView, group?: { groupType: 'duplicates' | 'similarBursts'; rank: number; recommended: boolean }): BrainBucket {
  const flags = new Set(photo.analysis?.riskFlags || []);
  if (photo.decision === 'pick') return 'featured';
  if (photo.status !== 'ready' || flags.has('unsupported_preview') || flags.has('raw_decode_failed') || flags.has('heic_decode_failed')) return 'technical';
  if (flags.has('closed_eyes')) return 'closedEyes';
  if (flags.has('eyes_uncertain')) return 'eyeReview';
  if (flags.has('subject_cropped') || flags.has('subject_cropped_severe') || flags.has('subject_cropped_mild') || flags.has('weak_subject')) return 'subject';
  if (flags.has('possible_blur') || flags.has('bad_exposure') || flags.has('face_blur')) return 'technical';
  if (group && !group.recommended && group.rank > 1) return group.groupType;
  if (reviewScore(photo) >= 0.7) return 'featured';
  return 'pending';
}

function defaultAction(bucket: BrainBucket, photo: PhotoView): Decision | 'review' {
  if (photo.decision === 'pick') return 'none';
  if (bucket === 'featured') return 'pick';
  if (bucket === 'pending' || bucket === 'eyeReview') return 'review';
  if (bucket === 'duplicates') return 'maybe';
  return reviewScore(photo) < 0.38 ? 'reject' : 'maybe';
}

function normalizeScores(input?: RawBrainReview['visual_scores'], photo?: PhotoView): BrainVisualScores {
  const fallback = photo ? reviewScore(photo) : 0.5;
  return {
    visualQuality: clamp01(input?.visualQuality, fallback),
    expression: clamp01(input?.expression, fallback),
    moment: clamp01(input?.moment, fallback),
    composition: clamp01(input?.composition, fallback),
    backgroundCleanliness: clamp01(input?.backgroundCleanliness, fallback),
    storyValue: clamp01(input?.storyValue, fallback),
    lighting: input?.lighting === undefined ? undefined : clamp01(input.lighting, fallback),
    subjectClarity: input?.subjectClarity === undefined ? undefined : clamp01(input.subjectClarity, fallback),
    finish: input?.finish === undefined ? undefined : clamp01(input.finish, fallback),
    deliverableScore: input?.deliverableScore === undefined ? undefined : clamp01(input.deliverableScore, fallback)
  };
}

export function parseReview(text: string, photo: PhotoView, fallbackBucket: BrainBucket): Omit<BrainPhotoReview, 'photoId' | 'runId' | 'model' | 'createdAt'> {
  const jsonText = text.trim().startsWith('{') ? text.trim() : text.match(/\{[\s\S]*\}/)?.[0] || '{}';
  const raw = JSON.parse(jsonText) as RawBrainReview;
  const bucket = normalizeBucket(raw.primary_bucket, fallbackBucket);
  const visualScores = normalizeScores({
    ...(raw.visual_scores || {}),
    deliverableScore: raw.deliverableScore ?? raw.deliverable_score ?? raw.visual_scores?.deliverableScore
  }, photo);
  return {
    primaryBucket: bucket,
    secondaryBuckets: Array.isArray(raw.secondary_buckets)
      ? raw.secondary_buckets.map((item) => normalizeBucket(item, fallbackBucket)).filter((item, index, array) => array.indexOf(item) === index)
      : [],
    confidence: clamp01(raw.confidence, 0.62),
    recommendedAction: normalizeAction(raw.recommended_action),
    reason: String(raw.reason || '大脑没有返回明确理由。'),
    smallModelOverrides: normalizeTextList(raw.small_model_overrides),
    needsHumanReview: Boolean(raw.needs_human_review),
    visualScores,
    aestheticPass: typeof raw.aesthetic_pass === 'boolean' ? raw.aesthetic_pass : typeof raw.aestheticPass === 'boolean' ? raw.aestheticPass : undefined,
    aestheticRejectReasons: normalizeTextList(raw.aesthetic_reject_reasons || raw.aestheticRejectReasons),
    fatalFlaws: normalizeTextList(raw.fatal_flaws || raw.fatalFlaws),
    compositionTags: normalizeTextList(raw.composition_tags || raw.compositionTags),
    representativeRank: typeof raw.representative_rank === 'number' ? raw.representative_rank : undefined,
    groupReason: raw.group_reason ? String(raw.group_reason) : undefined
  };
}

export function buildBatchContext(batchId: string): BatchContext {
  const batch = getBatch(batchId);
  const groupByPhoto = new Map<string, { groupId: string; groupType: 'duplicates' | 'similarBursts'; rank: number; size: number; recommended: boolean }>();
  for (const cluster of batch.clusters) {
    if (cluster.size <= 1) continue;
    for (const member of cluster.members) {
      groupByPhoto.set(member.photoId, {
        groupId: cluster.id,
        groupType: 'duplicates',
        rank: member.rank,
        size: cluster.size,
        recommended: member.recommended
      });
    }
  }

  const numberSorted = [...batch.photos]
    .map((photo) => ({ photo, num: Number(photo.fileName.match(/(\d+)/)?.[1] || 0) }))
    .filter(({ num }) => num > 0)
    .sort((a, b) => a.num - b.num);
  let burstIndex = 0;
  for (let i = 0; i < numberSorted.length; ) {
    const members = [numberSorted[i]];
    let j = i + 1;
    while (j < numberSorted.length && numberSorted[j].num - numberSorted[j - 1].num <= 2) {
      members.push(numberSorted[j]);
      j += 1;
    }
    if (members.length >= 3) {
      burstIndex += 1;
      members.forEach((item, memberIndex) => {
        groupByPhoto.set(item.photo.id, {
          groupId: `burst-${burstIndex}`,
          groupType: 'similarBursts',
          rank: memberIndex + 1,
          size: members.length,
          recommended: memberIndex === 0
        });
      });
    }
    i = j;
  }

  const decisions: Record<Decision, number> = { none: 0, pick: 0, reject: 0, maybe: 0 };
  const riskFlags: Record<string, number> = {};
  const initialBucketCounts: Partial<Record<BrainBucket, number>> = {};
  let readyPhotos = 0;
  for (const photo of batch.photos) {
    if (photo.status === 'ready') readyPhotos += 1;
    decisions[photo.decision] += 1;
    for (const flag of photo.analysis?.riskFlags || []) riskFlags[flag] = (riskFlags[flag] || 0) + 1;
    const bucket = defaultBucket(photo, groupByPhoto.get(photo.id));
    initialBucketCounts[bucket] = (initialBucketCounts[bucket] || 0) + 1;
  }

  return {
    batch,
    groupByPhoto,
    initialBucketCounts,
    inputSnapshot: {
      totalPhotos: batch.photos.length,
      readyPhotos,
      decisions,
      riskFlags,
      initialBucketCounts,
      duplicateGroups: batch.clusters.filter((cluster) => cluster.size > 1).length
    }
  };
}

function shouldReviewWithVision(photo: PhotoView, context: BatchContext, request: BrainRunRequest): boolean {
  if (!photo.previewPath || photo.status !== 'ready') return false;
  if (request.scope === 'photo') return request.activePhotoId === photo.id;
  if (request.scope === 'group') {
    const targetGroup = request.focusMode?.startsWith('compare_group:') ? request.focusMode.slice('compare_group:'.length) : undefined;
    const group = context.groupByPhoto.get(photo.id);
    if (!group) return false;
    if (targetGroup && targetGroup !== 'current' && group.groupId !== targetGroup) return false;
    if (request.activePhotoId) {
      const activeGroup = context.groupByPhoto.get(request.activePhotoId);
      if (targetGroup === 'current' && activeGroup && group.groupId !== activeGroup.groupId) return false;
    }
    return group.rank <= 6;
  }
  if (request.activePhotoId === photo.id) return true;
  if (photo.decision === 'pick') return true;

  const flags = new Set(photo.analysis?.riskFlags || []);
  const group = context.groupByPhoto.get(photo.id);
  if (group && group.rank <= 3) return true;
  if (reviewScore(photo) >= 0.68) return true;
  if (flags.has('closed_eyes') || flags.has('eyes_uncertain') || flags.has('face_missing') || flags.has('weak_subject')) return true;
  if (flags.has('subject_cropped') || flags.has('possible_blur') || flags.has('bad_exposure')) return reviewScore(photo) >= 0.42;
  return false;
}

function buildPlan(context: BatchContext, request: BrainRunRequest): BrainPlan {
  const visionPhotoIds = new Set<string>();
  const skippedPhotoIds = new Set<string>();
  for (const photo of context.batch.photos) {
    if (shouldReviewWithVision(photo, context, request)) visionPhotoIds.add(photo.id);
    else skippedPhotoIds.add(photo.id);
  }

  const byId = new Map(context.batch.photos.map((photo) => [photo.id, photo]));
  const duplicateGroups = context.batch.clusters
    .filter((cluster) => cluster.size > 1)
    .filter((cluster) => {
      if (request.scope !== 'group') return true;
      const targetGroup = request.focusMode?.startsWith('compare_group:') ? request.focusMode.slice('compare_group:'.length) : undefined;
      if (targetGroup && targetGroup !== 'current') return cluster.id === targetGroup;
      if (!request.activePhotoId) return true;
      return cluster.members.some((member) => member.photoId === request.activePhotoId);
    })
    .map((cluster) => ({
      groupId: cluster.id,
      members: cluster.members
        .map((member) => byId.get(member.photoId))
        .filter((photo): photo is PhotoView => Boolean(photo))
    }));

  return {
    summary: `整批审片：先用小模型结构扫描 ${context.batch.photos.length} 张，再重点看图 ${visionPhotoIds.size} 张，比较近重复组 ${duplicateGroups.length} 个。`,
    focusMode: request.focusMode,
    activePhotoId: request.activePhotoId,
    visionPhotoIds,
    skippedPhotoIds,
    duplicateGroups
  };
}

export function createHeuristicReview(photo: PhotoView, runId: string, model: string, context: BatchContext): BrainPhotoReview {
  const group = context.groupByPhoto.get(photo.id);
  const bucket = defaultBucket(photo, group);
  const score = reviewScore(photo);
  const needsHumanReview = bucket === 'pending' || bucket === 'eyeReview' || photo.decision === 'maybe';
  const flags = photo.analysis?.riskFlags || [];
  const reasonParts = [
    group ? `${group.groupType === 'duplicates' ? '近重复组' : '相似连拍'}第 ${group.rank}/${group.size}` : '',
    flags.length ? `小模型风险：${flags.join(', ')}` : '',
    `本地综合分 ${Math.round(score * 100)}`
  ].filter(Boolean);

  return {
    photoId: photo.id,
    runId,
    primaryBucket: bucket,
    secondaryBuckets: [],
    confidence: bucket === 'pending' || needsHumanReview ? 0.58 : 0.72,
    recommendedAction: defaultAction(bucket, photo),
    reason: reasonParts.length ? reasonParts.join('；') : '小模型结果稳定，暂按批次级规则归入当前桶位。',
    smallModelOverrides: [],
    needsHumanReview,
    visualScores: normalizeScores(undefined, photo),
    representativeRank: group?.rank,
    groupId: group?.groupId,
    groupRank: group?.rank,
    groupRole: group ? (group.recommended || group.rank === 1 ? 'representative' : 'backup') : 'single',
    groupReason: group ? `${group.groupType === 'duplicates' ? '近重复组' : '相似连拍'}内按小模型推荐、清晰度和人工选择生成初始排序。` : undefined,
    model,
    createdAt: now()
  };
}

export async function callVisionModel(config: ModelConfig, photo: PhotoView, scope: BrainRunScope, context: BatchContext): Promise<string> {
  const group = context.groupByPhoto.get(photo.id);
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是 SenseFrame 内部的小宫审片大脑。你的任务是专业摄影审片分组：真实看图，结合小模型和批次上下文，给出最终 AI 桶位。输出只能是 JSON。',
            photoAestheticPrompt()
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `运行范围: ${scope}`,
                `批次: ${context.batch.name}，总照片 ${context.batch.photos.length} 张，近重复组 ${context.inputSnapshot.duplicateGroups} 个。`,
                `当前照片组信息: ${group ? `${group.groupType} ${group.groupId} 第 ${group.rank}/${group.size}` : '无'}`,
                '请判断这张照片最终应该进入 SenseFrame 哪个 AI 分组。',
                '允许的 primary_bucket/secondary_buckets: featured, closedEyes, eyeReview, subject, technical, duplicates, similarBursts, pending。',
                'recommended_action 只能是 pick/reject/maybe/review/none。',
                '不要固定精选数量。不要把 closed_eyes/face_missing/low_score 机械等同废片。',
                '如果小模型明显误判，请写入 small_model_overrides。',
                '如果信息不足、需要摄影师偏好、或需要和组内其它图二次比较，请 needs_human_review=true。',
                'visual_scores 使用 0-1 数值，字段: visualQuality, expression, moment, composition, backgroundCleanliness, storyValue。',
                '返回 JSON keys: primary_bucket, secondary_buckets, confidence, recommended_action, reason, small_model_overrides, needs_human_review, visual_scores, aesthetic_pass, aesthetic_reject_reasons, fatal_flaws, composition_tags, representative_rank, group_reason。',
                '',
                '本地小模型和人工上下文:',
                localPhotoContext(photo)
              ].join('\n')
            },
            {
              type: 'image_url',
              image_url: { url: imageDataUrl(photo), detail: 'high' }
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`大脑模型请求失败：${response.status} ${body.slice(0, 1200)}`);
  }
  const data = await response.json() as any;
  return String(data.choices?.[0]?.message?.content || '{}');
}

export function saveReview(review: BrainPhotoReview, batchId: string): void {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO brain_bucket_assignments (
        photo_id, run_id, batch_id, primary_bucket, secondary_buckets, confidence,
        recommended_action, reason, small_model_overrides, needs_human_review,
        visual_scores, representative_rank, group_reason, group_id, group_rank, group_role,
        review_source, sheet_id, sheet_cell, aesthetic_pass, aesthetic_reject_reasons,
        fatal_flaws, composition_tags, model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      review.photoId,
      review.runId,
      batchId,
      review.primaryBucket,
      JSON.stringify(review.secondaryBuckets),
      review.confidence,
      review.recommendedAction,
      review.reason,
      JSON.stringify(review.smallModelOverrides),
      review.needsHumanReview ? 1 : 0,
      JSON.stringify(review.visualScores),
      review.representativeRank || null,
      review.groupReason || null,
      review.groupId || null,
      review.groupRank || null,
      review.groupRole || null,
      review.reviewSource || 'single_vision',
      review.sheetId || null,
      review.sheetCell || null,
      review.aestheticPass === undefined ? null : review.aestheticPass ? 1 : 0,
      JSON.stringify(review.aestheticRejectReasons || []),
      JSON.stringify(review.fatalFlaws || []),
      JSON.stringify(review.compositionTags || []),
      review.model,
      review.createdAt,
      now()
    );
}

function rankDuplicateGroups(runId: string, batchId: string, context: BatchContext, reviewsByPhoto: Map<string, BrainPhotoReview>): void {
  const db = getDb();
  db.prepare('DELETE FROM brain_group_rankings WHERE run_id = ?').run(runId);
  const groups = new Map<string, { groupType: 'duplicates' | 'similarBursts'; photos: PhotoView[] }>();
  for (const photo of context.batch.photos) {
    const group = context.groupByPhoto.get(photo.id);
    if (!group) continue;
    const entry = groups.get(group.groupId) || { groupType: group.groupType, photos: [] as PhotoView[] };
    entry.photos.push(photo);
    groups.set(group.groupId, entry);
  }

  for (const [groupId, group] of groups.entries()) {
    const photos = group.photos.sort((a, b) => {
      const aReview = reviewsByPhoto.get(a.id);
      const bReview = reviewsByPhoto.get(b.id);
      const aBoost = a.decision === 'pick' ? 0.25 : 0;
      const bBoost = b.decision === 'pick' ? 0.25 : 0;
      return (bReview?.confidence || 0) + reviewScore(b) + bBoost - ((aReview?.confidence || 0) + reviewScore(a) + aBoost);
    });

    photos.forEach((photo, index) => {
      const review = reviewsByPhoto.get(photo.id);
      if (!review) return;
      review.groupId = groupId;
      review.groupRank = index + 1;
      review.groupRole = index === 0 ? 'representative' : index <= 2 ? 'backup' : 'rejected';
      review.representativeRank = index + 1;
      review.groupReason = index === 0
        ? `大脑综合画面分、小模型分数和人工选择，将这张作为${group.groupType === 'duplicates' ? '近重复组' : '相似连拍'}代表图。`
        : `${group.groupType === 'duplicates' ? '近重复组' : '相似连拍'}备选排序第 ${index + 1}，建议优先和代表图比较后再决定。`;
      if (index > 0 && photo.decision !== 'pick') {
        review.primaryBucket = group.groupType;
        review.recommendedAction = index <= 2 ? 'maybe' : 'reject';
        review.needsHumanReview = index <= 2;
      }
      saveReview(review, batchId);
      db.prepare(`
        INSERT INTO brain_group_rankings (id, run_id, batch_id, group_type, group_key, photo_id, rank, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        runId,
        batchId,
        group.groupType,
        groupId,
        photo.id,
        index + 1,
        review.groupReason,
        now(),
        now()
      );
    });
  }
}

export function bucketCounts(reviews: BrainPhotoReview[]): Partial<Record<BrainBucket, number>> {
  const counts: Partial<Record<BrainBucket, number>> = {};
  for (const review of reviews) counts[review.primaryBucket] = (counts[review.primaryBucket] || 0) + 1;
  return counts;
}

export async function startBrainReview(request: BrainRunRequest, onProgress?: (event: BrainProgressEvent) => void): Promise<BrainRunResult> {
  const config = getModelConfig();
  const scope: BrainRunScope = request.scope || 'batch';
  const normalizedRequest: BrainRunRequest = { ...request, scope };
  const { runId, debugLogPath } = createRun(request.batchId, scope, config);
  const reviewsByPhoto = new Map<string, BrainPhotoReview>();
  const emit = onProgress;
  let context: BatchContext | undefined;
  let plan: BrainPlan | undefined;
  let failures = 0;

  try {
    sessionDir();
    emitProgress(emit, runId, normalizedRequest, debugLogPath, {
      status: 'running',
      phase: 'context',
      message: '正在读取整批照片、小模型结果、人工选择和相似组...',
      current: 0,
      total: 0
    });
    context = buildBatchContext(request.batchId);
    if (!context.batch.photos.length) throw new Error('当前批次没有可审片的照片。');
    writeDebug(runId, `[${now()}] input snapshot\n${JSON.stringify(context.inputSnapshot, null, 2)}`);

    emitProgress(emit, runId, normalizedRequest, debugLogPath, {
      status: 'running',
      phase: 'planning',
      message: '正在制定整批审片计划：选择需要真实看图和组内比较的照片...',
      current: 0,
      total: context.batch.photos.length
    });
    plan = buildPlan(context, normalizedRequest);
    updateRunContext(runId, plan, context);
    writeDebug(runId, `[${now()}] plan\n${JSON.stringify({
      summary: plan.summary,
      focusMode: plan.focusMode,
      activePhotoId: plan.activePhotoId,
      visionPhotoIds: [...plan.visionPhotoIds],
      skippedPhotoIds: [...plan.skippedPhotoIds],
      duplicateGroups: plan.duplicateGroups.map((group) => ({ groupId: group.groupId, size: group.members.length }))
    }, null, 2)}`);

    getDb().prepare('DELETE FROM brain_bucket_assignments WHERE batch_id = ?').run(request.batchId);
    for (const photo of context.batch.photos) {
      const review = createHeuristicReview(photo, runId, config.model, context);
      reviewsByPhoto.set(photo.id, review);
    }

    const visionPhotos = context.batch.photos.filter((photo) => plan?.visionPhotoIds.has(photo.id));
    for (const [index, photo] of visionPhotos.entries()) {
      emitProgress(emit, runId, normalizedRequest, debugLogPath, {
        status: 'running',
        phase: 'photo_started',
        message: `正在真实看图 ${photo.fileName}`,
        current: index,
        total: visionPhotos.length,
        photoId: photo.id,
        fileName: photo.fileName
      });
      saveEvent(runId, 'photo.started', `开始审片 ${photo.fileName}`, { photoId: photo.id });
      writeDebug(runId, `[${now()}] vision review photo=${photo.fileName} id=${photo.id}`);

      try {
        const text = await callVisionModel(config, photo, scope, context);
        writeDebug(runId, `[${now()}] model response photo=${photo.fileName}\n${text}`);
        const current = reviewsByPhoto.get(photo.id);
        const parsed = parseReview(text, photo, current?.primaryBucket || defaultBucket(photo, context.groupByPhoto.get(photo.id)));
        const review: BrainPhotoReview = {
          photoId: photo.id,
          runId,
          model: config.model,
          createdAt: now(),
          groupId: current?.groupId,
          groupRank: current?.groupRank,
          groupRole: current?.groupRole,
          ...parsed
        };
        reviewsByPhoto.set(photo.id, review);
        saveEvent(runId, 'photo.completed', `完成审片 ${photo.fileName}`, { photoId: photo.id, primaryBucket: review.primaryBucket });
        emitProgress(emit, runId, normalizedRequest, debugLogPath, {
          status: 'running',
          phase: 'photo_completed',
          message: `完成 ${photo.fileName} -> ${review.primaryBucket}`,
          current: index + 1,
          total: visionPhotos.length,
          photoId: photo.id,
          fileName: photo.fileName
        });
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        const fallback = reviewsByPhoto.get(photo.id);
        if (fallback) {
          fallback.needsHumanReview = true;
          fallback.smallModelOverrides = [...fallback.smallModelOverrides, `视觉复核失败：${message.slice(0, 180)}`];
          fallback.reason = `${fallback.reason}；视觉模型失败，保留小模型初始判断并要求人工复核。`;
          reviewsByPhoto.set(photo.id, fallback);
        }
        saveEvent(runId, 'photo.failed', `审片失败 ${photo.fileName}`, { photoId: photo.id, error: message });
        writeDebug(runId, `[${now()}] photo failed ${photo.fileName}: ${message}`);
      }
    }

    emitProgress(emit, runId, normalizedRequest, debugLogPath, {
      status: 'running',
      phase: 'group_started',
      message: `正在比较近重复组：${plan.duplicateGroups.length} 组`,
      current: 0,
      total: plan.duplicateGroups.length
    });
    rankDuplicateGroups(runId, request.batchId, context, reviewsByPhoto);
    emitProgress(emit, runId, normalizedRequest, debugLogPath, {
      status: 'running',
      phase: 'group_completed',
      message: `近重复组比较完成：${plan.duplicateGroups.length} 组`,
      current: plan.duplicateGroups.length,
      total: plan.duplicateGroups.length
    });

    emitProgress(emit, runId, normalizedRequest, debugLogPath, {
      status: 'running',
      phase: 'persisting',
      message: '正在写入整批大脑分组状态...',
      current: 0,
      total: context.batch.photos.length
    });
    for (const review of reviewsByPhoto.values()) saveReview(review, request.batchId);

    const reviews = [...reviewsByPhoto.values()];
    const counts = bucketCounts(reviews);
    const summary = [
      `小宫已完成整批审片：${context.batch.photos.length} 张照片。`,
      `真实看图 ${visionPhotos.length - failures}/${visionPhotos.length} 张，近重复组 ${plan.duplicateGroups.length} 个。`,
      `精选候选 ${counts.featured || 0}，待判断 ${counts.pending || 0}，需要人工复核 ${reviews.filter((review) => review.needsHumanReview).length}。`
    ].join(' ');
    finishRun(runId, 'completed', reviews.length, summary, counts);
    writeDebug(runId, `[${now()}] completed\nsummary=${summary}\ncounts=${JSON.stringify(counts)}`);
    emitProgress(emit, runId, normalizedRequest, debugLogPath, {
      status: 'completed',
      phase: 'completed',
      message: summary,
      current: reviews.length,
      total: context.batch.photos.length
    });
    return {
      runId,
      status: 'completed',
      batchId: request.batchId,
      scope,
      reviewed: reviews.length,
      message: summary,
      summary,
      strategy: plan.summary,
      bucketCounts: counts,
      debugLogPath,
      reviews
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reviews = [...reviewsByPhoto.values()];
    const counts = bucketCounts(reviews);
    finishRun(runId, 'failed', reviews.length, '小宫审片失败', counts, message);
    writeDebug(runId, `[${now()}] failed ${message}`);
    emitProgress(emit, runId, normalizedRequest, debugLogPath, {
      status: 'failed',
      phase: 'failed',
      message,
      current: reviews.length,
      total: context?.batch.photos.length || reviews.length
    });
    return {
      runId,
      status: 'failed',
      batchId: request.batchId,
      scope,
      reviewed: reviews.length,
      message,
      bucketCounts: counts,
      debugLogPath,
      reviews
    };
  }
}

export function recordBrainFeedback(input: { photoId: string; runId?: string; action: string; note?: string }): boolean {
  getDb()
    .prepare('INSERT INTO brain_feedback (id, photo_id, run_id, action, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), input.photoId, input.runId || null, input.action, input.note || null, now());
  return true;
}
