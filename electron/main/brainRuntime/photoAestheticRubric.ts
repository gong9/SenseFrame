export const PHOTO_AESTHETIC_RUNTIME_PROMPT = [
  '小宫内置摄影审美 Skill：先判断照片属于哪一层审片价值，再判断应该放入哪个产品分组。',
  '审片价值分两层：featured 是作品级/封面级精选；keeper 是摄影师一轮审片里值得保留、可交付备选、能补充故事/情绪/连续性的照片。',
  'featured 只代表摄影师可交付、可展示、可作为封面/精选候选的照片；不是“这批里相对好一点”。',
  '坏批次可以 0 张 featured，但不等于 0 张 keeper；普通但有客户价值、情绪价值或叙事价值的照片可以 recommendedAction=maybe 表示建议保留。',
  '宁可把不够作品级但可保留的照片标为 maybe/keeper，也不要把明显随拍、背景脏、逆光灰、主体弱、构图散的照片写成 featured。',
  '参考审美维度来自 PPA 12 elements、CADB/PICD 构图标注和通用视觉审美基准：impact, technical excellence, composition, center of interest, lighting, subject matter, color balance, storytelling, finish。',
  '情绪好不是免死牌：如果背景严重抢戏、光线毁主体、主体不清、脸部/动作失败、画面完成度低，不能 featured。',
  'closed_eyes、face_missing、low_score 不要机械判废；但必须通过画面判断它们是表达、空镜/细节，还是失败。'
].join('\n');

export const PHOTO_AESTHETIC_JSON_CONTRACT = [
  '每张照片除原有字段外，必须尽量返回：',
  'aestheticPass: boolean，表示是否达到交付级审美门槛。',
  'deliverableScore: 0-1，表示交付/展示可用性，不是相对排名。',
  'recommendedAction=maybe 表示建议保留/备选 keeper，不等于“不确定”；recommendedAction=review 才表示需要人工复核。',
  'fatalFlaws: string[]，记录导致不能精选的致命问题，如 background_clutter, harsh_backlight, weak_subject, missed_focus, snapshot_composition, bad_crop, low_finish。',
  'aestheticRejectReasons: string[]，用摄影师语言说明为什么不该精选。',
  'compositionTags: string[]，可写 thirds, centered, diagonal, layered, leading_lines, frame_within_frame, cluttered, snapshot, static, cropped_subject 等。',
  'visualScores 继续使用 visualQuality, expression, moment, composition, backgroundCleanliness, storyValue；如果能判断，也补充 lighting, subjectClarity, finish, deliverableScore。'
].join('\n');

export const PHOTO_AESTHETIC_FEATURED_GATE = [
  'featured 硬门槛：',
  '1. aestheticPass 必须为 true。',
  '2. deliverableScore 通常要 >= 0.76；审片板缩略图阶段要更谨慎。',
  '3. composition、backgroundCleanliness、visualQuality 不能明显短板。',
  '4. fatalFlaws 必须为空或只有非常轻微问题。',
  '5. 至少有一个强瞬间/表情/故事/形式亮点；普通清楚但无亮点不是 featured。',
  '6. recommendedAction 必须是 pick；maybe/review 默认不是 featured。'
].join('\n');

export const PHOTO_AESTHETIC_KEEPER_GATE = [
  'keeper/建议保留门槛：',
  '1. 不够 featured 但有自然情绪、客户价值、故事串联、场景信息、代表性动作或组内代表价值，可以 recommendedAction=maybe。',
  '2. 轻微背景杂、轻微构图随拍、光线普通，不自动淘汰；如果主体、情绪或故事成立，可以作为 keeper。',
  '3. maybe/keeper 不要求 aestheticPass=true，也不要求 deliverableScore 达到 featured 门槛。',
  '4. 只有眼神/焦点/遮挡/闭眼语义真正无法判断时才 needsHumanReview=true；普通 keeper 不要全部标 true。',
  '5. reject 只给明确失败、重复弱帧、严重技术问题或没有交付/叙事价值的照片。'
].join('\n');

export const PHOTO_AESTHETIC_REJECT_EXAMPLES = [
  '有情绪但树枝/杂物压住主体、背景抢戏：不是 featured；如果情绪/客户价值成立，可 similarBursts/eyeReview + maybe。',
  '逆光灰雾、脸和衣服没有质感、主体不突出：technical 或 similarBursts。',
  '像随手记录、构图没有中心、主体太低/太边缘/被裁切：similarBursts 或 subject。',
  '小模型高分但画面完成度不够：写入 smallModelOverrides，并降低 deliverableScore。',
  '整批都弱时：summary 要明确“本批不建议精选”或“仅保留人工复核候选”。'
].join('\n');

export function photoAestheticPrompt(): string {
  return [
    PHOTO_AESTHETIC_RUNTIME_PROMPT,
    PHOTO_AESTHETIC_JSON_CONTRACT,
    PHOTO_AESTHETIC_FEATURED_GATE,
    PHOTO_AESTHETIC_KEEPER_GATE,
    PHOTO_AESTHETIC_REJECT_EXAMPLES
  ].join('\n');
}
