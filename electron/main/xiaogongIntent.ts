import type { XiaogongIntentType } from '../shared/types';

export function classifyXiaogongIntent(message: string): XiaogongIntentType {
  const text = message.trim().toLowerCase();
  if (!text) return 'unknown';
  if (/封面|头图|社媒|cover/.test(text)) return 'cover_candidates';
  if (/闭眼|眼睛|笑眼|误判|eye/.test(text)) return 'closed_eye_misread';
  if (/连拍|每组|代表图|重复|近重复|group|representative/.test(text)) return 'group_representatives';
  if (/解释|为什么|这张|原因|explain/.test(text)) return 'explain_current_photo';
  if (/重审|重新审|整理这批|审一遍|batch/.test(text)) return 'batch_review';
  if (/最好看|最佳|精选|推荐|好看的|best|pick/.test(text)) return 'best_photos';
  return 'unknown';
}
