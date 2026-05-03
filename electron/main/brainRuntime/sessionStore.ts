import crypto from 'node:crypto';
import { getDb } from '../db';
import type { BrainUiLogEvent, XiaogongProgressEvent, XiaogongToolEventSummary, XiaogongUiPatch } from '../../shared/types';

function now(): string {
  return new Date().toISOString();
}

export function createBrainSession(input: { batchId: string; message: string; intent?: string }): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(`
      INSERT INTO xiaogong_sessions (id, batch_id, user_message, intent, status, requires_confirmation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(id, input.batchId, input.message, input.intent || 'brain_task', 'running', 0, now(), now());
  return id;
}

export function finishBrainSession(input: {
  sessionId: string;
  status: string;
  summary: string;
  uiPatch?: XiaogongUiPatch;
  viewId?: string;
  requiresConfirmation?: boolean;
}): void {
  getDb()
    .prepare('UPDATE xiaogong_sessions SET status = ?, summary = ?, ui_patch_json = ?, created_view_id = ?, requires_confirmation = ?, updated_at = ? WHERE id = ?')
    .run(
      input.status,
      input.summary,
      input.uiPatch ? JSON.stringify(input.uiPatch) : null,
      input.viewId || null,
      input.requiresConfirmation ? 1 : 0,
      now(),
      input.sessionId
    );
}

export function recordBrainToolEvent(sessionId: string, event: XiaogongToolEventSummary, input: unknown, output?: unknown, error?: string): void {
  getDb()
    .prepare(`
      INSERT INTO xiaogong_tool_events (
        id, session_id, tool_name, permission_level, requires_confirmation,
        input_json, output_json, status, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      crypto.randomUUID(),
      sessionId,
      event.toolName,
      event.permissionLevel,
      event.requiresConfirmation ? 1 : 0,
      JSON.stringify(input ?? {}),
      output === undefined ? null : JSON.stringify(output),
      event.status,
      error || null,
      now()
    );
}

export function makeUiLog(sessionId: string, traceId: string, event: Omit<BrainUiLogEvent, 'id' | 'sessionId' | 'createdAt' | 'traceId'>): BrainUiLogEvent {
  return {
    id: crypto.randomUUID(),
    sessionId,
    traceId,
    createdAt: now(),
    ...event
  };
}

export function toProgress(event: BrainUiLogEvent, status: XiaogongProgressEvent['status'] = 'running'): XiaogongProgressEvent {
  return {
    sessionId: event.sessionId,
    status,
    phase: event.phase,
    message: event.message || event.title,
    uiLog: event
  };
}
