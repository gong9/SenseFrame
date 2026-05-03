import crypto from 'node:crypto';
import { getDb } from '../db';
import { getBatch } from '../photoPipeline';
import { buildBatchContext, bucketCounts, callVisionModel, createHeuristicReview, parseReview, saveReview } from '../brainService';
import { callChatCompletions, getModelConfig } from '../brainRuntime/modelProvider';
import { photoAestheticPrompt } from '../brainRuntime/photoAestheticRubric';
import { createReviewContactSheets, imageFileDataUrl, type ReviewContactSheet, type ReviewContactSheetOptions } from '../brainReviewSheets';
import { createSmartView, getSmartView } from '../xiaogongSmartViewService';
import type {
  BatchView,
  BrainBucket,
  BrainGroupReviewDraft,
  BrainPhotoReview,
  BrainPhotoReviewDraft,
  BrainReviewStrategy,
  BrainVisualScores,
  Cluster,
  Decision,
  PhotoView,
  SmartViewItem
} from '../../shared/types';
import type { BrainToolDefinition } from '../brainRuntime/types';

const reviewSheetCache = new Map<string, ReviewContactSheet[]>();
const contactSheetVisionCache = new Map<string, {
  sheetId: string;
  reviews: BrainPhotoReviewDraft[];
  sheetSummary: string;
  singleVisionPhotoIds: string[];
  createdAt: string;
}>();
const photoVisionCache = new Map<string, {
  review: BrainPhotoReviewDraft;
  createdAt: string;
}>();

function cacheKey(...parts: Array<string | undefined>): string {
  return parts.map((part) => String(part || '')).join('::');
}

function cacheStats(batchId: string): Record<string, unknown> {
  const sheetPrefix = `${batchId}::`;
  const sheetEntries = [...contactSheetVisionCache.entries()].filter(([key]) => key.startsWith(sheetPrefix));
  const photoEntries = [...photoVisionCache.entries()].filter(([key]) => key.startsWith(sheetPrefix));
  const reviewedPhotoIds = new Set<string>();
  for (const [, value] of sheetEntries) for (const review of value.reviews) reviewedPhotoIds.add(review.photoId);
  for (const [, value] of photoEntries) reviewedPhotoIds.add(value.review.photoId);
  return {
    cachedContactSheets: sheetEntries.length,
    cachedSinglePhotos: photoEntries.length,
    cachedReviewedPhotos: reviewedPhotoIds.size,
    latestContactSheets: sheetEntries.slice(-8).map(([, value]) => ({
      sheetId: value.sheetId,
      reviews: value.reviews.length,
      createdAt: value.createdAt
    })),
    latestSinglePhotos: photoEntries.slice(-12).map(([, value]) => ({
      photoId: value.review.photoId,
      primaryBucket: value.review.primaryBucket,
      createdAt: value.createdAt
    }))
  };
}

function storeReviewSheets(batchId: string, sheets: ReviewContactSheet[]): void {
  const byId = new Map((reviewSheetCache.get(batchId) || []).map((sheet) => [sheet.id, sheet]));
  for (const sheet of sheets) byId.set(sheet.id, sheet);
  reviewSheetCache.set(batchId, [...byId.values()]);
}

function sheetPayloadSummary(sheet: ReviewContactSheet): Record<string, unknown> {
  return {
    sheetId: sheet.id,
    cells: sheet.cells.length,
    imageWidth: sheet.imageWidth,
    imageHeight: sheet.imageHeight,
    fileSizeBytes: sheet.fileSizeBytes,
    base64ApproxBytes: sheet.base64ApproxBytes,
    params: sheet.params,
    photoIds: sheet.cells.map((cell) => cell.photoId)
  };
}

function recoverableVisionSheetError(sheet: ReviewContactSheet, message: string): string {
  return JSON.stringify({
    errorType: 'vision_payload_or_network_failure',
    message,
    failedSheet: sheetPayloadSummary(sheet),
    recoveryHints: [
      '这通常说明当前审片板视觉请求在网络、请求体或模型视觉通道上不稳定。',
      '不要放弃全批覆盖，也不要只看少量候选。',
      '可以调用 CreateReviewContactSheets，仅传 failedSheet.photoIds，并主动降低 cellsPerSheet、cellWidth、cellHeight、imageHeight、jpegQuality，或改 detail=low，然后继续 ReviewContactSheetWithVision。',
      '如果仍失败，可以进一步拆小 failedSheet.photoIds，直到覆盖完成。'
    ]
  }, null, 2);
}

function contactSheetOptionsFromInput(input: any, batch: BatchView): ReviewContactSheetOptions {
  const known = new Set(batch.photos.map((photo) => photo.id));
  return {
    photoIds: Array.isArray(input?.photoIds) ? input.photoIds.map(String).filter((id: string) => known.has(id)) : undefined,
    cellsPerSheet: input?.cellsPerSheet,
    columns: input?.columns,
    cellWidth: input?.cellWidth,
    cellHeight: input?.cellHeight,
    imageHeight: input?.imageHeight,
    jpegQuality: input?.jpegQuality,
    detail: input?.detail === 'high' ? 'high' : input?.detail === 'low' ? 'low' : undefined,
    idPrefix: input?.idPrefix
  };
}

function now(): string {
  return new Date().toISOString();
}

function photoSummary(photo: PhotoView): Record<string, unknown> {
  return {
    id: photo.id,
    fileName: photo.fileName,
    decision: photo.decision,
    rating: photo.rating || 0,
    status: photo.status,
    clusterId: photo.clusterId,
    rankInCluster: photo.rankInCluster,
    recommended: photo.recommended,
    analysis: photo.analysis ? {
      finalScore: photo.analysis.finalScore,
      sharpnessScore: photo.analysis.sharpnessScore,
      exposureScore: photo.analysis.exposureScore,
      faceScore: photo.analysis.faceScore,
      faceVisibility: photo.analysis.faceVisibility,
      eyeState: photo.analysis.eyeState,
      eyeConfidence: photo.analysis.eyeConfidence,
      riskFlags: photo.analysis.riskFlags
    } : undefined,
    semantic: photo.semantic ? {
      caption: photo.semantic.caption,
      recommendationReason: photo.semantic.recommendationReason,
      scene: photo.semantic.scene,
      subjects: photo.semantic.subjects,
      emotion: photo.semantic.emotion,
      usage: photo.semantic.usage,
      llmScore: photo.semantic.llmScore,
      isMock: photo.semantic.isMock
    } : undefined,
    brainReview: photo.brainReview ? {
      primaryBucket: photo.brainReview.primaryBucket,
      confidence: photo.brainReview.confidence,
      recommendedAction: photo.brainReview.recommendedAction,
      reason: photo.brainReview.reason,
      needsHumanReview: photo.brainReview.needsHumanReview,
      visualScores: photo.brainReview.visualScores,
      aestheticPass: photo.brainReview.aestheticPass,
      aestheticRejectReasons: photo.brainReview.aestheticRejectReasons,
      fatalFlaws: photo.brainReview.fatalFlaws,
      compositionTags: photo.brainReview.compositionTags,
      groupId: photo.brainReview.groupId,
      groupRank: photo.brainReview.groupRank,
      groupRole: photo.brainReview.groupRole,
      groupReason: photo.brainReview.groupReason
    } : undefined
  };
}

function riskPenalty(photo: PhotoView): number {
  const flags = new Set(photo.analysis?.riskFlags || []);
  let penalty = 0;
  if (flags.has('closed_eyes')) penalty += 0.18;
  if (flags.has('eyes_uncertain')) penalty += 0.07;
  if (flags.has('possible_blur')) penalty += 0.12;
  if (flags.has('bad_exposure')) penalty += 0.10;
  if (flags.has('face_blur')) penalty += 0.08;
  if (flags.has('subject_cropped') || flags.has('subject_cropped_mild') || flags.has('subject_cropped_severe')) penalty += 0.10;
  if (flags.has('weak_subject')) penalty += 0.08;
  if (photo.brainReview?.needsHumanReview) penalty += 0.08;
  if (photo.brainReview?.primaryBucket === 'technical') penalty += 0.14;
  if (photo.brainReview?.primaryBucket === 'closedEyes') penalty += 0.16;
  return penalty;
}

