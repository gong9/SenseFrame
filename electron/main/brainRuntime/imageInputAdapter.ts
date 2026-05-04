import crypto from 'node:crypto';
import { statSync } from 'node:fs';
import sharp from 'sharp';

export type ImageInputDetail = 'low' | 'high';

export type ImageInputOptions = {
  detail?: ImageInputDetail;
  maxDimension?: number;
  jpegQuality?: number;
  purpose?: string;
};

export type ImageInputPayload = {
  type: 'image_url';
  image_url: {
    url: string;
    detail: ImageInputDetail;
  };
};

export type ImageInputArtifact = {
  sourcePath: string;
  mime: 'image/jpeg';
  imageUrl: string;
  input: ImageInputPayload;
  cacheHit: boolean;
  originalFileSizeBytes: number;
  encodedBytes: number;
  base64ApproxBytes: number;
  estimatedRequestBytes: number;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  params: Required<Omit<ImageInputOptions, 'purpose'>> & { purpose: string };
};

const MAX_CACHE_ITEMS = 64;
const imageInputCache = new Map<string, ImageInputArtifact>();

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizedOptions(options: ImageInputOptions = {}): ImageInputArtifact['params'] {
  return {
    detail: options.detail === 'high' ? 'high' : 'low',
    maxDimension: clampNumber(options.maxDimension, 2048, 320, 4096),
    jpegQuality: clampNumber(options.jpegQuality, 85, 35, 95),
    purpose: String(options.purpose || 'vision')
  };
}

function remember(cacheKey: string, artifact: ImageInputArtifact): void {
  imageInputCache.set(cacheKey, artifact);
  while (imageInputCache.size > MAX_CACHE_ITEMS) {
    const oldest = imageInputCache.keys().next().value;
    if (!oldest) break;
    imageInputCache.delete(oldest);
  }
}

export async function createImageInput(path: string, options: ImageInputOptions = {}): Promise<ImageInputArtifact> {
  const params = normalizedOptions(options);
  const sourceStat = statSync(path);
  const cacheKey = crypto
    .createHash('sha1')
    .update(JSON.stringify({
      path,
      mtimeMs: sourceStat.mtimeMs,
      size: sourceStat.size,
      params
    }))
    .digest('hex');
  const cached = imageInputCache.get(cacheKey);
  if (cached) return { ...cached, cacheHit: true };

  const image = sharp(path, { failOn: 'none', limitInputPixels: false }).rotate();
  const metadata = await image.metadata();
  const resized = image.resize({
    width: params.maxDimension,
    height: params.maxDimension,
    fit: 'inside',
    withoutEnlargement: true
  });
  const buffer = await resized.jpeg({ quality: params.jpegQuality, mozjpeg: true }).toBuffer();
  const outputMetadata = await sharp(buffer).metadata();
  const base64 = buffer.toString('base64');
  const imageUrl = `data:image/jpeg;base64,${base64}`;
  const artifact: ImageInputArtifact = {
    sourcePath: path,
    mime: 'image/jpeg',
    imageUrl,
    input: {
      type: 'image_url',
      image_url: {
        url: imageUrl,
        detail: params.detail
      }
    },
    cacheHit: false,
    originalFileSizeBytes: sourceStat.size,
    encodedBytes: buffer.length,
    base64ApproxBytes: Math.ceil(buffer.length * 4 / 3),
    estimatedRequestBytes: Math.ceil(buffer.length * 4 / 3) + 4200,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    width: outputMetadata.width,
    height: outputMetadata.height,
    params
  };
  remember(cacheKey, artifact);
  return artifact;
}

export function imageInputCacheStats(): Record<string, unknown> {
  const artifacts = [...imageInputCache.values()];
  return {
    imageInputCacheItems: imageInputCache.size,
    encodedBytes: artifacts.reduce((sum, item) => sum + item.encodedBytes, 0),
    latest: artifacts.slice(-8).map((item) => ({
      sourcePath: item.sourcePath,
      encodedBytes: item.encodedBytes,
      width: item.width,
      height: item.height,
      detail: item.params.detail,
      maxDimension: item.params.maxDimension,
      jpegQuality: item.params.jpegQuality,
      purpose: item.params.purpose
    }))
  };
}
