import type { AppLanguage } from '../../electron/shared/types';

export type TranslationTree = {
  [key: string]: string | TranslationTree;
};

export type TranslationVars = Record<string, string | number | undefined | null>;

import { enUS } from './en-US';
import { zhCN } from './zh-CN';

const dictionaries: Record<AppLanguage, TranslationTree> = {
  'zh-CN': zhCN,
  'en-US': enUS
};

export function normalizeLanguage(language?: string): AppLanguage {
  return language === 'en-US' ? 'en-US' : 'zh-CN';
}

function lookup(dict: TranslationTree, key: string): string | undefined {
  let current: string | TranslationTree | undefined = dict;
  for (const part of key.split('.')) {
    if (!current || typeof current === 'string') return undefined;
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

function format(text: string, vars?: TranslationVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''));
}

export function createTranslator(language?: string) {
  const lang = normalizeLanguage(language);
  const dict = dictionaries[lang];
  const fallback = dictionaries['zh-CN'];
  return (key: string, vars?: TranslationVars): string => {
    const text = lookup(dict, key) || lookup(fallback, key) || key;
    return format(text, vars);
  };
}