function smartScore(photo: PhotoView): number {
  if (photo.decision === 'reject') return -1;
  const visual = photo.brainReview?.visualScores;
  const localQuality = photo.analysis?.finalScore ?? 0.5;
  const base = visual
    ? visual.visualQuality * 0.20 + visual.expression * 0.18 + visual.moment * 0.18 + visual.composition * 0.14 + visual.backgroundCleanliness * 0.10 + visual.storyValue * 0.12 + localQuality * 0.08
    : localQuality;
  const manual = photo.decision === 'pick' ? 0.18 + Math.min(0.12, (photo.rating || 0) * 0.024) : photo.decision === 'maybe' ? 0.02 : 0;
  const bucket = photo.brainReview?.primaryBucket === 'featured' ? 0.1 : 0;
  const rank = photo.brainReview?.groupRank || photo.rankInCluster;
  const duplicate = rank && rank > 1 ? Math.min(0.22, (rank - 1) * 0.055) : 0;
  return Math.max(0, Math.min(1, base + manual + bucket - riskPenalty(photo) - duplicate));
}

function localCandidateItems(batch: BatchView, intent = 'best_photos'): SmartViewItem[] {
  const hasBrainRun = batch.brainRun?.status === 'completed';
  const items = batch.photos
    .map((photo) => ({ photo, score: smartScore(photo) }))
    .filter(({ photo, score }) => photo.decision !== 'reject' && score > 0.48 && (intent !== 'best_photos' || photo.brainReview?.primaryBucket !== 'pending'))
    .sort((a, b) => b.score - a.score);

  return items.slice(0, Math.max(8, Math.min(36, Math.ceil(batch.photos.length * 0.24)))).map((item, index) => ({
    photoId: item.photo.id,
    rank: index + 1,
    score: item.score,
    reason: [
      hasBrainRun ? '基于已有小宫审片结果' : '仅为本地候选生成',
      item.photo.brainReview?.reason,
      item.photo.decision === 'pick' ? '人工已保留' : '',
      item.photo.brainReview?.groupRole === 'representative' ? '组内代表图' : ''
    ].filter(Boolean).join('；') || '按质量分、风险标签、组内代表性和人工选择生成候选。',
    actionHint: hasBrainRun && !item.photo.brainReview?.needsHumanReview ? 'pick' : 'review',
    needsHumanReview: !hasBrainRun || Boolean(item.photo.brainReview?.needsHumanReview)
  }));
}

function deriveReviewGroups(batch: BatchView): Cluster[] {
  const groups = new Map<string, Cluster>();

  for (const cluster of batch.clusters) {
    if (cluster.size > 1) groups.set(cluster.id, cluster);
  }

  const addPhotoToGroup = (groupId: string | undefined, photo: PhotoView) => {
    if (!groupId) return;
    const existing = groups.get(groupId) || {
      id: groupId,
      batchId: batch.id,
      size: 0,
      bestPhotoId: undefined,
      confidence: 0.72,
      members: []
    };
    if (existing.members.some((member) => member.photoId === photo.id)) {
      groups.set(groupId, existing);
      return;
    }
    existing.members.push({
      photoId: photo.id,
      rank: photo.brainReview?.groupRank || photo.rankInCluster || existing.members.length + 1,
      similarityToBest: photo.brainReview?.groupRole === 'representative' || photo.recommended ? 1 : 0.82,
      recommended: Boolean(photo.recommended || photo.brainReview?.groupRole === 'representative')
    });
    existing.size = existing.members.length;
    if (!existing.bestPhotoId && (photo.brainReview?.groupRole === 'representative' || photo.recommended)) {
      existing.bestPhotoId = photo.id;
    }
    groups.set(groupId, existing);
  };

  for (const photo of batch.photos) {
    addPhotoToGroup(photo.brainReview?.groupId, photo);
    addPhotoToGroup(photo.clusterId, photo);
  }

  return [...groups.values()]
    .map((group) => {
      const members = [...group.members].sort((a, b) => a.rank - b.rank);
      return {
        ...group,
        size: members.length,
        bestPhotoId: group.bestPhotoId || members[0]?.photoId,
        members
      };
    })
    .filter((group) => group.size > 1);
}

function countBy<T extends string>(items: T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});
}

function normalizeAction(value: unknown): Decision | 'review' {
  return value === 'pick' || value === 'reject' || value === 'maybe' || value === 'none' || value === 'review' ? value : 'review';
}

function normalizeBucket(value: unknown, fallback: BrainBucket = 'pending'): BrainBucket {
  const buckets: BrainBucket[] = ['featured', 'closedEyes', 'eyeReview', 'subject', 'technical', 'duplicates', 'similarBursts', 'pending'];
  return buckets.includes(value as BrainBucket) ? value as BrainBucket : fallback;
}

function draftToReview(draft: BrainPhotoReviewDraft, runId: string, model: string, group?: BrainGroupReviewDraft): BrainPhotoReview {
  const role = group?.roles.find((item) => item.photoId === draft.photoId);
  return {
    photoId: draft.photoId,
    runId,
    primaryBucket: draft.primaryBucket,
    secondaryBuckets: draft.secondaryBuckets,
    confidence: draft.confidence,
    recommendedAction: draft.recommendedAction,
    reason: draft.reason,
    smallModelOverrides: draft.smallModelOverrides,
    needsHumanReview: draft.needsHumanReview,
    visualScores: draft.visualScores,
    aestheticPass: draft.aestheticPass,
    aestheticRejectReasons: draft.aestheticRejectReasons,
    fatalFlaws: draft.fatalFlaws,
    compositionTags: draft.compositionTags,
    groupId: group?.groupId,
    groupRank: role?.groupRank,
    groupRole: role?.groupRole,
    representativeRank: role?.groupRank,
    groupReason: group?.groupReason,
    reviewSource: draft.reviewSource || 'single_vision',
    sheetId: draft.sheetId,
    sheetCell: draft.sheetCell,
    model,
    createdAt: now()
  };
}

function reviewToDraft(review: BrainPhotoReview, source: BrainPhotoReviewDraft['reviewSource']): BrainPhotoReviewDraft {
  return {
    photoId: review.photoId,
    primaryBucket: review.primaryBucket,
    secondaryBuckets: review.secondaryBuckets,
    confidence: review.confidence,
    recommendedAction: review.recommendedAction,
    reason: review.reason,
    smallModelOverrides: review.smallModelOverrides,
    needsHumanReview: review.needsHumanReview,
    visualScores: review.visualScores,
    aestheticPass: review.aestheticPass,
    aestheticRejectReasons: review.aestheticRejectReasons,
    fatalFlaws: review.fatalFlaws,
    compositionTags: review.compositionTags,
    reviewSource: source
  };
}

function sheetFallbackDraft(photo: PhotoView, sheet: ReviewContactSheet, cell: number, model: string): BrainPhotoReviewDraft {
  const context = buildBatchContext(photo.batchId);
  const local = createHeuristicReview(photo, 'draft', model, context);
  return {
    ...reviewToDraft(local, 'sheet_vision'),
    confidence: Math.min(local.confidence, 0.56),
    reason: `大脑已通过审片板覆盖到这张照片，但没有在结构化结果中单独点名；暂按本地信号进入 ${local.primaryBucket}，需要后续单张复核。`,
    needsHumanReview: true,
    sheetId: sheet.id,
    sheetCell: cell
  };
}

