import { getModelConfig, callChatCompletions } from './modelProvider';
import { canExecuteWithoutConfirmation } from './permissionPolicy';
import { toolResultContent } from './resultMapper';
import { createTraceId, appendTrace } from './traceLogger';
import { createBrainSession, finishBrainSession, makeUiLog, recordBrainToolEvent, toProgress } from './sessionStore';
import { createSenseFrameToolRegistry } from '../senseframeTools/toolRegistry';
import type { BrainArtifact, BrainGroupReviewDraft, BrainPhotoReviewDraft, BrainUiLogEvent, ConfirmationRequest, XiaogongProgressEvent, XiaogongToolEventSummary } from '../../shared/types';
import type { BrainRuntimeOutput, BrainRuntimeRequest, BrainToolContext, BrainToolDefinition, BrainToolResult } from './types';

type ChatMessage = Record<string, any>;

function summarize(value: unknown, limit = 30000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}\n...<truncated>` : text;
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
    'DecideReviewStrategy',
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
    '你的最终回答必须是 JSON object，字段: message, summary, uiPatch, currentPhotoExplanation。不要输出 markdown。',
    '如果任务是找最好看的/封面/筛选/分组，必须先 GetBatchOverview，再基于大脑结果调用 CreateSmartView。',
    mode === 'review'
      ? [
          '当前任务来自“小宫审片”按钮，禁止调用 StartBrainReview 或任何 legacy 大工作流。',
          '小宫审片的产品结果是改 AI 分组和照片判断，不是创建或打开小宫视图。',
          '你必须按顺序推进：GetBatchOverview -> DecideReviewStrategy -> ReviewPhotoWithVision -> CompareSimilarGroupWithVision -> WriteBrainReviewResult -> final JSON。',
          'ReviewPhotoWithVision 只返回单张草稿，不写库；CompareSimilarGroupWithVision 只返回组比较草稿，不写库；只有 WriteBrainReviewResult 可以写入 brain_*。',
          '不要固定审片张数。根据批次质量分布、风险 flags、人工选择和相似组结构决定要看哪些照片。'
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
    DecideReviewStrategy: { phase: 'planning', title: '制定审片策略', message: '正在决定哪些照片需要看图、哪些连拍组需要比较。' },
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
    onProgress?.(toProgress(uiLog, status));
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
        content: summarize(output),
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
      for (const call of toolCalls) {
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
        const result = await executeTool(tool, call.id, input);
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultContent(result) });
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
