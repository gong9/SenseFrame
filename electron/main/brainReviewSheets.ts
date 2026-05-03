import { app } from 'electron';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { PhotoView } from '../shared/types';

export type ReviewSheetCell = {
  cell: number;
  photoId: string;
  fileName: string;
  score: number;
  riskFlags: string[];
  decision: string;
};

export type ReviewContactSheet = {
  id: string;
  path: string;
  index: number;
  total: number;
  imageWidth: number;
  imageHeight: number;
  fileSizeBytes: number;
  base64ApproxBytes: number;
  params: Required<ReviewContactSheetOptions>;
  cells: ReviewSheetCell[];
};

export type ReviewContactSheetOptions = {
  photoIds?: string[];
  cellsPerSheet?: number;
  columns?: number;
  cellWidth?: number;
  cellHeight?: number;
  imageHeight?: number;
  jpegQuality?: number;
  detail?: 'low' | 'high';
  idPrefix?: string;
};

const DEFAULT_OPTIONS: Required<ReviewContactSheetOptions> = {
  photoIds: [],
  cellsPerSheet: 25,
  columns: 5,
  cellWidth: 210,
  cellHeight: 292,
  imageHeight: 238,
  jpegQuality: 82,
  detail: 'low',
  idPrefix: 'sheet'
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  }[char] || char));
}

