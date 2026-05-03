import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { ModelSettings } from '../shared/types';

const defaultSettings: ModelSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  apiKey: ''
};

function settingsPath(): string {
  return join(app.getPath('userData'), 'senseframe', 'settings.json');
}

function normalizeSettings(value: Partial<ModelSettings>): ModelSettings {
  return {
    baseUrl: String(value.baseUrl || defaultSettings.baseUrl).trim(),
    model: String(value.model || defaultSettings.model).trim(),
    apiKey: String(value.apiKey || '').trim()
  };
}

export function getModelSettings(): ModelSettings {
  const file = settingsPath();
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<ModelSettings> : {};
  return normalizeSettings({
    baseUrl: process.env.OPENAI_BASE_URL || stored.baseUrl,
    model: process.env.OPENAI_MODEL || process.env.OPENAI_VISION_MODEL || stored.model,
    apiKey: process.env.OPENAI_API_KEY || stored.apiKey
  });
}

export function applyModelSettings(settings = getModelSettings()): void {
  process.env.OPENAI_BASE_URL = settings.baseUrl;
  process.env.OPENAI_MODEL = settings.model;
  process.env.OPENAI_VISION_MODEL = settings.model;
  process.env.OPENAI_API_KEY = settings.apiKey;
}

export function saveModelSettings(input: ModelSettings): ModelSettings {
  const next = normalizeSettings(input);
  const file = settingsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  applyModelSettings(next);
  return next;
}
