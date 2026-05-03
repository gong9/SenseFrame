import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { getDb } from './db';
import { getBatch } from './photoPipeline';
import type { SearchResult, SemanticAnalysis } from '../shared/types';

function visionModel(): string {
  return process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini';
}

function embeddingModel(): string {
  return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
}

function now(): string {
  return new Date().toISOString();
}

function client(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined
  });
}

function mockSemantic(photoId: string): SemanticAnalysis {
  return {
    photoId,
    scene: '影像候选',
    subjects: ['主体人物'],
    emotion: ['自然', '稳定'],
    usage: ['交付候选', '故事备选'],
    composition: '主体明确，画面适合进一步复核',
    caption: '这是一张进入候选池的照片，系统建议结合清晰度、表情和构图进行人工确认。',
    recommendationReason: '当前未配置 OpenAI API Key，使用本地 mock 语义分析；基础推荐来自清晰度、曝光和相似组排序。',
    llmScore: { emotion: 0.64, story: 0.58, coverPotential: 0.52 },
    model: 'mock-semantic',
    isMock: true
  };
}

function saveSemantic(result: SemanticAnalysis, embedding?: number[]): void {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO semantic_analysis (
        photo_id, scene, subjects, emotion, usage, composition, caption,
        recommendation_reason, llm_score, model, is_mock, embedding, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      result.photoId,
      result.scene,
      JSON.stringify(result.subjects),
      JSON.stringify(result.emotion),
      JSON.stringify(result.usage),
      result.composition,
      result.caption,
      result.recommendationReason,
      JSON.stringify(result.llmScore),
      result.model,
      result.isMock ? 1 : 0,
      embedding ? JSON.stringify(embedding) : null,
      now(),
      now()
    );
}

function parseStructured(text: string, photoId: string): SemanticAnalysis {
  const jsonText = text.trim().startsWith('{') ? text.trim() : text.match(/\{[\s\S]*\}/)?.[0] || '{}';
  const data = JSON.parse(jsonText) as any;
  return {
    photoId,
    scene: String(data.scene || 'unknown'),
    subjects: Array.isArray(data.subjects) ? data.subjects.map(String) : [],
    emotion: Array.isArray(data.emotion) ? data.emotion.map(String) : [],
    usage: Array.isArray(data.usage) ? data.usage.map(String) : [],
    composition: String(data.composition || ''),
    caption: String(data.caption || ''),
    recommendationReason: String(data.recommendation_reason || data.recommendationReason || ''),
    llmScore: {
      emotion: Number(data.llm_score?.emotion ?? 0.5),
      story: Number(data.llm_score?.story ?? 0.5),
      coverPotential: Number(data.llm_score?.cover_potential ?? data.llm_score?.coverPotential ?? 0.5)
    },
    model: visionModel(),
    isMock: false
  };
}

async function embeddingForText(text: string): Promise<number[] | undefined> {
  const api = client();
  if (!api) return undefined;
  const response = await api.embeddings.create({
    model: embeddingModel(),
    input: text
  });
  return response.data[0]?.embedding;
}

export async function analyzeSemantic(batchId: string, photoId: string): Promise<SemanticAnalysis> {
  const batch = getBatch(batchId);
  const photo = batch.photos.find((item) => item.id === photoId);
  if (!photo) throw new Error('Photo not found');
  const api = client();
  if (!api || !photo.previewPath) {
    const result = mockSemantic(photoId);
    saveSemantic(result);
    return result;
  }

  const image = readFileSync(photo.previewPath).toString('base64');
  const localContext = [
    `local_face_visibility=${photo.analysis?.faceVisibility || 'unknown'}`,
    `local_eye_state=${photo.analysis?.eyeState || 'unknown'}`,
    `local_eye_confidence=${photo.analysis?.eyeConfidence ?? 0}`,
    `local_risk_flags=${(photo.analysis?.riskFlags || []).join(',') || 'none'}`
  ].join('; ');
  const response = await api.responses.create({
    model: visionModel(),
    text: {
      format: {
        type: 'json_schema',
        name: 'semantic_analysis',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scene: { type: 'string' },
            subjects: { type: 'array', items: { type: 'string' } },
            emotion: { type: 'array', items: { type: 'string' } },
            usage: { type: 'array', items: { type: 'string' } },
            composition: { type: 'string' },
            caption: { type: 'string' },
            recommendation_reason: { type: 'string' },
            llm_score: {
              type: 'object',
              additionalProperties: false,
              properties: {
                emotion: { type: 'number' },
                story: { type: 'number' },
                cover_potential: { type: 'number' }
              },
              required: ['emotion', 'story', 'cover_potential']
            }
          },
          required: ['scene', 'subjects', 'emotion', 'usage', 'composition', 'caption', 'recommendation_reason', 'llm_score']
        }
      }
    } as any,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              `Analyze this professional photography candidate for culling. Local detector context: ${localContext}. Treat no visible face as context, not automatic rejection: recognize back views, atmosphere, environment, and documentary storytelling. Return only JSON with keys: scene, subjects, emotion, usage, composition, caption, recommendation_reason, llm_score { emotion, story, cover_potential }. Keep Chinese text concise and practical.`
          },
          {
            type: 'input_image',
            image_url: `data:image/jpeg;base64,${image}`,
            detail: 'high'
          }
        ]
      }
    ]
  });

  const text = response.output_text || '{}';
  const result = parseStructured(text, photoId);
  const embedding = await embeddingForText(`${result.scene} ${result.subjects.join(' ')} ${result.emotion.join(' ')} ${result.usage.join(' ')} ${result.caption}`);
  saveSemantic(result, embedding);
  return result;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  return an && bn ? dot / (Math.sqrt(an) * Math.sqrt(bn)) : 0;
}

export async function semanticSearch(batchId: string, query: string): Promise<SearchResult[]> {
  const batch = getBatch(batchId);
  const queryEmbedding = await embeddingForText(query);
  const rows = getDb()
    .prepare('SELECT photo_id, scene, subjects, emotion, usage, caption, embedding FROM semantic_analysis WHERE photo_id IN (SELECT id FROM photos WHERE batch_id = ?)')
    .all(batchId) as any[];

  const scored = rows.map((row) => {
    const haystack = `${row.scene} ${row.subjects} ${row.emotion} ${row.usage} ${row.caption}`.toLowerCase();
    const lexical = query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .reduce((score, token) => score + (haystack.includes(token) ? 0.18 : 0), 0);
    const vector = queryEmbedding && row.embedding ? cosine(queryEmbedding, JSON.parse(row.embedding)) : 0;
    return {
      photo: batch.photos.find((photo) => photo.id === row.photo_id)!,
      score: Math.max(lexical, vector),
      reason: row.caption
    };
  });

  return scored.filter((item) => item.photo).sort((a, b) => b.score - a.score).slice(0, 24);
}
