import crypto from 'node:crypto';
import { getDb } from '../db';
import { getBatch } from '../photoPipeline';
import { buildBatchContext, bucketCounts, callVisionModel, createHeuristicReview, parseReview, saveReview } from '../brainService';
import { callChatCompletions, getModelConfig } from '../brainRuntime/modelProvider';
import { createSmartView, getSmartView } from '../xiaogongSmartViewService';
import type {
  BatchView,
  BrainBucket,
  BrainGroupReviewDraft,
  BrainPhotoReview,
  BrainPhotoReviewDraft,
  BrainReviewStrategy,
  Cluster,
  Decision,
  PhotoView,
  SmartViewItem
} from '../../shared/types';
import type { BrainToolDefinition } from '../brainRuntime/types';

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

function normalizeBucket(value: unknown): BrainBucket {
  const buckets: BrainBucket[] = ['featured', 'closedEyes', 'eyeReview', 'subject', 'technical', 'duplicates', 'similarBursts', 'pending'];
  return buckets.includes(value as BrainBucket) ? value as BrainBucket : 'pending';
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
    groupId: group?.groupId,
    groupRank: role?.groupRank,
    groupRole: role?.groupRole,
    representativeRank: role?.groupRank,
    groupReason: group?.groupReason,
    model,
    createdAt: now()
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

export function createSenseFrameToolRegistry(): BrainToolDefinition[] {
  return [
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
        const draft: BrainPhotoReviewDraft = {
          photoId: photo.id,
          primaryBucket: parsed.primaryBucket,
          secondaryBuckets: parsed.secondaryBuckets,
          confidence: parsed.confidence,
          recommendedAction: parsed.recommendedAction,
          reason: parsed.reason,
          smallModelOverrides: parsed.smallModelOverrides,
          needsHumanReview: parsed.needsHumanReview,
          visualScores: parsed.visualScores
        };
        context.emitLog({
          level: 'success',
          phase: 'vision',
          title: `完成 ${photo.fileName} -> ${draft.primaryBucket}`,
          message: draft.reason,
          photoId: photo.id,
          photoFileName: photo.fileName
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
            reviewMap.set(item.photoId, {
              photoId: item.photoId,
              primaryBucket: normalizeBucket(item.primaryBucket),
              secondaryBuckets: Array.isArray(item.secondaryBuckets) ? item.secondaryBuckets.map(normalizeBucket) : [],
              confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
              recommendedAction: normalizeAction(item.recommendedAction),
              reason: String(item.reason || ''),
              smallModelOverrides: Array.isArray(item.smallModelOverrides) ? item.smallModelOverrides.map(String) : [],
              needsHumanReview: Boolean(item.needsHumanReview),
              visualScores: item.visualScores || { visualQuality: 0.5, expression: 0.5, moment: 0.5, composition: 0.5, backgroundCleanliness: 0.5, storyValue: 0.5 }
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
              content: '你是 SenseFrame 小宫大脑的连拍/相似组比较器。你不能写数据库，只能基于已有单张视觉复核和本地上下文选择组内代表图。输出 JSON。'
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
      description: '写入大脑最终审片结果。只有这个工具可以写 brain_runs、brain_bucket_assignments、brain_group_rankings、brain_events。',
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
        const reviews: BrainPhotoReview[] = (Array.isArray(input?.reviews) ? input.reviews : [])
          .filter((draft: any) => known.has(String(draft.photoId)))
          .map((draft: any) => draftToReview({
            photoId: String(draft.photoId),
            primaryBucket: normalizeBucket(draft.primaryBucket),
            secondaryBuckets: Array.isArray(draft.secondaryBuckets) ? draft.secondaryBuckets.map(normalizeBucket) : [],
            confidence: Math.max(0, Math.min(1, Number(draft.confidence) || 0.5)),
            recommendedAction: normalizeAction(draft.recommendedAction),
            reason: String(draft.reason || '大脑未返回明确理由。'),
            smallModelOverrides: Array.isArray(draft.smallModelOverrides) ? draft.smallModelOverrides.map(String) : [],
            needsHumanReview: Boolean(draft.needsHumanReview),
            visualScores: draft.visualScores || { visualQuality: 0.5, expression: 0.5, moment: 0.5, composition: 0.5, backgroundCleanliness: 0.5, storyValue: 0.5 }
          }, runId, config.model, groupByPhoto.get(String(draft.photoId))));
        if (!reviews.length) throw new Error('WriteBrainReviewResult 没有收到有效 reviews，拒绝写入。');
        const counts = bucketCounts(reviews);
        const summary = [
          `小宫大脑完成审片：写入 ${reviews.length} 张照片。`,
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
            JSON.stringify({ summary: String(input.strategySummary || ''), toolchain: 'harness' }),
            JSON.stringify(counts),
            JSON.stringify({ totalPhotos: batch.photos.length }),
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
            .run(crypto.randomUUID(), runId, 'run.completed', summary, JSON.stringify({ counts, groupReviews: groupReviews.length }), createdAt);
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
