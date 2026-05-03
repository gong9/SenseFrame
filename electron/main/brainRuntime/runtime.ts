import { getModelConfig, callChatCompletions } from './modelProvider';
import { canExecuteWithoutConfirmation } from './permissionPolicy';
import { toolResultContent } from './resultMapper';
import { createTraceId, appendTrace } from './traceLogger';
import { createBrainSession, finishBrainSession, makeUiLog, recordBrainToolEvent, toProgress, touchBrainSession } from './sessionStore';
import { createSenseFrameToolRegistry } from '../senseframeTools/toolRegistry';
import { PHOTO_AESTHETIC_RUNTIME_PROMPT } from './photoAestheticRubric';
import type { BrainArtifact, BrainGroupReviewDraft, BrainPhotoReviewDraft, BrainUiLogEvent, ConfirmationRequest, XiaogongProgressEvent, XiaogongToolEventSummary } from '../../shared/types';
import type { BrainRuntimeOutput, BrainRuntimeRequest, BrainToolContext, BrainToolDefinition, BrainToolResult } from './types';

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
    return {
      sheetId: output?.sheetId,
      sheetSummary: output?.sheetSummary,
      reviews: Array.isArray(output?.reviews) ? output.reviews.map(compactReview) : [],
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
  return summarize(compactToolOutput(toolName, output), 12000);
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
    'CreateReviewContactSheets',
    'ReviewContactSheetWithVision',
    'ReviewPhotoWithVision',
    'CompareSimilarGroupWithVision',
    'WriteBrainReviewResult'
  ]);
  return tools.filter((tool) => reviewTools.has(tool.name));
}