function validatePhotoIds(batch: BatchView, ids: unknown): string[] {
  const known = new Set(batch.photos.map((photo) => photo.id));
  return Array.isArray(ids) ? ids.map(String).filter((id) => known.has(id)) : [];
}

function parseJsonObject(text: string): Record<string, any> {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

function readableModelText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    try {
      const item = value as Record<string, unknown>;
      const subject = item.flag || item.source || item.from || item.field || item.model || item.type;
      const override = item.override || item.to || item.result || item.action || item.decision;
      const reason = item.reason || item.why || item.note;
      const parts = [subject, override, reason].filter((part) => part !== undefined && part !== null && String(part).trim());
      if (parts.length) return parts.map(String).join('：');
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => readableModelText(item)).filter((item) => item.length > 0);
}

function clamp01(value: unknown, fallback = 0.5): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function scoreFallback(photo?: PhotoView): number {
  if (!photo) return 0.58;
  const analysis = photo.analysis;
  if (!analysis) return 0.58;
  const flags = new Set(analysis.riskFlags || []);
  let score = analysis.finalScore ?? 0.58;
  if (flags.has('closed_eyes')) score -= 0.2;
  if (flags.has('eyes_uncertain')) score -= 0.06;
  if (flags.has('face_missing')) score -= 0.08;
  if (flags.has('face_blur')) score -= 0.06;
  if (flags.has('possible_blur')) score -= 0.1;
  if (analysis.eyeState === 'open') score += 0.03;
  if (analysis.faceVisibility === 'visible') score += 0.02;
  return Math.max(0.22, Math.min(0.9, score));
}

function normalizeScores(input: unknown, photo?: PhotoView): BrainVisualScores {
  const fallback = scoreFallback(photo);
  const scores = {
    visualQuality: clamp01((input as any)?.visualQuality ?? (input as any)?.visual_quality, fallback),
    expression: clamp01((input as any)?.expression, fallback),
    moment: clamp01((input as any)?.moment, fallback),
    composition: clamp01((input as any)?.composition, fallback),
    backgroundCleanliness: clamp01((input as any)?.backgroundCleanliness ?? (input as any)?.background_cleanliness, fallback),
    storyValue: clamp01((input as any)?.storyValue ?? (input as any)?.story_value, fallback),
    lighting: (input as any)?.lighting === undefined ? undefined : clamp01((input as any)?.lighting, fallback),
    subjectClarity: (input as any)?.subjectClarity === undefined && (input as any)?.subject_clarity === undefined ? undefined : clamp01((input as any)?.subjectClarity ?? (input as any)?.subject_clarity, fallback),
    finish: (input as any)?.finish === undefined ? undefined : clamp01((input as any)?.finish, fallback),
    deliverableScore: (input as any)?.deliverableScore === undefined && (input as any)?.deliverable_score === undefined ? undefined : clamp01((input as any)?.deliverableScore ?? (input as any)?.deliverable_score, fallback)
  };
  const values = Object.values(scores).filter((value): value is number => typeof value === 'number');
  const allFlat = values.every((value) => value === values[0]);
  const allExtreme = values.every((value) => value >= 0.99) || values.every((value) => value <= 0.01);
  if (allFlat && allExtreme) {
    return {
      visualQuality: fallback,
      expression: Math.min(1, fallback + 0.08),
      moment: Math.min(1, fallback + 0.05),
      composition: fallback,
      backgroundCleanliness: Math.max(0.2, fallback - 0.02),
      storyValue: Math.min(1, fallback + 0.04)
    };
  }
  return scores;
}

function hasCriticalRisk(photo?: PhotoView): boolean {
  const flags = new Set(photo?.analysis?.riskFlags || []);
  return flags.has('closed_eyes') || flags.has('face_missing') || flags.has('face_blur') || flags.has('possible_blur') || flags.has('subject_cropped_severe');
}

function aestheticPassFromRaw(raw: any, scores: BrainVisualScores): boolean | undefined {
  if (typeof raw?.aestheticPass === 'boolean') return raw.aestheticPass;
  if (typeof raw?.aesthetic_pass === 'boolean') return raw.aesthetic_pass;
  if (typeof raw?.aestheticPass === 'string') return raw.aestheticPass.toLowerCase() === 'true';
  if (typeof raw?.aesthetic_pass === 'string') return raw.aesthetic_pass.toLowerCase() === 'true';
  if (typeof scores.deliverableScore === 'number') return scores.deliverableScore >= 0.76;
  return undefined;
}

function fatalFlawsFromRaw(raw: any): string[] {
  return normalizeTextList(raw?.fatalFlaws || raw?.fatal_flaws);
}

function rejectReasonsFromRaw(raw: any): string[] {
  return normalizeTextList(raw?.aestheticRejectReasons || raw?.aesthetic_reject_reasons);
}

function compositionTagsFromRaw(raw: any): string[] {
  return normalizeTextList(raw?.compositionTags || raw?.composition_tags)
    .map((item) => item.trim())
    .filter((item, index, array) => item && array.indexOf(item) === index);
}

function curationScore(scores: BrainVisualScores): number {
  const delivery = typeof scores.deliverableScore === 'number' ? scores.deliverableScore : scores.visualQuality;
  const lighting = typeof scores.lighting === 'number' ? scores.lighting : scores.visualQuality;
  const subject = typeof scores.subjectClarity === 'number' ? scores.subjectClarity : scores.visualQuality;
  const finish = typeof scores.finish === 'number' ? scores.finish : scores.visualQuality;
  return scores.visualQuality * 0.12
    + scores.expression * 0.18
    + scores.moment * 0.16
    + scores.composition * 0.17
    + scores.backgroundCleanliness * 0.14
    + scores.storyValue * 0.07
    + delivery * 0.08
    + lighting * 0.03
    + subject * 0.03
    + finish * 0.02;
}

function standoutCount(scores: BrainVisualScores): number {
  return [scores.expression, scores.moment, scores.composition, scores.storyValue].filter((score) => score >= 0.82).length;
}

function featuredWorthy(input: {
  action: Decision | 'review';
  confidence: number;
  scores: BrainVisualScores;
  source?: BrainPhotoReview['reviewSource'];
  aestheticPass?: boolean;
  fatalFlaws?: string[];
}): boolean {
  if (input.action !== 'pick') return false;
  if (input.aestheticPass === false) return false;
  if ((input.fatalFlaws || []).length > 0) return false;
  const deliverable = input.scores.deliverableScore ?? curationScore(input.scores);
  const sourceThreshold = input.source === 'sheet_vision' ? 0.84 : 0.78;
  if (input.confidence < (input.source === 'sheet_vision' ? 0.8 : 0.74)) return false;
  if (deliverable < (input.source === 'sheet_vision' ? 0.8 : 0.76)) return false;
  if (curationScore(input.scores) < sourceThreshold) return false;
  if (input.scores.visualQuality < 0.7 || input.scores.composition < 0.7) return false;
  if ((input.scores.subjectClarity ?? input.scores.visualQuality) < 0.68) return false;
  if ((input.scores.finish ?? input.scores.visualQuality) < 0.66) return false;
  if (input.scores.backgroundCleanliness < 0.62 && standoutCount(input.scores) < 3) return false;
  return standoutCount(input.scores) >= 2;
}

function demoteWeakFeatured(
  bucket: BrainBucket,
  action: Decision | 'review',
  confidence: number,
  scores: BrainVisualScores,
  photo: PhotoView,
  source?: BrainPhotoReview['reviewSource'],
  aestheticPass?: boolean,
  fatalFlaws?: string[]
): BrainBucket {
  if (bucket !== 'featured') return bucket;
  if (featuredWorthy({ action, confidence, scores, source, aestheticPass, fatalFlaws })) return 'featured';
  if (action === 'review') return hasCriticalRisk(photo) ? 'eyeReview' : 'similarBursts';
  if (action === 'reject') return hasCriticalRisk(photo) ? 'technical' : 'similarBursts';
  return hasCriticalRisk(photo) ? 'eyeReview' : 'similarBursts';
}