function scoreText(photo: PhotoView): string {
  const score = Math.round((photo.analysis?.finalScore || 0) * 100);
  const eye = photo.analysis?.eyeState || 'unknown';
  const face = photo.analysis?.faceVisibility || 'unknown';
  const risks = (photo.analysis?.riskFlags || []).slice(0, 2).join(',');
  return [`S${score}`, `eye:${eye}`, `face:${face}`, risks].filter(Boolean).join(' ');
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeOptions(options: ReviewContactSheetOptions = {}): Required<ReviewContactSheetOptions> {
  const cellHeight = clampNumber(options.cellHeight, DEFAULT_OPTIONS.cellHeight, 170, 420);
  const imageHeight = clampNumber(options.imageHeight, DEFAULT_OPTIONS.imageHeight, 120, cellHeight - 32);
  return {
    photoIds: Array.isArray(options.photoIds) ? options.photoIds.map(String).filter(Boolean) : [],
    cellsPerSheet: clampNumber(options.cellsPerSheet, DEFAULT_OPTIONS.cellsPerSheet, 4, 40),
    columns: clampNumber(options.columns, DEFAULT_OPTIONS.columns, 2, 8),
    cellWidth: clampNumber(options.cellWidth, DEFAULT_OPTIONS.cellWidth, 110, 320),
    cellHeight,
    imageHeight,
    jpegQuality: clampNumber(options.jpegQuality, DEFAULT_OPTIONS.jpegQuality, 45, 92),
    detail: options.detail === 'high' ? 'high' : 'low',
    idPrefix: String(options.idPrefix || DEFAULT_OPTIONS.idPrefix).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || DEFAULT_OPTIONS.idPrefix
  };
}

async function renderCell(photo: PhotoView, cell: number, options: Required<ReviewContactSheetOptions>): Promise<Buffer> {
  if (!photo.previewPath) throw new Error(`${photo.fileName} 没有 preview，不能生成审片板。`);
  const meta = await sharp(photo.previewPath).metadata();
  const width = meta.width || options.cellWidth;
  const height = meta.height || options.imageHeight;
  const scale = Math.min(options.cellWidth / width, options.imageHeight / height);
  const resizedWidth = Math.max(1, Math.round(width * scale));
  const resizedHeight = Math.max(1, Math.round(height * scale));
  const preview = await sharp(photo.previewPath).resize(resizedWidth, resizedHeight).jpeg({ quality: options.jpegQuality }).toBuffer();
  const title = `${cell}. ${photo.fileName}`;
  const subtitle = `${photo.id.slice(0, 10)} ${scoreText(photo)}`;
  const badge = photo.decision !== 'none' ? `decision:${photo.decision}` : '';
  const svg = Buffer.from(`
    <svg width="${options.cellWidth}" height="${options.cellHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${options.cellWidth}" height="${options.cellHeight}" fill="#f8f8f4"/>
      <rect x="0" y="0" width="${options.cellWidth}" height="${options.imageHeight}" fill="#ffffff"/>
      <rect x="0" y="${options.imageHeight}" width="${options.cellWidth}" height="${options.cellHeight - options.imageHeight}" fill="#eeeeea"/>
      <text x="6" y="${options.imageHeight + 14}" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="#111">${escapeXml(title)}</text>
      <text x="6" y="${options.imageHeight + 29}" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="#555">${escapeXml(subtitle)}</text>
      <text x="6" y="${options.imageHeight + 43}" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="#8a5a00">${escapeXml(badge)}</text>
    </svg>
  `);
  return sharp(svg)
    .composite([{ input: preview, left: Math.round((options.cellWidth - resizedWidth) / 2), top: Math.round((options.imageHeight - resizedHeight) / 2) }])
    .jpeg({ quality: options.jpegQuality })
    .toBuffer();
}

function sheetDir(batchId: string): string {
  const dir = join(app.getPath('userData'), 'senseframe-cache', batchId, 'brain-review-sheets');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function createReviewContactSheets(
  batchId: string,
  photos: PhotoView[],
  rawOptions: ReviewContactSheetOptions = {}
): Promise<ReviewContactSheet[]> {
  const options = normalizeOptions(rawOptions);
  const photoIdFilter = new Set(options.photoIds);
  const ready = photos.filter((photo) => photo.status === 'ready' && photo.previewPath && (!photoIdFilter.size || photoIdFilter.has(photo.id)));
  const total = Math.ceil(ready.length / options.cellsPerSheet);
  const dir = sheetDir(batchId);
  const sheets: ReviewContactSheet[] = [];

  for (let sheetIndex = 0; sheetIndex < total; sheetIndex += 1) {
    const chunk = ready.slice(sheetIndex * options.cellsPerSheet, (sheetIndex + 1) * options.cellsPerSheet);
    const rows = Math.ceil(chunk.length / options.columns) || 1;
    const composites = [];
    const cells: ReviewSheetCell[] = [];

    for (let index = 0; index < chunk.length; index += 1) {
      const photo = chunk[index];
      const cell = index + 1;
      composites.push({
        input: await renderCell(photo, cell, options),
        left: (index % options.columns) * options.cellWidth,
        top: Math.floor(index / options.columns) * options.cellHeight
      });
      cells.push({
        cell,
        photoId: photo.id,
        fileName: photo.fileName,
        score: photo.analysis?.finalScore || 0,
        riskFlags: photo.analysis?.riskFlags || [],
        decision: photo.decision
      });
    }

    const id = `${options.idPrefix}-${sheetIndex + 1}`;
    const output = join(dir, `${id}.jpg`);
    const imageWidth = options.columns * options.cellWidth;
    const imageHeight = rows * options.cellHeight;
    await sharp({
      create: {
        width: imageWidth,
        height: imageHeight,
        channels: 3,
        background: '#f8f8f4'
      }
    }).composite(composites).jpeg({ quality: options.jpegQuality, mozjpeg: true }).toFile(output);
    const fileSizeBytes = statSync(output).size;

    sheets.push({
      id,
      path: output,
      index: sheetIndex + 1,
      total,
      imageWidth,
      imageHeight,
      fileSizeBytes,
      base64ApproxBytes: Math.ceil(fileSizeBytes * 4 / 3),
      params: options,
      cells
    });
  }

  return sheets;
}

export function imageFileDataUrl(path: string): string {
  const image = readFileSync(path);
  return `data:image/jpeg;base64,${image.toString('base64')}`;
}