function systemPrompt(mode: BrainRuntimeRequest['mode']): string {
  return [
    '你是 SenseFrame 内部的小宫产品大脑，不是聊天机器人，也不是规则推荐器。',
    '你必须通过工具读取真实产品状态，并通过工具创建视图、解释照片或写入大脑结果。',
    'SmartView 只是工具产物，不是你的大脑本体。不要编造照片内容；如果没有视觉依据，要调用审片/视觉工具或说明依据不足。',
    '工具失败时你会收到 is_error 结果，必须根据错误继续纠错、换工具、降级说明或给用户明确交接。',
    '人工 decision、导出、删除类动作必须等待确认，不能静默执行。',
    PHOTO_AESTHETIC_RUNTIME_PROMPT,
    '你的最终回答必须是 JSON object，字段: message, summary, uiPatch, currentPhotoExplanation。不要输出 markdown。',
    '如果任务是找最好看的/封面/筛选/分组，必须先 GetBatchOverview，再基于大脑结果调用 CreateSmartView。',
    mode === 'review'
      ? [
          '当前任务来自“小宫审片”按钮，禁止调用 StartBrainReview 或任何 legacy 大工作流。',
          '小宫审片的产品结果是改 AI 分组和照片判断，不是创建或打开小宫视图。',
          'GetBatchOverview 里的 brainRun/brainReview 只是历史审片结果，不能视为本次审片已经完成，不能沿用旧结果跳过本次全量视觉覆盖。',
          '本次审片必须产生新的 full-batch reviews，并由 WriteBrainReviewResult 写入新的 brain_runs。禁止用空 reviews 调用 WriteBrainReviewResult，也禁止只精看当前照片后结束。',
          '你必须像专业摄影师一样先理解整批，再自己选择合适工具。不要把下面能力当固定工作流。',
          '你可以调用 GetVisionRuntimeStatus 查看本次应用生命周期内已经完成的真实视觉覆盖和缓存，避免重复看同一张照片或同一张审片板。',
          '可用策略包括：小批次可以单张精看；中大型批次可用 CreateReviewContactSheets 生成审片板，再用 ReviewContactSheetWithVision 让大脑通过缩略图墙看到整批，然后对关键照片 ReviewPhotoWithVision 高清精看，必要时 CompareSimilarGroupWithVision。',
          'CreateReviewContactSheets 是视觉载体生成工具，不是固定工作流。你可以根据任务和失败反馈主动控制 photoIds、cellsPerSheet、columns、cellWidth、cellHeight、imageHeight、jpegQuality、detail、idPrefix。',
          '已知约束：模型视觉请求可能受网络、请求体、base64 大小、模型视觉通道限制影响。工具会返回 fileSizeBytes、base64ApproxBytes、imageWidth、imageHeight、cells、photoIds、params；遇到 ReviewContactSheetWithVision 失败时，必须读取这些指标，自主决定压缩、拆分、降低 detail、只重建失败 photoIds，继续补齐视觉覆盖。重建失败部分时使用新的 idPrefix，方便追踪新审片板。',
          '最终 WriteBrainReviewResult 必须覆盖整批每一张照片；只写部分照片会被工具拒绝。',
          'ReviewPhotoWithVision 只返回单张草稿，不写库；CompareSimilarGroupWithVision 只返回组比较草稿，不写库；只有 WriteBrainReviewResult 可以写入 brain_*。',
          '不要固定审片张数。大脑必须至少通过审片板看过整批；单张高清精看用于精选、疑难、闭眼/表情争议和组内代表候选。',
          'featured 是交付级精选/封面候选，不是“有一点候选价值”。如果整批都很差，可以 0 张或极少张 featured。普通有情绪但背景杂、逆光灰雾、主体糊、构图随拍的照片应归 similarBursts/eyeReview/technical，而不是 featured。',
          'recommendedAction=maybe/review 的照片默认不是 featured；除非高清单张确认达到交付级，否则只能作为备选或复核。',
          '每张照片结果要保留 reviewSource：sheet_vision 表示审片板看过，single_vision 表示单张高清看过，group_vision 表示组比较判断。'
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

function toolProductCopy(toolName: string): { phase: BrainUiLogEvent['phase']; title: string; message?: string } {
  const copy: Record<string, { phase: BrainUiLogEvent['phase']; title: string; message?: string }> = {
    GetWorkspaceContext: { phase: 'workspace', title: '读取工作台状态' },
    GetBatchOverview: { phase: 'understanding', title: '理解整批照片', message: '正在汇总质量分布、风险标签、人工选择和连拍结构。' },
    GetVisionRuntimeStatus: { phase: 'planning', title: '检查视觉覆盖', message: '正在确认哪些审片板和照片已经看过，避免重复请求。' },
    DecideReviewStrategy: { phase: 'planning', title: '制定审片策略', message: '正在决定哪些照片需要看图、哪些连拍组需要比较。' },
    CreateReviewContactSheets: { phase: 'vision', title: '生成整批审片板', message: '正在把整批照片排成缩略图墙，方便小宫一次覆盖全部素材。' },
    ReviewContactSheetWithVision: { phase: 'vision', title: '查看审片板', message: '小宫正在通过缩略图墙扫完整批照片。' },
    GetCurrentPhoto: { phase: 'understanding', title: '读取当前照片' },
    GenerateLocalCandidates: { phase: 'planning', title: '整理候选线索' },
    ReviewPhotoWithVision: { phase: 'vision', title: '查看照片画面' },
    CompareSimilarGroupWithVision: { phase: 'compare', title: '比较连拍组', message: '正在从相似照片里判断代表图和备选图。' },
    WriteBrainReviewResult: { phase: 'write', title: '写入小宫审片结果' },
    CreateSmartView: { phase: 'ui', title: '生成智能视图' },
    ShowSmartView: { phase: 'ui', title: '打开智能视图' },
    ExplainCurrentPhoto: { phase: 'understanding', title: '解释当前照片' },
    ApplyDecision: { phase: 'confirmation', title: '准备修改照片选择' },
    BatchApplyDecisions: { phase: 'confirmation', title: '准备批量修改选择' },
    SetRating: { phase: 'confirmation', title: '准备修改星级' },
    ExportSelected: { phase: 'confirmation', title: '准备导出已选照片' },
    DeleteBatch: { phase: 'confirmation', title: '准备删除批次' },
    DeleteOriginalFiles: { phase: 'confirmation', title: '准备删除原片' }
  };
  return copy[toolName] || { phase: 'tool', title: '执行小宫动作' };
}

function shouldAbortSiblingToolCalls(result: BrainToolResult): boolean {
  if (!result.isError) return false;
  if (result.toolName === 'ReviewContactSheetWithVision') return true;
  if (result.toolName === 'ReviewPhotoWithVision' && result.content.includes('vision_payload_or_network_failure')) return true;
  return false;
}

function isParallelVisionTool(toolName: string): boolean {
  return toolName === 'ReviewPhotoWithVision' || toolName === 'ReviewContactSheetWithVision';
}

function visionToolConcurrency(toolName: string): number {
  const configured = Number(process.env.SENSEFRAME_BRAIN_VISION_CONCURRENCY);
  if (Number.isFinite(configured) && configured >= 1) return Math.min(6, Math.floor(configured));
  return toolName === 'ReviewPhotoWithVision' ? 3 : 2;
}

export async function runSenseFrameBrainRuntime(
  request: BrainRuntimeRequest,
  onProgress?: (event: XiaogongProgressEvent) => void
): Promise<BrainRuntimeOutput> {
  const config = getModelConfig();
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
    emitLog
  };

  appendTrace(traceId, 'runtime.started', { request, model: config.model });
  emitLog({
    level: 'info',
    phase: 'understanding',
    title: '理解任务',
    message: request.message
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(request.mode) },
    {
      role: 'user',
      content: [
        `任务: ${request.message}`,
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

    const productCopy = toolProductCopy(tool.name);
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
      recordBrainToolEvent(sessionId, skipped, input, undefined, '需要用户确认');
      confirmation = {
        id: `${sessionId}:${tool.name}:${toolCallId}`,
        title: `需要确认：${productCopy.title}`,
        message: `小宫想执行“${productCopy.title}”，这属于 ${tool.permissionLevel} 权限，必须由你确认后才能继续。`,
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
        content: '这个工具需要用户确认，运行时已拦截，不能直接执行。',
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
        title: `${productCopy.title}失败`,
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
      title: turn === 0 ? '制定策略' : '根据工具结果继续判断',
      message: `第 ${turn + 1} 轮`
    });

    const response = await callChatCompletions(config, {
      messages,
      tools: asToolDefinitions(tools),
      tool_choice: 'auto',
      response_format: { type: 'json_object' }
    });
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
              title: '并行查看画面',
              message: `本轮 ${batch.length} 个 ${toolName} 相互独立，并发 ${visionToolConcurrency(toolName)} 个执行。`,
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
                    ? `同批前序工具 ${firstAbort.toolName} 失败，已取消本轮未启动工具 ${item.tool.name}。`
                    : `本轮并发调度已取消未启动工具 ${item.tool.name}。`,
                  '这不是最终失败；请根据已有成功结果和前一个 tool_use_error 的 payload 指标重新规划，例如压缩、拆分、降低 detail、只重建失败 photoIds 后继续补齐视觉覆盖。'
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
                title: '等待小宫重新规划',
                message: `${firstAbort.toolName} 失败，本轮并发中未启动的 ${skippedCount} 个工具已取消，已完成的结果会一起交回大脑。`,
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
                `同批前序工具 ${result.toolName} 失败，已取消本轮后续工具 ${siblingName}。`,
                '这不是最终失败；请根据前一个 tool_use_error 的 payload 指标重新规划，例如压缩、拆分、降低 detail、只重建失败 photoIds 后继续补齐视觉覆盖。'
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
            title: '等待小宫重新规划',
            message: `${result.toolName} 失败，本轮后续 ${remaining.length} 个工具已取消，交回大脑根据失败反馈继续判断。`,
            toolName: result.toolName
          });
          break;
        }
      }
      continue;
    }

    const parsed = parseJsonObject(String(message.content || ''));
    finalMessage = modelText(parsed.message, modelText(parsed.summary, '小宫任务完成。'));
    finalSummary = typeof parsed.summary === 'string' ? parsed.summary : finalMessage;
    if (request.mode !== 'review' && parsed.uiPatch && !uiPatch) uiPatch = parsed.uiPatch;
    if (parsed.currentPhotoExplanation && !currentPhotoExplanation) currentPhotoExplanation = parsed.currentPhotoExplanation;
    break;
  }

  if (!finalMessage) {
    finalMessage = artifacts.length ? '小宫已完成任务，并生成了结构化结果。' : '小宫没有生成可执行结果。';
    finalSummary = finalMessage;
    if (!artifacts.length) finalStatus = 'failed';
  }
  if (request.mode === 'review' && !stateWrites.some((item) => item.target === 'brain_runs')) {
    finalStatus = 'failed';
    finalMessage = '小宫审片没有完成审片结果写入，任务不能视为完成。';
    finalSummary = finalMessage;
  }
  if (confirmation && finalStatus !== 'failed') finalStatus = 'needs_confirmation';
  const needsConfirmation = Boolean(confirmation);

  emitLog({
    level: finalStatus === 'failed' ? 'error' : needsConfirmation ? 'question' : 'success',
    phase: finalStatus === 'failed' ? 'failed' : needsConfirmation ? 'confirmation' : 'done',
    title: finalStatus === 'failed' ? '任务失败' : needsConfirmation ? '等待确认' : '任务完成',
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
