import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

function traceDir(): string {
  const dir = join(app.getPath('userData'), 'senseframe', 'brain-traces');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createTraceId(): string {
  return crypto.randomUUID();
}

export function appendTrace(traceId: string, event: string, payload?: unknown): void {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    event,
    payload
  });
  writeFileSync(join(traceDir(), `${traceId}.jsonl`), `${line}\n`, { flag: 'a' });
}