function needsHumanReviewFromDraft(draft: any, photo?: PhotoView, source?: BrainPhotoReview['reviewSource']): boolean {
  const action = String(draft?.recommendedAction || draft?.recommended_action || '').toLowerCase();
  const bucket = String(draft?.primaryBucket || draft?.primary_bucket || '').toLowerCase();
  const confidence = clamp01(draft?.confidence ?? 0.5, 0.5);
  const explicit = Boolean(draft?.needsHumanReview ?? draft?.needs_human_review);
  if (source === 'single_vision' || source === 'group_vision') return explicit || confidence < 0.7 || action === 'review' || action === 'maybe';
  if (hasCriticalRisk(photo)) return true;
  if (action === 'review') return true;
  if (action === 'reject') return false;
  if (action === 'pick' && confidence >= 0.8 && !hasCriticalRisk(photo)) return explicit && confidence < 0.88;
  if (bucket === 'featured' && confidence >= 0.78 && !hasCriticalRisk(photo)) return false;
  if (bucket === 'eyereview' || bucket === 'technical' || bucket === 'pending') return true;
  if (action === 'maybe') return confidence < 0.72 || bucket === 'featured';
  return explicit && confidence < 0.7;
}

function normalizeDraftReview(raw: any, photo: PhotoView, source: BrainPhotoReview['reviewSource'], fallbackBucket: BrainBucket): BrainPhotoReviewDraft {
  const rawPrimaryBucket = normalizeBucket(raw?.primaryBucket || raw?.primary_bucket, fallbackBucket);
  const confidence = clamp01(raw?.confidence, scoreFallback(photo));
  const scoreInput = {
    ...((raw?.visualScores || raw?.visual_scores || {}) as Record<string, unknown>),
    deliverableScore: raw?.deliverableScore ?? raw?.deliverable_score ?? (raw?.visualScores || raw?.visual_scores)?.deliverableScore ?? (raw?.visualScores || raw?.visual_scores)?.deliverable_score
  };
  const visualScores = normalizeScores(scoreInput, photo);
  const recommendedAction = normalizeAction(raw?.recommendedAction || raw?.recommended_action);
  const aestheticPass = aestheticPassFromRaw(raw, visualScores);
  const fatalFlaws = fatalFlawsFromRaw(raw);
  const aestheticRejectReasons = rejectReasonsFromRaw(raw);
  const compositionTags = compositionTagsFromRaw(raw);
  const primaryBucket = demoteWeakFeatured(rawPrimaryBucket, recommendedAction, confidence, visualScores, photo, source, aestheticPass, fatalFlaws);
  const secondaryBuckets = Array.isArray(raw?.secondaryBuckets || raw?.secondary_buckets)
    ? (raw?.secondaryBuckets || raw?.secondary_buckets).map((item: unknown) => normalizeBucket(item, fallbackBucket)).filter((item: BrainBucket, index: number, array: BrainBucket[]) => array.indexOf(item) === index)
    : [];
  if (rawPrimaryBucket === 'featured' && primaryBucket !== 'featured' && !secondaryBuckets.includes('featured')) {
    secondaryBuckets.unshift('featured');
  }
  return {
    photoId: photo.id,
    primaryBucket,
    secondaryBuckets,
    confidence,
    recommendedAction,
    reason: String(raw?.reason || `小宫在 ${source === 'sheet_vision' ? '审片板' : '高清单图'} 中看到了这张照片。`),
    smallModelOverrides: normalizeTextList(raw?.smallModelOverrides || raw?.small_model_overrides),
    needsHumanReview: needsHumanReviewFromDraft(raw, photo, source),
    visualScores,
    aestheticPass,
    aestheticRejectReasons,
    fatalFlaws,
    compositionTags,
    reviewSource: source
  };
}

