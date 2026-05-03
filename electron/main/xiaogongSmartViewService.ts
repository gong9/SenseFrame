import crypto from 'node:crypto';
import { getDb } from './db';
import type { SmartView, SmartViewItem, SmartViewSummary, XiaogongIntentType } from '../shared/types';

function now(): string {
  return new Date().toISOString();
}

export function createSmartView(input: {
  batchId: string;
  name: string;
  intent: XiaogongIntentType;
  query: string;
  summary: string;
  items: SmartViewItem[];
}): SmartView {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = now();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO smart_views (id, batch_id, name, source, intent, query, summary, photo_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.batchId, input.name, 'xiaogong', input.intent, input.query, input.summary, input.items.length, createdAt, createdAt);

    const insertItem = db.prepare(`
      INSERT INTO smart_view_items (view_id, photo_id, rank, score, reason, action_hint, needs_human_review, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of input.items) {
      insertItem.run(
        id,
        item.photoId,
        item.rank,
        item.score,
        item.reason,
        item.actionHint || null,
        item.needsHumanReview ? 1 : 0,
        '{}'
      );
    }
  });
  tx();
  return {
    id,
    batchId: input.batchId,
    name: input.name,
    source: 'xiaogong',
    intent: input.intent,
    query: input.query,
    summary: input.summary,
    items: input.items,
    createdAt
  };
}

export function getSmartView(viewId: string): SmartView {
  const db = getDb();
  const view = db.prepare('SELECT * FROM smart_views WHERE id = ?').get(viewId) as any;
  if (!view) throw new Error('小宫视图不存在。');
  const items = db.prepare('SELECT * FROM smart_view_items WHERE view_id = ? ORDER BY rank ASC').all(viewId) as any[];
  return {
    id: view.id,
    batchId: view.batch_id,
    name: view.name,
    source: 'xiaogong',
    intent: view.intent,
    query: view.query,
    summary: view.summary,
    createdAt: view.created_at,
    items: items.map((item) => ({
      photoId: item.photo_id,
      rank: item.rank,
      score: item.score,
      reason: item.reason,
      actionHint: item.action_hint || undefined,
      needsHumanReview: Boolean(item.needs_human_review)
    }))
  };
}

export function listSmartViews(batchId: string): SmartViewSummary[] {
  const rows = getDb()
    .prepare('SELECT * FROM smart_views WHERE batch_id = ? ORDER BY updated_at DESC LIMIT 12')
    .all(batchId) as any[];
  return rows.map((row) => ({
    id: row.id,
    batchId: row.batch_id,
    name: row.name,
    intent: row.intent,
    photoCount: row.photo_count,
    summary: row.summary,
    createdAt: row.created_at
  }));
}
