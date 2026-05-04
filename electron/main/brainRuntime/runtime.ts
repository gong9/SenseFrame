import { getModelConfig, callChatCompletions } from './modelProvider';
import { canExecuteWithoutConfirmation } from './permissionPolicy';
import { toolResultContent } from './resultMapper';
import { createTraceId, appendTrace } from './traceLogger';
import { createBrainSession, finishBrainSession, makeUiLog, recordBrainToolEvent, toProgress, touchBrainSession } from './sessionStore';
import { createSenseFrameToolRegistry } from '../senseframeTools/toolRegistry';
import { PHOTO_AESTHETIC_RUNTIME_PROMPT } from './photoAestheticRubric';
import type { BrainArtifact, BrainGroupReviewDraft, BrainPhotoReviewDraft, BrainUiLogEvent, ConfirmationRequest, XiaogongProgressEvent, XiaogongToolEventSummary } from '../../shared/types';
import type { BrainRuntimeOutput, BrainRuntimeRequest, BrainToolContext, BrainToolDefinition, BrainToolResult } from './types';
import type { AppLanguage } from '../../shared/types';

type ChatMessage = Record<string, any>;

function summarize(value: unknown, limit = 30000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}\n...<truncated>` : text;
}

function compactReview(review: any): Record<string, unknown> {
  return {
    photoId: review?.photoId,
    primaryBucket: review?.primaryBucket,
    confidence: review?.confidence,
    recommendedAction: review?.recommendedAction,
    needsHumanReview: review?.needsHumanReview,
    reviewSource: review?.reviewSource,
    sheetId: review?.sheetId,
    sheetCell: review?.sheetCell,
    visualScores: review?.visualScores,
    aestheticPass: review?.aestheticPass,
    fatalFlaws: review?.fatalFlaws,
    reason: typeof review?.reason === 'string' ? review.reason.slice(0, 260) : review?.reason
  };
}

function reviewSignal(review: any): Record<string, unknown> {
  const scores = review?.visualScores || {};
  return {
    photoId: review?.photoId,
    bucket: review?.primaryBucket,
    action: review?.recommendedAction,
    confidence: review?.confidence,
    source: review?.reviewSource,
    sheetId: review?.sheetId,
    cell: review?.sheetCell,
    needsHumanReview: review?.needsHumanReview,
    deliverableScore: scores.deliverableScore,
    curationScore: typeof scores.visualQuality === 'number'
      ? Number((
          scores.visualQuality * 0.18
          + scores.expression * 0.18
          + scores.moment * 0.18
          + scores.composition * 0.16
          + scores.backgroundCleanliness * 0.14
          + scores.storyValue * 0.16
        ).toFixed(3))
      : undefined,
    fatalFlaws: review?.fatalFlaws,
    reasonBrief: typeof review?.reason === 'string' ? review.reason.slice(0, 120) : undefined
  };
}

function topReviewSignals(reviews: any[], predicate: (review: any) => boolean, limit: number): Record<string, unknown>[] {
  return reviews
    .filter(predicate)
    .sort((a, b) => Number(b?.visualScores?.deliverableScore ?? b?.confidence ?? 0) - Number(a?.visualScores?.deliverableScore ?? a?.confidence ?? 0))
    .slice(0, limit)
    .map(reviewSignal);
}

function compactToolOutput(toolName: string, output: any): unknown {
  if (toolName === 'GetBatchOverview') {
    const photos = Array.isArray(output?.photos) ? output.photos : [];
    return {
      batch: output?.batch,
      groups: output?.groups,
      photos: photos.map((photo: any) => ({
        id: photo.id,
        fileName: photo.fileName,
        decision: photo.decision,
        rating: photo.rating,
        clusterId: photo.clusterId,
        rankInCluster: photo.rankInCluster,
        recommended: photo.recommended,
        analysis: photo.analysis,
        brainReview: photo.brainReview ? {
          primaryBucket: photo.brainReview.primaryBucket,
          confidence: photo.brainReview.confidence,
          recommendedAction: photo.brainReview.recommendedAction,
          needsHumanReview: photo.brainReview.needsHumanReview,
          visualScores: photo.brainReview.visualScores,
          aestheticPass: photo.brainReview.aestheticPass,
          fatalFlaws: photo.brainReview.fatalFlaws,
          groupId: photo.brainReview.groupId,
          groupRank: photo.brainReview.groupRank,
          reason: typeof photo.brainReview.reason === 'string' ? photo.brainReview.reason.slice(0, 180) : photo.brainReview.reason
        } : undefined
      }))
    };
  }
  if (toolName === 'ReviewContactSheetWithVision') {
    const reviews = Array.isArray(output?.reviews) ? output.reviews : [];
    return {
      sheetId: output?.sheetId,
      sheetSummary: output?.sheetSummary,
      coverage: {
        reviewed: reviews.length,
        photoIds: reviews.map((review: any) => review?.photoId).filter(Boolean)
      },
      bucketCounts: reviews.reduce((acc: Record<string, number>, review: any) => {
        const key = String(review?.primaryBucket || 'pending');
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      candidateSignals: topReviewSignals(reviews, (review) => review?.primaryBucket === 'featured' || review?.recommendedAction === 'pick' || review?.needsHumanReview, 8),
      singleVisionPhotoIds: output?.singleVisionPhotoIds,
      cacheHit: output?.cacheHit
    };
  }
  if (toolName === 'ReviewPhotoWithVision') {
    return {
      review: compactReview(output?.review),
      cacheHit: output?.cacheHit
    };
  }
  if (toolName === 'CompareSimilarGroupWithVision') {
    return output?.groupReview ? {
      groupReview: {
        groupId: output.groupReview.groupId,
        representativePhotoId: output.groupReview.representativePhotoId,
        rankedPhotoIds: output.groupReview.rankedPhotoIds,
        groupReason: typeof output.groupReview.groupReason === 'string' ? output.groupReview.groupReason.slice(0, 320) : output.groupReview.groupReason,
        roles: output.groupReview.roles
      }
    } : output;
  }
  if (toolName === 'WriteBrainReviewResult') {
    return {
      runId: output?.runId,
      status: output?.status,
      reviewed: output?.reviewed,
      summary: output?.summary,
      bucketCounts: output?.bucketCounts,
      groupReviewCount: output?.groupReviewCount
    };
  }
  return output;
}

function summarizeToolOutput(toolName: string, output: any): string {
  return summarize(compactToolOutput(toolName, output), 7000);
}

function asToolDefinitions(tools: BrainToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: `${tool.description}\n权限: ${tool.permissionLevel}${tool.requiresConfirmation ? '，需要用户确认' : ''}`,
      parameters: tool.parameters
    }
  }));
}

function toolsForMode(mode: BrainRuntimeRequest['mode'], tools: BrainToolDefinition[]): BrainToolDefinition[] {
  if (mode !== 'review') return tools;
  const reviewTools = new Set([
    'GetBatchOverview',
    'GetVisionRuntimeStatus',
    'DecideReviewStrategy',
    'CreateCompressedReviewContactSheets',
    'CreateReviewContactSheets',
    'ValidateReviewContactSheet',
    'ReviewContactSheetWithVision',
    'ReviewPhotoWithVision',
    'CompareSimilarGroupWithVision',
    'WriteBrainReviewResult',
    'CreateSmartView'
  ]);
  return tools.filter((tool) => reviewTools.has(tool.name));
}

function systemPrompt(mode: BrainRuntimeRequest['mode'], language: AppLanguage): string {
  const productCopyRule = language === 'en-US'
    ? 'Any user-facing reason/groupReason/summary/uiPatch.notice/smartView.name/smartView.summary must be written in English product language. Do not leak internal field names like cell, keeper, featured, bucket, primaryBucket, recommendedAction, photoId.'
    : '写给用户看的 reason、groupReason、summary、uiPatch.notice、smartView.name、smartView.summary 必须使用摄影师能理解的中文产品话术；禁止出现 cell、keeper、featured、bucket、primaryBucket、recommendedAction、photoId 等内部字段或英文分组名。';
  return [
    language === 'en-US'
      ? 'You are the internal SenseFrame brain for Xiaogong, not a chat bot and not a rule recommender.'
      : '你是 SenseFrame 内部的小宫产品大脑，不是聊天机器人，也不是规则推荐器。',
    language === 'en-US'
      ? 'You must read real product state through tools, then create views, explain photos, or write brain results through tools.'
      : '你必须通过工具读取真实产品状态，并通过工具创建视图、解释照片或写入大脑结果。',
    language === 'en-US'
      ? 'SmartView is only a tool artifact, not your brain itself. Do not invent photo content; if visual evidence is missing, call vision/review tools or say the evidence is insufficient.'
      : 'SmartView 只是工具产物，不是你的大脑本体。不要编造照片内容；如果没有视觉依据，要调用审片/视觉工具或说明依据不足。',
    language === 'en-US'
      ? 'When a tool fails you receive is_error and must keep correcting, switching tools, degrading gracefully, or handing off clearly to the user.'
      : '工具失败时你会收到 is_error 结果，必须根据错误继续纠错、换工具、降级说明或给用户明确交接。',
    language === 'en-US'
      ? 'Human decision, export, and deletion actions must wait for confirmation and cannot be executed silently.'
      : '人工 decision、导出、删除类动作必须等待确认，不能静默执行。',
    PHOTO_AESTHETIC_RUNTIME_PROMPT,
    language === 'en-US'
      ? 'Your final answer must be a JSON object with fields: message, summary, uiPatch, currentPhotoExplanation. Do not output markdown.'
      : '你的最终回答必须是 JSON object，字段: message, summary, uiPatch, currentPhotoExplanation。不要输出 markdown。',
    language === 'en-US'
      ? 'If the task is finding the best photos / cover / screening / grouping, you must first call GetBatchOverview, then call CreateSmartView based on brain results.'
      : '如果任务是找最好看的/封面/筛选/分组，必须先 GetBatchOverview，再基于大脑结果调用 CreateSmartView。',
    productCopyRule,
    mode === 'review'
      ? [
          language === 'en-US'
            ? 'This task comes from the “Xiaogong Review” button. Do not call StartBrainReview or any legacy workflow.'
            : '当前任务来自“小宫审片”按钮，禁止调用 StartBrainReview 或任何 legacy 大工作流。',
          language === 'en-US'
            ? 'The product result of Xiaogong Review is first to update AI groups and photo decisions; after writing the full-batch result, also create a SmartView for this review so the user can immediately inspect the photos selected by the brain.'
            : '小宫审片的产品结果首先是改 AI 分组和照片判断；写入全批结果后，还要用 CreateSmartView 创建本次审片结果视图，方便用户立刻查看大脑筛出的照片。',
          language === 'en-US'
            ? 'brainRun/brainReview in GetBatchOverview are only historical review results. They do not mean this run is finished and cannot be reused to skip full visual coverage.'
            : 'GetBatchOverview 里的 brainRun/brainReview 只是历史审片结果，不能视为本次审片已经完成，不能沿用旧结果跳过本次全量视觉覆盖。',
          language === 'en-US'
            ? 'This run must produce new full-batch reviews and write them into new brain_runs via WriteBrainReviewResult. Do not call WriteBrainReviewResult with empty reviews, and do not stop after only inspecting the current photo.'
            : '本次审片必须产生新的 full-batch reviews，并由 WriteBrainReviewResult 写入新的 brain_runs。禁止用空 reviews 调用 WriteBrainReviewResult，也禁止只精看当前照片后结束。',
          language === 'en-US'
            ? 'Think like a professional photographer: understand the full batch first, then choose tools yourself. Do not treat the capabilities below as a fixed workflow.'
            : '你必须像专业摄影师一样先理解整批，再自己选择合适工具。不要把下面能力当固定工作流。',
          language === 'en-US'
            ? 'You may call GetVisionRuntimeStatus to inspect the real visual coverage and cache already completed in this app lifecycle, so you do not inspect the same photo or contact sheet twice.'
            : '你可以调用 GetVisionRuntimeStatus 查看本次应用生命周期内已经完成的真实视觉覆盖和缓存，避免重复看同一张照片或同一张审片板。',
          language === 'en-US'
            ? 'GetVisionRuntimeStatus returns coveredPhotoIds, missingPhotoIds, bucketCounts, and candidateSignals accumulated in this runtime. Visual tool results in context are only compressed summaries; the runtime keeps the full drafts. In the end you can call WriteBrainReviewResult directly and the runtime will fill in the accumulated full reviews automatically.'
            : 'GetVisionRuntimeStatus 会返回本次 runtime 已累积的 coveredPhotoIds、missingPhotoIds、bucketCounts、candidateSignals。视觉工具结果在上下文里只给压缩摘要，完整草稿由 runtime 记住；最终可直接调用 WriteBrainReviewResult，runtime 会自动补入已累积的全量 reviews。',
          language === 'en-US'
            ? 'Before generating large contact sheets or patching failures, prefer CreateCompressedReviewContactSheets and explicitly decide photoIds, cellsPerSheet, columns, cellWidth, cellHeight, imageHeight, jpegQuality, detail, and targetBudgetBytes yourself. The tool only generates the compressed sheet and returns real size; it does not choose strategy for you.'
            : '在生成大型审片板或补失败照片之前，优先调用 CreateCompressedReviewContactSheets，并由你自己显式决定 photoIds、cellsPerSheet、columns、cellWidth、cellHeight、imageHeight、jpegQuality、detail、targetBudgetBytes。工具只执行压缩生成并返回真实体积，不替你选择策略。',
          language === 'en-US'
            ? 'Available strategies include: small batches can be inspected one photo at a time; medium and large batches can use CreateReviewContactSheets to generate a contact sheet, optionally ValidateReviewContactSheet to verify the artifact, then ReviewContactSheetWithVision so the brain sees the batch through the thumbnail wall, followed by ReviewPhotoWithVision for critical photos and CompareSimilarGroupWithVision when needed.'
            : '可用策略包括：小批次可以单张精看；中大型批次可用 CreateReviewContactSheets 生成审片板，必要时 ValidateReviewContactSheet 校验证据工件，再用 ReviewContactSheetWithVision 让大脑通过缩略图墙看到整批，然后对关键照片 ReviewPhotoWithVision 高清精看，必要时 CompareSimilarGroupWithVision。',
          language === 'en-US'
            ? 'CreateReviewContactSheets is a visual artifact generator, not a fixed workflow. You may actively control photoIds, cellsPerSheet, columns, cellWidth, cellHeight, imageHeight, jpegQuality, detail, and idPrefix based on task and failure feedback. The tool returns validation and payload metrics; if validation fails, fix or rebuild first and do not draw conclusions from broken evidence.'
            : 'CreateReviewContactSheets 是视觉载体生成工具，不是固定工作流。你可以根据任务和失败反馈主动控制 photoIds、cellsPerSheet、columns、cellWidth、cellHeight、imageHeight、jpegQuality、detail、idPrefix。工具会返回 validation 和 payload 指标；validation 不通过时必须先修复或重建，不要用坏证据下结论。',
          language === 'en-US'
            ? 'Known limits: model vision requests may be constrained by network, request body size, base64 size, and the model vision channel. The tool returns fileSizeBytes, base64ApproxBytes, estimatedRequestBytes, imageWidth, imageHeight, cells, photoIds, params, and validation. If ReviewContactSheetWithVision fails, inspect these metrics and decide by yourself whether to compress, split, lower detail, or rebuild only the failed photoIds to keep visual coverage complete. Use a new idPrefix when rebuilding failed parts so the new sheet is traceable.'
            : '已知约束：模型视觉请求可能受网络、请求体、base64 大小、模型视觉通道限制影响。工具会返回 fileSizeBytes、base64ApproxBytes、estimatedRequestBytes、imageWidth、imageHeight、cells、photoIds、params、validation；遇到 ReviewContactSheetWithVision 失败时，必须读取这些指标，自主决定压缩、拆分、降低 detail、只重建失败 photoIds，继续补齐视觉覆盖。重建失败部分时使用新的 idPrefix，方便追踪新审片板。',
          language === 'en-US'
            ? 'The final WriteBrainReviewResult must cover every photo in the batch; partial writes will be rejected by the tool. After WriteBrainReviewResult succeeds, call CreateSmartView: if featured exists, create a featured view; if featured is 0, create the most worth-seeing keeper/review candidate view and make it clear in the summary that this is not a work-level featured selection.'
            : '最终 WriteBrainReviewResult 必须覆盖整批每一张照片；只写部分照片会被工具拒绝。WriteBrainReviewResult 成功后，再调用 CreateSmartView：如果有 featured，就创建精选视图；如果 featured 为 0，就创建最值得看的 keeper/复核候选视图，并在 summary 里明确不是作品级精选。',
          language === 'en-US'
            ? 'CreateSmartView must receive the photoIds you explicitly selected; do not let the tool sort them automatically. The number of views depends on your review result and must not be fixed.'
            : 'CreateSmartView 必须传入你明确选定的 photoIds；不要让工具自动排序。视图数量由你根据审片结果决定，不要固定张数。',
          language === 'en-US'
            ? 'ReviewPhotoWithVision returns only a single-photo draft and does not write to the database; CompareSimilarGroupWithVision returns only a group comparison draft and does not write to the database; only WriteBrainReviewResult may write brain_*.'
            : 'ReviewPhotoWithVision 只返回单张草稿，不写库；CompareSimilarGroupWithVision 只返回组比较草稿，不写库；只有 WriteBrainReviewResult 可以写入 brain_*。',
          language === 'en-US'
            ? 'Do not fix the number of photos to review. The brain must inspect the whole batch through contact sheets at least once; single-photo high-resolution inspection is for featured photos, hard decisions, closed-eye/expression disputes, and group representative candidates.'
            : '不要固定审片张数。大脑必须至少通过审片板看过整批；单张高清精看用于精选、疑难、闭眼/表情争议和组内代表候选。',
          language === 'en-US'
            ? 'featured means delivery-grade featured / cover candidate, not “some candidate value”. If the entire batch is weak, featured can be 0 or very few. Ordinary photos with emotion but cluttered background, backlight haze, weak subject, or snapshot-like composition should go to similarBursts / eyeReview / technical instead of featured.'
            : 'featured 是交付级精选/封面候选，不是“有一点候选价值”。如果整批都很差，可以 0 张或极少张 featured。普通有情绪但背景杂、逆光灰雾、主体糊、构图随拍的照片应归 similarBursts/eyeReview/technical，而不是 featured。',
          language === 'en-US'
            ? 'recommendedAction=maybe means keep / keeper backup, not uncertain; recommendedAction=review means human review is needed. Do not mark ordinary keepers as needsHumanReview=true.'
            : 'recommendedAction=maybe 表示建议保留/备选 keeper，不等于不确定；recommendedAction=review 才表示需要人工复核。普通 keeper 不要全部 needsHumanReview=true。',
          language === 'en-US'
            ? 'Photos with recommendedAction=maybe/review are not featured by default; unless a high-resolution single photo confirms delivery quality, they can only be backups or review items.'
            : 'recommendedAction=maybe/review 的照片默认不是 featured；除非高清单张确认达到交付级，否则只能作为备选或复核。',
          productCopyRule,
          language === 'en-US'
            ? 'Keep reviewSource on every photo result: sheet_vision means the contact sheet was seen, single_vision means a single photo was inspected in high resolution, and group_vision means the group comparison was used.'
            : '每张照片结果要保留 reviewSource：sheet_vision 表示审片板看过，single_vision 表示单张高清看过，group_vision 表示组比较判断。'
        ].join('\n')
      : ''
  ].filter(Boolean).join('\n');
}

function parseJsonObject(text: string): Record<string, any> {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
    return { message: text, summary: text };
  }
}

function modelText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') return JSON.stringify(value);
  return fallback;
}

function uiText(language: AppLanguage, zh: string, en: string): string {
  return language === 'en-US' ? en : zh;
}

function toolProductCopy(toolName: string, language: AppLanguage): { phase: BrainUiLogEvent['phase']; title: string; message?: string } {
  const copy: Record<string, { phase: BrainUiLogEvent['phase']; title: string; message?: string }> = {
    GetWorkspaceContext: { phase: 'workspace', title: uiText(language, '读取工作台状态', 'Read workspace state') },
    GetBatchOverview: { phase: 'understanding', title: uiText(language, '理解整批照片', 'Understand the full batch'), message: uiText(language, '正在汇总质量分布、风险标签、人工选择和连拍结构。', 'Summarizing quality distribution, risk labels, manual selections, and burst structure.') },
    GetVisionRuntimeStatus: { phase: 'planning', title: uiText(language, '检查视觉覆盖', 'Check visual coverage'), message: uiText(language, '正在确认哪些审片板和照片已经看过，避免重复请求。', 'Checking which contact sheets and photos have already been inspected to avoid duplicate requests.') },
    DecideReviewStrategy: { phase: 'planning', title: uiText(language, '制定审片策略', 'Plan review strategy'), message: uiText(language, '正在决定哪些照片需要看图、哪些连拍组需要比较。', 'Deciding which photos need visual inspection and which burst groups need comparison.') },
    CreateCompressedReviewContactSheets: { phase: 'vision', title: uiText(language, '压缩审片板', 'Compress contact sheets'), message: uiText(language, '正在按请求体预算生成压缩后的审片板。', 'Generating compressed contact sheets within the request budget.') },
    CreateReviewContactSheets: { phase: 'vision', title: uiText(language, '生成整批审片板', 'Create batch contact sheets'), message: uiText(language, '正在把整批照片排成缩略图墙，方便小宫一次覆盖全部素材。', 'Arranging the full batch into contact sheets so Xiaogong can cover all assets.') },
    ValidateReviewContactSheet: { phase: 'vision', title: uiText(language, '校验审片板', 'Validate contact sheet'), message: uiText(language, '正在检查缩略图墙是否完整、可解码、映射正确。', 'Checking whether the contact sheet is complete, decodable, and correctly mapped.') },
    ReviewContactSheetWithVision: { phase: 'vision', title: uiText(language, '查看审片板', 'Inspect contact sheet'), message: uiText(language, '小宫正在通过缩略图墙扫完整批照片。', 'Xiaogong is scanning the full batch through the contact sheet.') },
    GetCurrentPhoto: { phase: 'understanding', title: uiText(language, '读取当前照片', 'Read current photo') },
    GenerateLocalCandidates: { phase: 'planning', title: uiText(language, '整理候选线索', 'Collect candidate signals') },
    ReviewPhotoWithVision: { phase: 'vision', title: uiText(language, '查看照片画面', 'Inspect photo') },
    CompareSimilarGroupWithVision: { phase: 'compare', title: uiText(language, '比较连拍组', 'Compare burst group'), message: uiText(language, '正在从相似照片里判断代表图和备选图。', 'Choosing representative and backup frames from similar photos.') },
    WriteBrainReviewResult: { phase: 'write', title: uiText(language, '写入小宫审片结果', 'Write Xiaogong review result') },
    CreateSmartView: { phase: 'ui', title: uiText(language, '生成智能视图', 'Create smart view') },
    ShowSmartView: { phase: 'ui', title: uiText(language, '打开智能视图', 'Open smart view') },
    ExplainCurrentPhoto: { phase: 'understanding', title: uiText(language, '解释当前照片', 'Explain current photo') },
    ApplyDecision: { phase: 'confirmation', title: uiText(language, '准备修改照片选择', 'Prepare decision change') },
    BatchApplyDecisions: { phase: 'confirmation', title: uiText(language, '准备批量修改选择', 'Prepare batch decision change') },
    SetRating: { phase: 'confirmation', title: uiText(language, '准备修改星级', 'Prepare rating change') },
    ExportSelected: { phase: 'confirmation', title: uiText(language, '准备导出已选照片', 'Prepare selected export') },
    DeleteBatch: { phase: 'confirmation', title: uiText(language, '准备删除批次', 'Prepare batch deletion') },
    DeleteOriginalFiles: { phase: 'confirmation', title: uiText(language, '准备删除原片', 'Prepare original file deletion') }
  };
  return copy[toolName] || { phase: 'tool', title: uiText(language, '执行小宫动作', 'Run Xiaogong action') };
}

function shouldAbortSiblingToolCalls(result: BrainToolResult): boolean {
  if (!result.isError) return false;
  if (result.toolName === 'ReviewContactSheetWithVision' || result.toolName === 'ReviewPhotoWithVision') {
    return /vision_payload_or_network_failure|Payload Too Large|fetch failed|timeout|超时|413|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(result.content);
  }
  return false;
}

function isParallelVisionTool(toolName: string): boolean {
  return toolName === 'ReviewPhotoWithVision' || toolName === 'ReviewContactSheetWithVision' || toolName === 'CompareSimilarGroupWithVision';
}

function visionToolConcurrency(toolName: string): number {
  const configured = Number(process.env.SENSEFRAME_BRAIN_VISION_CONCURRENCY);
  if (Number.isFinite(configured) && configured >= 1) return Math.min(6, Math.floor(configured));
  if (toolName === 'ReviewContactSheetWithVision') return 3;
  if (toolName === 'CompareSimilarGroupWithVision') return 3;
  return toolName === 'ReviewPhotoWithVision' ? 3 : 2;
}

export async function runSenseFrameBrainRuntime(
  request: BrainRuntimeRequest,
  onProgress?: (event: XiaogongProgressEvent) => void
): Promise<BrainRuntimeOutput> {
  const config = getModelConfig();
  const language = request.language === 'en-US' ? 'en-US' : 'zh-CN';
  const traceId = createTraceId();
  const sessionId = request.sessionId || createBrainSession({ batchId: request.batchId, message: request.message, intent: request.mode });
  const tools = toolsForMode(request.mode, createSenseFrameToolRegistry());
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const toolEvents: XiaogongToolEventSummary[] = [];
  const artifacts: BrainArtifact[] = [];
  const stateWrites: BrainRuntimeOutput['stateWrites'] = [];
  let uiPatch: BrainRuntimeOutput['uiPatch'];
  let currentPhotoExplanation: BrainRuntimeOutput['currentPhotoExplanation'];
  let confirmation: ConfirmationRequest | undefined;
  let finalMessage = '';
  let finalSummary = '';
  let finalStatus: BrainRuntimeOutput['status'] = 'completed';
  const photoReviewDrafts = new Map<string, BrainPhotoReviewDraft>();
  const groupReviewDrafts = new Map<string, BrainGroupReviewDraft>();

  const emitLog = (event: Omit<BrainUiLogEvent, 'id' | 'sessionId' | 'createdAt' | 'traceId'>, status: XiaogongProgressEvent['status'] = 'running'): void => {
    const uiLog = makeUiLog(sessionId, traceId, event);
    appendTrace(traceId, 'ui_log', uiLog);
    touchBrainSession(sessionId, uiLog.message || uiLog.title);
    try {
      onProgress?.(toProgress(uiLog, status));
    } catch (error) {
      appendTrace(traceId, 'progress.delivery_failed', {
        status,
        title: uiLog.title,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const context: BrainToolContext = {
    sessionId,
    traceId,
    batchId: request.batchId,
    activePhotoId: request.activePhotoId,
    emitLog,
    getPhotoReviewDrafts: () => [...photoReviewDrafts.values()]
  };

  appendTrace(traceId, 'runtime.started', { request, model: config.model });
  emitLog({
    level: 'info',
    phase: 'understanding',
    title: uiText(language, '理解任务', 'Understand task'),
    message: request.message
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(request.mode, language) },
    {
      role: 'user',
      content: [
        `任务: ${request.message}`,
        `uiLanguage: ${language}`,
        `batchId: ${request.batchId}`,
        `currentMode: ${request.currentMode || 'unknown'}`,
        `activePhotoId: ${request.activePhotoId || 'none'}`,
        `smartViewId: ${request.smartViewId || 'none'}`
      ].join('\n')
    }
  ];

  function enrichToolInput(toolName: string, input: Record<string, any>): Record<string, any> {
    if (toolName === 'CompareSimilarGroupWithVision' && (!Array.isArray(input.reviews) || !input.reviews.length)) {
      return { ...input, reviews: [...photoReviewDrafts.values()] };
    }
    if (toolName === 'WriteBrainReviewResult') {
      return {
        ...input,
        reviews: Array.isArray(input.reviews) && input.reviews.length ? input.reviews : [...photoReviewDrafts.values()],
        groupReviews: Array.isArray(input.groupReviews) ? input.groupReviews : [...groupReviewDrafts.values()]
      };
    }
    return input;
  }

  function captureToolOutput(toolName: string, output: any): void {
    if (toolName === 'ReviewPhotoWithVision' && output?.review?.photoId) {
      photoReviewDrafts.set(output.review.photoId, output.review as BrainPhotoReviewDraft);
    }
    if (toolName === 'ReviewContactSheetWithVision' && Array.isArray(output?.reviews)) {
      for (const review of output.reviews) {
        if (review?.photoId) photoReviewDrafts.set(review.photoId, review as BrainPhotoReviewDraft);
      }
    }
    if (toolName === 'CompareSimilarGroupWithVision' && output?.groupReview?.groupId) {
      groupReviewDrafts.set(output.groupReview.groupId, output.groupReview as BrainGroupReviewDraft);
    }
  }

  async function executeTool(tool: BrainToolDefinition, toolCallId: string, input: unknown): Promise<BrainToolResult> {
    const eventBase: XiaogongToolEventSummary = {
      toolName: tool.name,
      permissionLevel: tool.permissionLevel,
      requiresConfirmation: tool.requiresConfirmation,
      status: 'completed'
    };

    const productCopy = toolProductCopy(tool.name, language);
    emitLog({
      level: 'info',
      phase: productCopy.phase,
      title: productCopy.title,
      message: productCopy.message,
      toolName: tool.name
    });

    if (!canExecuteWithoutConfirmation(tool)) {
      const skipped = { ...eventBase, status: 'skipped' as const };
      toolEvents.push(skipped);
      const confirmationTitle = uiText(language, `需要确认：${productCopy.title}`, `Confirmation needed: ${productCopy.title}`);
      const confirmationMessage = uiText(
        language,
        `小宫想执行“${productCopy.title}”，这属于 ${tool.permissionLevel} 权限，必须由你确认后才能继续。`,
        `Xiaogong wants to run “${productCopy.title}”. This requires ${tool.permissionLevel} permission and must be confirmed before continuing.`
      );
      recordBrainToolEvent(sessionId, skipped, input, undefined, confirmationMessage);
      confirmation = {
        id: `${sessionId}:${tool.name}:${toolCallId}`,
        title: confirmationTitle,
        message: confirmationMessage,
        permissionLevel: tool.permissionLevel,
        toolName: tool.name,
        input
      };
      artifacts.push({
        id: confirmation.id,
        type: 'confirmation',
        title: confirmation.title,
        summary: confirmation.message
      });
      finalStatus = 'needs_confirmation';
      emitLog({
        level: 'question',
        phase: 'confirmation',
        title: confirmation.title,
        message: confirmation.message,
        toolName: tool.name
      });
      return {
        toolCallId,
        toolName: tool.name,
        isError: true,
        content: uiText(language, '这个工具需要用户确认，运行时已拦截，不能直接执行。', 'This tool requires user confirmation and was blocked by the runtime. It cannot be executed directly.'),
        structured: { needsConfirmation: true, toolName: tool.name, input }
      };
    }

    try {
      appendTrace(traceId, 'tool.started', { tool: tool.name, input });
      const output = await tool.handler(input, context);
      captureToolOutput(tool.name, output);
      appendTrace(traceId, 'tool.completed', { tool: tool.name, output });
      toolEvents.push(eventBase);
      recordBrainToolEvent(sessionId, eventBase, input, output);

      if (output?.uiPatch) uiPatch = output.uiPatch;
      if (output?.photoExplanation) currentPhotoExplanation = output.photoExplanation;
      if (output?.smartView) {
        artifacts.push({
          id: output.smartView.id,
          type: 'smart_view',
          title: output.smartView.name,
          summary: output.smartView.summary,
          refId: output.smartView.id
        });
        stateWrites.push({ target: 'smart_views', refId: output.smartView.id, count: output.smartView.items?.length, summary: output.smartView.summary });
      }
      if (output?.runId) {
        artifacts.push({
          id: output.runId,
          type: 'brain_run',
          title: '小宫审片',
          summary: output.summary || output.message,
          refId: output.runId
        });
        stateWrites.push({ target: 'brain_runs', refId: output.runId, count: output.reviewed, summary: output.summary || output.message });
      }

      return {
        toolCallId,
        toolName: tool.name,
        isError: false,
        content: summarizeToolOutput(tool.name, output),
        structured: output
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = { ...eventBase, status: 'failed' as const };
      toolEvents.push(failed);
      recordBrainToolEvent(sessionId, failed, input, undefined, message);
      appendTrace(traceId, 'tool.failed', { tool: tool.name, input, error: message });
      emitLog({
        level: 'error',
        phase: 'failed',
        title: uiText(language, `${productCopy.title}失败`, `${productCopy.title} failed`),
        message,
        toolName: tool.name
      });
      return {
        toolCallId,
        toolName: tool.name,
        isError: true,
        content: message
      };
    }
  }

  for (let turn = 0; turn < 80; turn += 1) {
    emitLog({
      level: 'info',
      phase: turn === 0 ? 'planning' : 'tool',
      title: turn === 0 ? uiText(language, '制定策略', 'Plan strategy') : uiText(language, '根据工具结果继续判断', 'Continue from tool results'),
      message: uiText(language, `第 ${turn + 1} 轮`, `Round ${turn + 1}`)
    });

    let response: any;
    try {
      response = await callChatCompletions(config, {
        messages,
        tools: asToolDefinitions(tools),
        tool_choice: 'auto',
        response_format: { type: 'json_object' }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendTrace(traceId, 'model.failed', { turn: turn + 1, error: message });
      emitLog({
        level: 'error',
        phase: 'failed',
        title: uiText(language, '模型请求失败', 'Model request failed'),
        message
      }, 'failed');
      finalStatus = 'failed';
      finalMessage = uiText(language, `小宫大脑模型请求失败：${message}`, `Xiaogong brain model request failed: ${message}`);
      finalSummary = finalMessage;
      break;
    }
    appendTrace(traceId, 'model.response', response);
    const message = response.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (toolCalls.length) {
      messages.push(message);
      for (let index = 0; index < toolCalls.length; index += 1) {
        const call = toolCalls[index];
        const toolName = String(call.function?.name || '');
        const tool = toolMap.get(toolName);
        const argsText = String(call.function?.arguments || '{}');
        const input = enrichToolInput(toolName, parseJsonObject(argsText));
        if (!tool) {
          const result: BrainToolResult = {
            toolCallId: call.id,
            toolName,
            isError: true,
            content: `未知工具：${toolName}`
          };
          messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultContent(result) });
          continue;
        }
        if (isParallelVisionTool(toolName)) {
          const batch: Array<{ call: any; tool: BrainToolDefinition; input: Record<string, any> }> = [{ call, tool, input }];
          let cursor = index + 1;
          while (cursor < toolCalls.length) {
            const nextCall = toolCalls[cursor];
            const nextToolName = String(nextCall.function?.name || '');
            const nextTool = toolMap.get(nextToolName);
            if (!nextTool || nextTool.name !== toolName || !isParallelVisionTool(nextTool.name) || !canExecuteWithoutConfirmation(nextTool)) break;
            batch.push({
              call: nextCall,
              tool: nextTool,
              input: enrichToolInput(nextToolName, parseJsonObject(String(nextCall.function?.arguments || '{}')))
            });
            cursor += 1;
          }
          if (batch.length > 1) {
            emitLog({
              level: 'info',
              phase: 'vision',
              title: uiText(language, '并行查看画面', 'Inspect images in parallel'),
              message: uiText(language, `本轮 ${batch.length} 个 ${toolName} 相互独立，并发 ${visionToolConcurrency(toolName)} 个执行。`, `${batch.length} independent ${toolName} calls in this round; running ${visionToolConcurrency(toolName)} concurrently.`),
              toolName
            });
            const limit = visionToolConcurrency(toolName);
            const results: BrainToolResult[] = new Array(batch.length);
            let next = 0;
            let stopScheduling = false;
            async function worker(): Promise<void> {
              while (next < batch.length) {
                if (stopScheduling) return;
                const current = next;
                next += 1;
                const item = batch[current];
                results[current] = await executeTool(item.tool, item.call.id, item.input);
                if (shouldAbortSiblingToolCalls(results[current])) {
                  stopScheduling = true;
                }
              }
            }
            await Promise.all(Array.from({ length: Math.min(limit, batch.length) }, () => worker()));
            const firstAbort = results.find((result) => result && shouldAbortSiblingToolCalls(result));
            for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
              const result = results[resultIndex];
              const item = batch[resultIndex];
              if (result) {
                messages.push({ role: 'tool', tool_call_id: result.toolCallId, content: toolResultContent(result) });
                continue;
              }
              const skippedResult: BrainToolResult = {
                toolCallId: item.call.id,
                toolName: item.tool.name,
                isError: true,
                content: [
                  firstAbort
                    ? uiText(language, `同批前序工具 ${firstAbort.toolName} 失败，已取消本轮未启动工具 ${item.tool.name}。`, `Earlier sibling tool ${firstAbort.toolName} failed, so unstarted tool ${item.tool.name} was cancelled for this round.`)
                    : uiText(language, `本轮并发调度已取消未启动工具 ${item.tool.name}。`, `Unstarted tool ${item.tool.name} was cancelled by the parallel scheduler for this round.`),
                  uiText(language, '这不是最终失败；请根据已有成功结果和前一个 tool_use_error 的 payload 指标重新规划，例如压缩、拆分、降低 detail、只重建失败 photoIds 后继续补齐视觉覆盖。', 'This is not final failure; re-plan from successful results and the previous tool_use_error payload metrics, for example compress, split, lower detail, or rebuild only failed photoIds to complete visual coverage.')
                ].join('\n')
              };
              messages.push({ role: 'tool', tool_call_id: item.call.id, content: toolResultContent(skippedResult) });
              appendTrace(traceId, 'tool.aborted', { tool: item.tool.name, reason: firstAbort ? `sibling_failed:${firstAbort.toolName}` : 'parallel_scheduler_cancelled' });
              const aborted = {
                toolName: item.tool.name,
                permissionLevel: item.tool.permissionLevel,
                requiresConfirmation: item.tool.requiresConfirmation,
                status: 'skipped' as const
              };
              toolEvents.push(aborted);
              recordBrainToolEvent(sessionId, aborted, item.input, undefined, skippedResult.content);
            }
            if (firstAbort) {
              const skippedCount = Array.from({ length: results.length }).filter((_, resultIndex) => !results[resultIndex]).length;
              emitLog({
                level: 'info',
                phase: 'tool',
                title: uiText(language, '等待小宫重新规划', 'Waiting for Xiaogong to re-plan'),
                message: uiText(language, `${firstAbort.toolName} 失败，本轮并发中未启动的 ${skippedCount} 个工具已取消，已完成的结果会一起交回大脑。`, `${firstAbort.toolName} failed. ${skippedCount} unstarted tools in this parallel round were cancelled; completed results will be returned to the brain.`),
                toolName: firstAbort.toolName
              });
            }
            index = cursor - 1;
            continue;
          }
        }
        const result = await executeTool(tool, call.id, input);
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultContent(result) });
        if (shouldAbortSiblingToolCalls(result)) {
          const remaining = toolCalls.slice(index + 1);
          for (const sibling of remaining) {
            const siblingName = String(sibling.function?.name || '');
            const siblingTool = toolMap.get(siblingName);
            const siblingResult: BrainToolResult = {
              toolCallId: sibling.id,
              toolName: siblingName,
              isError: true,
              content: [
                uiText(language, `同批前序工具 ${result.toolName} 失败，已取消本轮后续工具 ${siblingName}。`, `Earlier sibling tool ${result.toolName} failed, so later tool ${siblingName} was cancelled for this round.`),
                uiText(language, '这不是最终失败；请根据前一个 tool_use_error 的 payload 指标重新规划，例如压缩、拆分、降低 detail、只重建失败 photoIds 后继续补齐视觉覆盖。', 'This is not final failure; re-plan from the previous tool_use_error payload metrics, for example compress, split, lower detail, or rebuild only failed photoIds to complete visual coverage.')
              ].join('\n')
            };
            messages.push({ role: 'tool', tool_call_id: sibling.id, content: toolResultContent(siblingResult) });
            appendTrace(traceId, 'tool.aborted', { tool: siblingName, reason: `sibling_failed:${result.toolName}` });
            if (siblingTool) {
              const aborted = {
                toolName: siblingTool.name,
                permissionLevel: siblingTool.permissionLevel,
                requiresConfirmation: siblingTool.requiresConfirmation,
                status: 'skipped' as const
              };
              toolEvents.push(aborted);
              recordBrainToolEvent(sessionId, aborted, undefined, undefined, siblingResult.content);
            }
          }
          emitLog({
            level: 'info',
            phase: 'tool',
            title: uiText(language, '等待小宫重新规划', 'Waiting for Xiaogong to re-plan'),
            message: uiText(language, `${result.toolName} 失败，本轮后续 ${remaining.length} 个工具已取消，交回大脑根据失败反馈继续判断。`, `${result.toolName} failed. ${remaining.length} later tools were cancelled for this round; returning feedback to the brain for recovery.`),
            toolName: result.toolName
          });
          break;
        }
      }
      continue;
    }

    const parsed = parseJsonObject(String(message.content || ''));
    finalMessage = modelText(parsed.message, modelText(parsed.summary, uiText(language, '小宫任务完成。', 'Xiaogong task completed.')));
    finalSummary = typeof parsed.summary === 'string' ? parsed.summary : finalMessage;
    if (request.mode !== 'review' && parsed.uiPatch && !uiPatch) uiPatch = parsed.uiPatch;
    if (parsed.currentPhotoExplanation && !currentPhotoExplanation) currentPhotoExplanation = parsed.currentPhotoExplanation;
    break;
  }

  if (!finalMessage) {
    finalMessage = artifacts.length
      ? uiText(language, '小宫已完成任务，并生成了结构化结果。', 'Xiaogong completed the task and generated structured results.')
      : uiText(language, '小宫没有生成可执行结果。', 'Xiaogong did not generate an executable result.');
    finalSummary = finalMessage;
    if (!artifacts.length) finalStatus = 'failed';
  }
  if (request.mode === 'review' && !stateWrites.some((item) => item.target === 'brain_runs')) {
    finalStatus = 'failed';
    finalMessage = uiText(language, '小宫审片没有完成审片结果写入，任务不能视为完成。', 'Xiaogong review did not write review results, so the task cannot be considered complete.');
    finalSummary = finalMessage;
  }
  if (confirmation && finalStatus !== 'failed') finalStatus = 'needs_confirmation';
  const needsConfirmation = Boolean(confirmation);

  emitLog({
    level: finalStatus === 'failed' ? 'error' : needsConfirmation ? 'question' : 'success',
    phase: finalStatus === 'failed' ? 'failed' : needsConfirmation ? 'confirmation' : 'done',
    title: finalStatus === 'failed'
      ? uiText(language, '任务失败', 'Task failed')
      : needsConfirmation
        ? uiText(language, '等待确认', 'Waiting for confirmation')
        : uiText(language, '任务完成', 'Task completed'),
    message: finalSummary
  }, finalStatus === 'failed' ? 'failed' : 'completed');

  finishBrainSession({
    sessionId,
    status: finalStatus,
    summary: finalSummary,
    uiPatch,
    viewId: uiPatch?.smartViewId,
    requiresConfirmation: needsConfirmation
  });
  appendTrace(traceId, 'runtime.completed', { status: finalStatus, finalMessage, uiPatch, artifacts, stateWrites });

  const smartViewArtifact = artifacts.find((artifact) => artifact.type === 'smart_view');
  return {
    sessionId,
    status: finalStatus,
    intent: 'best_photos',
    message: finalMessage,
    summary: finalSummary,
    uiPatch,
    smartView: smartViewArtifact && uiPatch?.smartViewId ? {
      id: uiPatch.smartViewId,
      batchId: request.batchId,
      name: smartViewArtifact.title,
      intent: 'best_photos',
      photoCount: stateWrites.find((item) => item.refId === uiPatch?.smartViewId)?.count || 0,
      summary: smartViewArtifact.summary || finalSummary,
      createdAt: new Date().toISOString()
    } : undefined,
    toolEvents,
    artifacts,
    stateWrites,
    confirmation,
    currentPhotoExplanation,
    debugTraceId: traceId
  };
}