export function createSenseFrameToolRegistry(): BrainToolDefinition[] {
  return [
    {
      name: 'GetVisionRuntimeStatus',
      description: '读取本次应用生命周期内的小宫视觉运行状态和缓存覆盖情况。用于判断哪些审片板/单张已经看过，避免重复视觉请求；不做新的审美判断。',
      permissionLevel: 'read',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: (_input, context) => {
        const batch = getBatch(context.batchId);
        return {
          batchId: batch.id,
          totalPhotos: batch.photos.length,
          ...cacheStats(context.batchId),
          guidance: [
            '如果 cachedReviewedPhotos 已覆盖整批，可以直接基于已有草稿写入或继续少量高清复核。',
            '如果只缺少少量照片，应优先生成缺失 photoIds 的审片板或单张复核，避免重复看已经缓存的照片。',
            '缓存来自本次应用生命周期内的真实视觉工具结果，不代表历史 brainRun。'
          ]
        };
      }
    },
    {
      name: 'GetWorkspaceContext',
      description: '读取当前 SenseFrame 工作台状态、当前批次、大脑审片状态和可用照片数量。',
      permissionLevel: 'read',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: (_input, context) => {
        const batch = getBatch(context.batchId);
        return {
          batchId: batch.id,
          batchName: batch.name,
          totalPhotos: batch.photos.length,
          processedPhotos: batch.processedPhotos,
          brainRun: batch.brainRun,
          activePhotoId: context.activePhotoId,
          clusterCount: batch.clusters.length
        };
      }
    },
    {
      name: 'GetBatchOverview',
      description: '读取整批照片摘要，包括小模型分数、风险、人工选择、语义结果、大脑审片结果和相似组信息。',
      permissionLevel: 'read',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: (_input, context) => {
        const batch = getBatch(context.batchId);
        const decisions = countBy(batch.photos.map((photo) => photo.decision));
        const riskFlags = countBy(batch.photos.flatMap((photo) => photo.analysis?.riskFlags || []));
        const buckets = countBy(batch.photos.map((photo) => photo.brainReview?.primaryBucket || 'none'));
        const groups = deriveReviewGroups(batch);
        return {
          batch: {
            id: batch.id,
            name: batch.name,
            totalPhotos: batch.photos.length,
            processedPhotos: batch.processedPhotos,
            brainRun: batch.brainRun,
            decisions,
            riskFlags,
            brainBuckets: buckets,
            clusterCount: batch.clusters.length,
            reviewGroupCount: groups.length
          },
          groups: groups
            .map((cluster) => ({
              groupId: cluster.id,
              size: cluster.size,
              bestPhotoId: cluster.bestPhotoId,
              members: cluster.members.map((member) => ({
                photoId: member.photoId,
                rank: member.rank,
                recommended: member.recommended,
                similarityToBest: member.similarityToBest
              }))
            })),
          photos: batch.photos.map(photoSummary)
        };
      }
    },
    {
      name: 'DecideReviewStrategy',
      description: '根据 GetBatchOverview 的真实结果确定审片策略。输入必须是大脑基于批次状态选择出的照片和组，不能固定张数。',
      permissionLevel: 'read',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          strategySummary: { type: 'string' },
          priorityPhotoIds: { type: 'array', items: { type: 'string' } },
          riskPhotoIds: { type: 'array', items: { type: 'string' } },
          groupIdsToCompare: { type: 'array', items: { type: 'string' } },
          skipPhotoIds: { type: 'array', items: { type: 'string' } }
        },
        required: ['strategySummary', 'priorityPhotoIds', 'riskPhotoIds', 'groupIdsToCompare', 'skipPhotoIds'],
        additionalProperties: false
      },
      handler: (input, context): BrainReviewStrategy => {
        const batch = getBatch(context.batchId);
        const groupIds = new Set(deriveReviewGroups(batch).map((cluster) => cluster.id));
        const priorityPhotoIds = validatePhotoIds(batch, input?.priorityPhotoIds);
        const riskPhotoIds = validatePhotoIds(batch, input?.riskPhotoIds);
        const selected = new Set([...priorityPhotoIds, ...riskPhotoIds]);
        const fallback = batch.photos
          .filter((photo) => photo.status === 'ready' && photo.previewPath)
          .filter((photo) => {
            if (selected.has(photo.id)) return false;
            const flags = new Set(photo.analysis?.riskFlags || []);
            return photo.decision === 'pick' || (photo.analysis?.finalScore ?? 0) >= 0.68 || flags.has('closed_eyes') || flags.has('eyes_uncertain') || flags.has('face_missing');
          })
          .map((photo) => photo.id);
        const normalizedPriority = priorityPhotoIds.length ? priorityPhotoIds : fallback;
        return {
          strategySummary: String(input?.strategySummary || '大脑基于批次概览选择优先照片、风险照片和需要比较的相似组。'),
          priorityPhotoIds: normalizedPriority,
          riskPhotoIds,
          groupIdsToCompare: Array.isArray(input?.groupIdsToCompare) ? input.groupIdsToCompare.map(String).filter((id: string) => groupIds.has(id)) : [],
          skipPhotoIds: validatePhotoIds(batch, input?.skipPhotoIds)
        };
      }
    },
    {
      name: 'CreateReviewContactSheets',
      description: '生成覆盖整批或指定照片的审片板。小宫可以主动控制 photoIds、cellsPerSheet、columns、cellWidth、cellHeight、imageHeight、jpegQuality、detail、idPrefix 来优化视觉载体；工具会校验边界并返回真实 payload 指标。',
      permissionLevel: 'brain_write',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          photoIds: { type: 'array', items: { type: 'string' } },
          cellsPerSheet: { type: 'number' },
          columns: { type: 'number' },
          cellWidth: { type: 'number' },
          cellHeight: { type: 'number' },
          imageHeight: { type: 'number' },
          jpegQuality: { type: 'number' },
          detail: { type: 'string', enum: ['low', 'high'] },
          idPrefix: { type: 'string' },
          strategySummary: { type: 'string' }
        },
        additionalProperties: false
      },
      handler: async (input, context) => {
        const batch = getBatch(context.batchId);
        const sheets = await createReviewContactSheets(context.batchId, batch.photos, contactSheetOptionsFromInput(input, batch));
        storeReviewSheets(context.batchId, sheets);
        context.emitLog({
          level: 'success',
          phase: 'vision',
          title: '生成整批审片板',
          message: `已生成 ${sheets.length} 张审片板，覆盖 ${sheets.reduce((sum, sheet) => sum + sheet.cells.length, 0)} 张照片。`,
          progress: { current: sheets.length, total: sheets.length }
        });
        return {
          strategySummary: String(input?.strategySummary || '小宫决定先用审片板全量扫完整批，再挑关键照片高清精看。'),
          totalPhotos: batch.photos.length,
          coveredPhotos: sheets.reduce((sum, sheet) => sum + sheet.cells.length, 0),
          sheets: sheets.map((sheet) => ({
            id: sheet.id,
            index: sheet.index,
            total: sheet.total,
            photoCount: sheet.cells.length,
            imageWidth: sheet.imageWidth,
            imageHeight: sheet.imageHeight,
            fileSizeBytes: sheet.fileSizeBytes,
            base64ApproxBytes: sheet.base64ApproxBytes,
            params: sheet.params,
            photoIds: sheet.cells.map((cell) => cell.photoId)
          }))
        };
      }
    },
    {
      name: 'ReviewContactSheetWithVision',
      description: '真实查看一张审片板，并为板上每个 cell/photo 返回初步小宫判断。失败时会返回包含 payload 指标、失败 sheet photoIds 和恢复提示的 tool_use_error，供大脑自己压缩、拆分、重建、重试。',
      permissionLevel: 'brain_write',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          sheetId: { type: 'string' },
          sheetPath: { type: 'string' },
          cells: { type: 'array', items: { type: 'object' } },
          focusMode: { type: 'string' }
        },
        required: ['sheetId'],
        additionalProperties: false
      },
      handler: async (input, context) => {
        const batch = getBatch(context.batchId);
        const idToPhoto = new Map(batch.photos.map((photo) => [photo.id, photo]));
        const sheetId = String(input?.sheetId || '');
        const cached = reviewSheetCache.get(context.batchId)?.find((item) => item.id === sheetId);
        const sheet: ReviewContactSheet = cached || {
          id: sheetId,
          path: String(input?.sheetPath || ''),
          index: 1,
          total: 1,
          imageWidth: 0,
          imageHeight: 0,
          fileSizeBytes: 0,
          base64ApproxBytes: 0,
          params: {
            photoIds: [],
            cellsPerSheet: 25,
            columns: 5,
            cellWidth: 210,
            cellHeight: 292,
            imageHeight: 238,
            jpegQuality: 82,
            detail: 'low',
            idPrefix: 'external-sheet'
          },
          cells: Array.isArray(input?.cells) ? input.cells.map((cell: any) => ({
            cell: Number(cell.cell) || 0,
            photoId: String(cell.photoId || ''),
            fileName: String(cell.fileName || ''),
            score: Number(cell.score) || 0,
            riskFlags: Array.isArray(cell.riskFlags) ? cell.riskFlags.map(String) : [],
            decision: String(cell.decision || 'none')
          })).filter((cell: ReviewContactSheet['cells'][number]) => idToPhoto.has(cell.photoId)) : []
        };
        if (!sheet.id || !sheet.path || !sheet.cells.length) throw new Error('ReviewContactSheetWithVision 缺少有效审片板。');
        const config = getModelConfig();
        const visionCacheKey = cacheKey(context.batchId, config.model, sheet.id, String(input?.focusMode || 'batch'));
        const cachedVision = contactSheetVisionCache.get(visionCacheKey);
        if (cachedVision) {
          context.emitLog({
            level: 'success',
            phase: 'vision',
            title: `复用审片板 ${sheet.id}`,
            message: `已复用缓存视觉结果，覆盖 ${cachedVision.reviews.length} 张照片。`,
            progress: { current: cachedVision.reviews.length, total: sheet.cells.length }
          });
          return {
            sheetId: sheet.id,
            sheetSummary: cachedVision.sheetSummary,
            reviews: cachedVision.reviews,
            singleVisionPhotoIds: cachedVision.singleVisionPhotoIds,
            cacheHit: true
          };
        }
        let response: any;
        try {
          response = await callChatCompletions(config, {
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: [
                  '你是 SenseFrame 小宫大脑的审片板视觉分析器。',
                  '你正在像摄影师看缩略图墙一样查看整批照片的一部分。必须尽量给每个 cell/photo 一个初步判断。',
                  photoAestheticPrompt(),
                  '不要把本地风险机械等同废片；closed_eyes 可能是情绪，face_missing 可能是细节/空镜。',
                  '输出 JSON：{reviews:[{cell, photoId, primaryBucket, secondaryBuckets, confidence, recommendedAction, reason, smallModelOverrides, needsHumanReview, visualScores, aestheticPass, deliverableScore, fatalFlaws, aestheticRejectReasons, compositionTags}], sheetSummary, singleVisionPhotoIds}。',
                  '允许 primaryBucket: featured, closedEyes, eyeReview, subject, technical, duplicates, similarBursts, pending。',
                  'recommendedAction 只能是 pick/reject/maybe/review/none。visualScores 字段为 visualQuality, expression, moment, composition, backgroundCleanliness, storyValue，可补充 lighting, subjectClarity, finish, deliverableScore。',
                  'visualScores 必须是 0-1 的真实差异化评分，禁止全部填 1 或全部填同一个数。',
                  'needsHumanReview 只给真正需要人工复核或高清确认的照片；低优先级备选、明确相似淘汰、普通连拍不要全部标 true。',
                  'featured 只能给交付级精选候选：动作/表情/构图/背景至少两项明显优秀，且 recommendedAction 必须是 pick。普通“有情绪但画面脏、逆光灰、主体糊、构图随拍”的照片应归 similarBursts/eyeReview/technical。',
                  '如果这一页整体都是烂片，可以一个 featured 都不给；不要为了凑数而精选。'
                ].join('\n')
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: [
                      `sheetId=${sheet.id}`,
                      `focusMode=${String(input?.focusMode || 'batch')}`,
                      `payload=${JSON.stringify(sheetPayloadSummary(sheet))}`,
                      '每个格子底部有 cell 序号、文件名、短 id、本地分数和风险信号。',
                      '请覆盖这个 sheet 中所有 cell。如果某张只能缩略图初判，请 needsHumanReview=true，并建议是否需要单张高清精看。',
                      JSON.stringify(sheet.cells, null, 2)
                    ].join('\n')
                  },
                  {
                    type: 'image_url',
                    image_url: { url: imageFileDataUrl(sheet.path), detail: sheet.params.detail }
                  }
                ]
              }
            ]
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(recoverableVisionSheetError(sheet, message));
        }
        const parsed = parseJsonObject(String(response.choices?.[0]?.message?.content || '{}'));
        const byPhoto = new Map<string, any>();
        for (const review of Array.isArray(parsed.reviews) ? parsed.reviews : []) {
          const photoId = String(review?.photoId || review?.photo_id || '');
          if (idToPhoto.has(photoId)) byPhoto.set(photoId, review);
        }
        const reviews: BrainPhotoReviewDraft[] = sheet.cells.map((cell) => {
          const photo = idToPhoto.get(cell.photoId);
          if (!photo) throw new Error(`审片板包含不存在照片：${cell.photoId}`);
          const raw = byPhoto.get(cell.photoId);
          if (!raw) return sheetFallbackDraft(photo, sheet, cell.cell, config.model);
          return {
            ...normalizeDraftReview(raw, photo, 'sheet_vision', 'pending'),
            sheetId: sheet.id,
            sheetCell: cell.cell
          };
        });
        const sheetSummary = readableModelText(parsed.sheetSummary || parsed.sheet_summary, `已通过审片板覆盖 ${reviews.length} 张照片。`);
        context.emitLog({
          level: 'success',
          phase: 'vision',
          title: `完成审片板 ${sheet.id}`,
          message: sheetSummary,
          progress: { current: reviews.length, total: sheet.cells.length }
        });
        contactSheetVisionCache.set(visionCacheKey, {
          sheetId: sheet.id,
          sheetSummary,
          reviews,
          singleVisionPhotoIds: validatePhotoIds(batch, parsed.singleVisionPhotoIds || parsed.single_vision_photo_ids),
          createdAt: now()
        });
        return {
          sheetId: sheet.id,
          sheetSummary,
          reviews,
          singleVisionPhotoIds: validatePhotoIds(batch, parsed.singleVisionPhotoIds || parsed.single_vision_photo_ids),
          cacheHit: false
        };
      }
    },
    {
      name: 'GetCurrentPhoto',
      description: '读取当前选中照片的完整摘要。',
      permissionLevel: 'read',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: (_input, context) => {
        const batch = getBatch(context.batchId);
        const photo = batch.photos.find((item) => item.id === context.activePhotoId) || batch.photos[0];
        if (!photo) throw new Error('当前批次没有照片。');
        return photoSummary(photo);
      }
    },
    {
      name: 'GenerateLocalCandidates',
      description: '只根据已有本地分数、risk flags、brainReview 和人工选择生成候选。这个工具不做新的视觉审美判断，不能代表最终大脑结果。',
      permissionLevel: 'read',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string' }
        },
        additionalProperties: false
      },
      handler: (input, context) => {
        const batch = getBatch(context.batchId);
        const items = localCandidateItems(batch, String(input?.intent || 'best_photos'));
        return {
          limitation: '本地候选生成，不等于小宫最终视觉审美判断。',
          items
        };
      }
    },
    {
      name: 'CreateSmartView',
      description: '创建小宫智能视图。优先使用大脑提供的 photoIds；如果没有 photoIds，只能基于已有数据生成本地候选。',
      permissionLevel: 'view',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          criteria: { type: 'string' },
          photoIds: { type: 'array', items: { type: 'string' } },
          intent: { type: 'string' }
        },
        required: ['name', 'summary'],
        additionalProperties: false
      },
      handler: (input, context) => {
        const batch = getBatch(context.batchId);
        const idToPhoto = new Map(batch.photos.map((photo) => [photo.id, photo]));
        const photoIds: string[] = Array.isArray(input?.photoIds) ? input.photoIds.map(String).filter((id: string) => idToPhoto.has(id)) : [];
        if (!photoIds.length) throw new Error('CreateSmartView 必须接收大脑明确给定的 photoIds，不能自动本地排序生成精选。');
        const items = photoIds
          .map((photoId: string, index: number) => {
              const photo = idToPhoto.get(photoId);
              return {
                photoId,
                rank: index + 1,
                score: photo ? smartScore(photo) : 0.5,
                reason: photo?.brainReview?.reason || String(input?.criteria || '大脑按当前任务目标选入此视图。'),
                actionHint: photo?.brainReview?.needsHumanReview ? 'review' as const : 'pick' as const,
                needsHumanReview: Boolean(photo?.brainReview?.needsHumanReview)
              };
            });
        const view = createSmartView({
          batchId: context.batchId,
          name: String(input?.name || '小宫视图'),
          intent: 'best_photos',
          query: String(input?.criteria || ''),
          summary: String(input?.summary || `小宫创建了 ${items.length} 张照片的智能视图。`),
          items
        });
        return {
          smartView: view,
          uiPatch: {
            mode: 'smartView',
            smartViewId: view.id,
            activePhotoId: view.items[0]?.photoId,
            notice: view.summary
          }
        };
      }
    },
    {
      name: 'ShowSmartView',
      description: '切换 UI 到已有小宫智能视图。',
      permissionLevel: 'view',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          viewId: { type: 'string' }
        },
        required: ['viewId'],
        additionalProperties: false
      },
      handler: (input) => {
        const view = getSmartView(String(input.viewId));
        return {
          smartView: view,
          uiPatch: {
            mode: 'smartView',
            smartViewId: view.id,
            activePhotoId: view.items[0]?.photoId,
            notice: view.summary
          }
        };
      }
    },
    {
      name: 'ReviewPhotoWithVision',
      description: '真实看单张照片并返回 BrainPhotoReviewDraft。只返回草稿，不写数据库。',
      permissionLevel: 'brain_write',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          photoId: { type: 'string' },
          focusMode: { type: 'string' }
        },
        additionalProperties: false
      },
      handler: async (input, context) => {
        const photoId = String(input?.photoId || context.activePhotoId || '');
        const batchContext = buildBatchContext(context.batchId);
        const photo = batchContext.batch.photos.find((item) => item.id === photoId);
        if (!photo) throw new Error(`照片不存在：${photoId}`);
        const config = getModelConfig();
        const visionCacheKey = cacheKey(context.batchId, config.model, photo.id, String(input?.focusMode || 'photo'));
        const cachedVision = photoVisionCache.get(visionCacheKey);
        if (cachedVision) {
          context.emitLog({
            level: 'success',
            phase: 'vision',
            title: `复用 ${photo.fileName}`,
            message: cachedVision.review.reason,
            photoId: photo.id,
            photoFileName: photo.fileName
          });
          return { review: cachedVision.review, cacheHit: true };
        }
        const fallback = createHeuristicReview(photo, 'draft', config.model, batchContext);
        context.emitLog({
          level: 'info',
          phase: 'vision',
          title: `正在真实看图 ${photo.fileName}`,
          photoId: photo.id,
          photoFileName: photo.fileName
        });
        const text = await callVisionModel(config, photo, 'photo', batchContext);
        const parsed = parseReview(text, photo, fallback.primaryBucket);
        const draft = normalizeDraftReview(parsed, photo, 'single_vision', fallback.primaryBucket);
        context.emitLog({
          level: 'success',
          phase: 'vision',
          title: `完成 ${photo.fileName} -> ${draft.primaryBucket}`,
          message: draft.reason,
          photoId: photo.id,
          photoFileName: photo.fileName
        });
        photoVisionCache.set(visionCacheKey, {
          review: draft,
          createdAt: now()
        });
        return { review: draft };
      }
    },
    {
      name: 'CompareSimilarGroupWithVision',
      description: '根据组内照片和已完成单张审片草稿，比较相似/连拍组并返回代表图排序。不写数据库。',
      permissionLevel: 'brain_write',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'string' },
          reviews: { type: 'array', items: { type: 'object' } }
        },
        required: ['groupId', 'reviews'],
        additionalProperties: false
      },
      handler: async (input, context) => {
        const groupId = String(input?.groupId || '');
        const batch = getBatch(context.batchId);
        const group = deriveReviewGroups(batch).find((cluster) => cluster.id === groupId);
        if (!group) throw new Error(`相似组不存在：${groupId}`);
        const idToPhoto = new Map(batch.photos.map((photo) => [photo.id, photo]));
        const reviewMap = new Map<string, BrainPhotoReviewDraft>();
        for (const item of Array.isArray(input?.reviews) ? input.reviews : []) {
          if (item && typeof item === 'object' && typeof item.photoId === 'string') {
            const photo = idToPhoto.get(item.photoId);
            reviewMap.set(item.photoId, {
              photoId: item.photoId,
              primaryBucket: normalizeBucket(item.primaryBucket),
              secondaryBuckets: Array.isArray(item.secondaryBuckets) ? item.secondaryBuckets.map(normalizeBucket) : [],
              confidence: clamp01(item.confidence, 0.5),
              recommendedAction: normalizeAction(item.recommendedAction),
              reason: String(item.reason || ''),
              smallModelOverrides: normalizeTextList(item.smallModelOverrides),
              needsHumanReview: needsHumanReviewFromDraft(item, photo, 'group_vision'),
              visualScores: normalizeScores(item.visualScores, photo),
              aestheticPass: aestheticPassFromRaw(item, normalizeScores(item.visualScores, photo)),
              aestheticRejectReasons: rejectReasonsFromRaw(item),
              fatalFlaws: fatalFlawsFromRaw(item),
              compositionTags: compositionTagsFromRaw(item)
            });
          }
        }
        const candidates = group.members
          .map((member) => idToPhoto.get(member.photoId))
          .filter((photo): photo is PhotoView => Boolean(photo))
          .map((photo) => {
            const review = reviewMap.get(photo.id);
            const score = review
              ? review.visualScores.visualQuality * 0.22 + review.visualScores.expression * 0.2 + review.visualScores.moment * 0.2 + review.visualScores.composition * 0.14 + review.visualScores.backgroundCleanliness * 0.1 + review.visualScores.storyValue * 0.14 + review.confidence * 0.1
              : smartScore(photo);
            return { photo, review, score };
          })
          .sort((a, b) => b.score - a.score);
        const config = getModelConfig();
        const compareResponse = await callChatCompletions(config, {
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: [
                '你是 SenseFrame 小宫大脑的连拍/相似组比较器。你不能写数据库，只能基于已有单张视觉复核和本地上下文选择组内代表图。输出 JSON。',
                photoAestheticPrompt()
              ].join('\n')
            },
            {
              role: 'user',
              content: [
                `groupId=${groupId}`,
                '请比较这些照片，选择代表图并给出完整排序。不要只看分数，要综合表情、瞬间、遮挡、背景干净度、构图和组内重复度。',
                '返回 JSON keys: representativePhotoId, rankedPhotoIds, groupReason。',
                JSON.stringify(candidates.map((item) => ({
                  photoId: item.photo.id,
                  fileName: item.photo.fileName,
                  decision: item.photo.decision,
                  analysis: item.photo.analysis ? {
                    finalScore: item.photo.analysis.finalScore,
                    riskFlags: item.photo.analysis.riskFlags,
                    eyeState: item.photo.analysis.eyeState,
                    faceVisibility: item.photo.analysis.faceVisibility
                  } : undefined,
                  review: item.review,
                  fallbackScore: item.score
                })), null, 2)
              ].join('\n')
            }
          ]
        });
        const parsed = parseJsonObject(String(compareResponse.choices?.[0]?.message?.content || '{}'));
        const modelRanked = Array.isArray(parsed.rankedPhotoIds) ? parsed.rankedPhotoIds.map(String).filter((id: string) => candidates.some((item) => item.photo.id === id)) : [];
        const rankedPhotoIds = modelRanked.length ? [...modelRanked, ...candidates.map((item) => item.photo.id).filter((id) => !modelRanked.includes(id))] : candidates.map((item) => item.photo.id);
        const representativePhotoId = rankedPhotoIds[0];
        if (!representativePhotoId) throw new Error(`相似组没有可比较照片：${groupId}`);
        const groupReview: BrainGroupReviewDraft = {
          groupId,
          representativePhotoId,
          rankedPhotoIds,
          groupReason: String(parsed.groupReason || `大脑基于单张视觉复核、表情/瞬间/构图/背景干净度和置信度，选择 ${idToPhoto.get(representativePhotoId)?.fileName || representativePhotoId} 作为组内代表图。`),
          roles: rankedPhotoIds.map((photoId, index) => ({
            photoId,
            groupRank: index + 1,
            groupRole: index === 0 ? 'representative' : index <= 2 ? 'backup' : 'rejected'
          }))
        };
        context.emitLog({
          level: 'success',
          phase: 'compare',
          title: `完成相似组比较 ${groupId}`,
          message: groupReview.groupReason,
          groupId,
          progress: { current: 1, total: 1 }
        });
        return { groupReview };
      }
    },
    {
      name: 'WriteBrainReviewResult',
      description: '写入本次大脑最终审片结果。只有这个工具可以写 brain_runs、brain_bucket_assignments、brain_group_rankings、brain_events。必须传入本次工具链产生的全量 reviews；历史 brainRun/brainReview 不能当作本次结果，空 reviews 会被拒绝。',
      permissionLevel: 'brain_write',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          strategySummary: { type: 'string' },
          reviews: { type: 'array', items: { type: 'object' } },
          groupReviews: { type: 'array', items: { type: 'object' } }
        },
        required: ['strategySummary', 'reviews', 'groupReviews'],
        additionalProperties: false
      },
      handler: (input, context) => {
        const batch = getBatch(context.batchId);
        const config = getModelConfig();
        const runId = crypto.randomUUID();
        const createdAt = now();
        const groupReviews: BrainGroupReviewDraft[] = Array.isArray(input?.groupReviews)
          ? input.groupReviews.map((group: any) => ({
              groupId: String(group.groupId || ''),
              representativePhotoId: String(group.representativePhotoId || ''),
              rankedPhotoIds: Array.isArray(group.rankedPhotoIds) ? group.rankedPhotoIds.map(String) : [],
              groupReason: String(group.groupReason || ''),
              roles: Array.isArray(group.roles) ? group.roles.map((role: any) => ({
                photoId: String(role.photoId || ''),
                groupRank: Number(role.groupRank) || 1,
                groupRole: role.groupRole === 'representative' || role.groupRole === 'backup' || role.groupRole === 'rejected' || role.groupRole === 'single' ? role.groupRole : 'backup'
              })) : []
            }))
          : [];
        const groupByPhoto = new Map<string, BrainGroupReviewDraft>();
        for (const group of groupReviews) for (const role of group.roles) groupByPhoto.set(role.photoId, group);
        const known = new Set(batch.photos.map((photo) => photo.id));
        const photoById = new Map(batch.photos.map((photo) => [photo.id, photo]));
        const reviews: BrainPhotoReview[] = (Array.isArray(input?.reviews) ? input.reviews : [])
          .filter((draft: any) => known.has(String(draft.photoId)))
          .map((draft: any) => {
            const photo = photoById.get(String(draft.photoId));
            if (!photo) throw new Error(`WriteBrainReviewResult 收到不存在照片：${String(draft.photoId)}`);
            const source = draft.reviewSource === 'sheet_vision' || draft.reviewSource === 'group_vision' || draft.reviewSource === 'single_vision' ? draft.reviewSource : 'single_vision';
            return draftToReview({
              ...normalizeDraftReview(draft, photo, source, 'pending'),
              sheetId: typeof draft.sheetId === 'string' ? draft.sheetId : undefined,
              sheetCell: Number.isFinite(Number(draft.sheetCell)) ? Number(draft.sheetCell) : undefined
            }, runId, config.model, groupByPhoto.get(String(draft.photoId)));
          });
        if (!reviews.length) throw new Error('WriteBrainReviewResult 没有收到有效 reviews，拒绝写入。');
        const reviewedIds = new Set(reviews.map((review) => review.photoId));
        const missing = batch.photos.filter((photo) => !reviewedIds.has(photo.id));
        if (missing.length) {
          throw new Error(`WriteBrainReviewResult 拒绝只写部分结果：当前缺少 ${missing.length}/${batch.photos.length} 张照片。小宫必须先用 CreateReviewContactSheets + ReviewContactSheetWithVision 覆盖整批，再写入全量结果。缺少示例：${missing.slice(0, 8).map((photo) => photo.fileName).join(', ')}`);
        }
        const counts = bucketCounts(reviews);
        const sourceCounts = countBy(reviews.map((review) => review.reviewSource || 'single_vision'));
        const summary = [
          `小宫大脑完成审片：写入 ${reviews.length} 张照片。`,
          `审片板覆盖 ${sourceCounts.sheet_vision || 0} 张，单张精看 ${sourceCounts.single_vision || 0} 张。`,
          `精选候选 ${counts.featured || 0}，待判断 ${counts.pending || 0}，需要人工复核 ${reviews.filter((review) => review.needsHumanReview).length}。`
        ].join(' ');
        const db = getDb();
        const tx = db.transaction(() => {
          db.prepare(`
            INSERT INTO brain_runs (id, batch_id, scope, status, model, reviewed_count, summary, strategy_json, bucket_counts_json, input_snapshot_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            runId,
            context.batchId,
            'batch',
            'completed',
            config.model,
            reviews.length,
            summary,
            JSON.stringify({ summary: String(input.strategySummary || ''), toolchain: 'harness', sourceCounts }),
            JSON.stringify(counts),
            JSON.stringify({ totalPhotos: batch.photos.length, sourceCounts }),
            createdAt,
            createdAt
          );
          db.prepare('DELETE FROM brain_bucket_assignments WHERE batch_id = ?').run(context.batchId);
          db.prepare('DELETE FROM brain_group_rankings WHERE batch_id = ?').run(context.batchId);
          for (const review of reviews) saveReview(review, context.batchId);
          const insertGroup = db.prepare(`
            INSERT INTO brain_group_rankings (id, run_id, batch_id, group_type, group_key, photo_id, rank, reason, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const group of groupReviews) {
            for (const role of group.roles) {
              insertGroup.run(crypto.randomUUID(), runId, context.batchId, 'similarBursts', group.groupId, role.photoId, role.groupRank, group.groupReason, createdAt, createdAt);
            }
          }
          db.prepare('INSERT INTO brain_events (id, run_id, event_type, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(crypto.randomUUID(), runId, 'run.completed', summary, JSON.stringify({ counts, sourceCounts, groupReviews: groupReviews.length }), createdAt);
        });
        tx();
        context.emitLog({
          level: 'success',
          phase: 'write',
          title: '写入大脑审片结果',
          message: summary,
          progress: { current: reviews.length, total: reviews.length }
        });
        return {
          runId,
          status: 'completed',
          reviewed: reviews.length,
          summary,
          bucketCounts: counts,
          groupReviewCount: groupReviews.length
        };
      }
    },
    {
      name: 'ExplainCurrentPhoto',
      description: '解释当前照片为什么被推荐、待定或复核，基于已有大脑审片、小模型、人工选择和风险标签。',
      permissionLevel: 'read',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: (_input, context) => {
        const batch = getBatch(context.batchId);
        const photo = batch.photos.find((item) => item.id === context.activePhotoId) || batch.photos[0];
        if (!photo) throw new Error('当前批次没有照片。');
        const evidence = [
          `文件：${photo.fileName}`,
          `人工选择：${photo.decision}`,
          `本地分数：${photo.analysis?.finalScore ?? 'unknown'}`,
          `风险：${photo.analysis?.riskFlags.join(', ') || 'none'}`,
          `大脑分组：${photo.brainReview?.primaryBucket || 'none'}`,
          `大脑建议：${photo.brainReview?.recommendedAction || 'none'}`
        ];
        return {
          photoExplanation: {
            photoId: photo.id,
            title: photo.fileName,
            reason: photo.brainReview?.reason || photo.semantic?.recommendationReason || '目前只有本地分析依据，需要视觉复核后才能给出更稳定的审美判断。',
            evidence
          }
        };
      }
    },
    {
      name: 'ApplyDecision',
      description: '修改单张照片的人工 pick/maybe/reject 决策。必须请求用户确认。',
      permissionLevel: 'decision_write',
      requiresConfirmation: true,
      parameters: {
        type: 'object',
        properties: {
          photoId: { type: 'string' },
          decision: { type: 'string' },
          rating: { type: 'number' }
        },
        required: ['photoId', 'decision'],
        additionalProperties: false
      },
      handler: () => ({ blocked: true })
    },
    {
      name: 'BatchApplyDecisions',
      description: '批量修改人工决策。必须请求用户确认。',
      permissionLevel: 'decision_write',
      requiresConfirmation: true,
      parameters: {
        type: 'object',
        properties: {
          photoIds: { type: 'array', items: { type: 'string' } },
          decision: { type: 'string' }
        },
        required: ['photoIds', 'decision'],
        additionalProperties: false
      },
      handler: () => ({ blocked: true })
    },
    {
      name: 'SetRating',
      description: '修改照片星级。必须请求用户确认。',
      permissionLevel: 'decision_write',
      requiresConfirmation: true,
      parameters: {
        type: 'object',
        properties: {
          photoId: { type: 'string' },
          rating: { type: 'number' }
        },
        required: ['photoId', 'rating'],
        additionalProperties: false
      },
      handler: () => ({ blocked: true })
    },
    {
      name: 'ExportSelected',
      description: '导出已选照片。必须请求用户确认。',
      permissionLevel: 'export',
      requiresConfirmation: true,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: () => ({ blocked: true })
    },
    {
      name: 'DeleteBatch',
      description: '删除批次。危险动作，必须强确认。',
      permissionLevel: 'destructive',
      requiresConfirmation: true,
      parameters: {
        type: 'object',
        properties: {
          batchId: { type: 'string' }
        },
        required: ['batchId'],
        additionalProperties: false
      },
      handler: () => ({ blocked: true })
    },
    {
      name: 'DeleteOriginalFiles',
      description: '删除原片。危险动作，必须强确认。',
      permissionLevel: 'destructive',
      requiresConfirmation: true,
      parameters: {
        type: 'object',
        properties: {
          photoIds: { type: 'array', items: { type: 'string' } }
        },
        required: ['photoIds'],
        additionalProperties: false
      },
      handler: () => ({ blocked: true })
    }
  ];
}
