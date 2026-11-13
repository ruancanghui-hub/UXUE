import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { CACHE_VERSION, cacheFiles, computeTiles, l2Size, tileExtent } from '../shared/textures';
import type {
  EnsureCacheResult,
  GeneratedImage,
  ImportedImage,
  PrepareBenchResult,
  SelfTestResult,
  WorkerMessage,
  WorkerRequest,
} from '../shared/workerProtocol';

interface ParentPort {
  on(event: 'message', listener: (event: { data: WorkerRequest }) => void): void;
  postMessage(message: WorkerMessage): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;

const BENCH_MANIFEST_FILE = 'manifest.json';
/** 测试图清单结构变了就加一，旧清单会被整体重建 */
const BENCH_MANIFEST_VERSION = 3;
const GENERATE_CONCURRENCY = 4;
/** 原样保留、不转码的格式 */
const KEEP_FORMATS: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };

parentPort.on('message', ({ data: request }) => {
  void handle(request);
});

async function handle(request: WorkerRequest): Promise<void> {
  try {
    let data: unknown;
    switch (request.type) {
      case 'prepareBench':
        data = await prepareBench(request.dir, request.count, (progress) =>
          parentPort.postMessage({ requestId: request.requestId, type: 'progress', progress }),
        );
        break;
      case 'selfTest':
        data = await selfTest(request.dir);
        break;
      case 'importImage':
        data = await importImage(request.dir, request.key, request.source);
        break;
      case 'ensureCache':
        data = await ensureCache(request.dir, request.key, request.file);
        break;
    }
    parentPort.postMessage({ requestId: request.requestId, type: 'result', ok: true, data });
  } catch (error) {
    parentPort.postMessage({
      requestId: request.requestId,
      type: 'result',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ───────────────────────── 导入与缓存 ─────────────────────────

async function importImage(
  dir: string,
  key: string,
  source: { kind: 'path'; path: string } | { kind: 'bytes'; name: string; bytes: Uint8Array },
): Promise<ImportedImage> {
  const input = source.kind === 'path' ? source.path : Buffer.from(source.bytes);
  const meta = await sharp(input).metadata();
  const name = source.kind === 'path' ? basename(source.path) : source.name;
  if (!meta.format || !meta.width || !meta.height) throw new Error(`${name} 不是能识别的图片`);

  await mkdir(join(dir, 'assets'), { recursive: true });
  const keepExt = KEEP_FORMATS[meta.format];
  const rotated = meta.orientation !== undefined && meta.orientation !== 1;
  const file = keepExt && !rotated ? `assets/${key}.${keepExt}` : `assets/${key}.png`;
  const target = join(dir, file);

  if (keepExt && !rotated) {
    if (source.kind === 'path') await copyFile(source.path, target);
    else await writeFile(target, input);
  } else {
    // 其它格式或带 EXIF 旋转的图统一转成方向正确的 PNG
    await sharp(input).rotate().png().toFile(target);
  }

  const stored = await sharp(target).metadata();
  const width = stored.width ?? meta.width;
  const height = stored.height ?? meta.height;
  await writeCache(dir, key, target, width, height);
  return { file, width, height };
}

async function ensureCache(dir: string, key: string, file: string): Promise<EnsureCacheResult> {
  if (await isCacheFresh(dir, key)) return { status: 'fresh' };
  const original = join(dir, file);
  if (!(await exists(original))) return { status: 'missing' };
  const meta = await sharp(original).metadata();
  if (!meta.width || !meta.height) return { status: 'missing' };
  await writeCache(dir, key, original, meta.width, meta.height);
  return { status: 'rebuilt' };
}

/** L0 / L1 缩略图 + L2 切块，最后写标记文件；标记在，缓存就是完整的 */
async function writeCache(dir: string, key: string, input: string | Buffer, width: number, height: number): Promise<void> {
  await mkdir(join(dir, '.cache'), { recursive: true });
  const l2 = l2Size(width, height);
  const raw = await sharp(input).resize(l2.width, l2.height, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const rawInput = { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } };

  await Promise.all([
    sharp(raw.data, rawInput)
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(join(dir, cacheFiles.l0(key))),
    sharp(raw.data, rawInput)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(join(dir, cacheFiles.l1(key))),
    ...computeTiles(l2.width, l2.height).map((tile) =>
      sharp(raw.data, rawInput)
        .extract(tileExtent(tile, l2.width, l2.height))
        .webp({ quality: 92 })
        .toFile(join(dir, cacheFiles.tile(key, tile))),
    ),
  ]);
  await writeFile(join(dir, cacheFiles.marker(key)), JSON.stringify({ cacheVersion: CACHE_VERSION, ...l2 }));
}

async function isCacheFresh(dir: string, key: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(dir, cacheFiles.marker(key)), 'utf8')) as { cacheVersion?: number };
    return marker.cacheVersion === CACHE_VERSION;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── 性能测试图 ─────────────────────────

async function prepareBench(
  dir: string,
  count: number,
  onProgress: (progress: { done: number; total: number }) => void,
): Promise<PrepareBenchResult> {
  const cached = await readBenchManifest(dir);
  if (cached && cached.length === count && (await allCachesFresh(dir, cached))) {
    onProgress({ done: count, total: count });
    return { images: cached, reused: true };
  }

  await mkdir(join(dir, 'assets'), { recursive: true });
  const images: GeneratedImage[] = new Array(count);
  let done = 0;
  let next = 0;
  const runLane = async (): Promise<void> => {
    while (next < count) {
      const index = next++;
      images[index] = await generateBenchImage(dir, index);
      done++;
      onProgress({ done, total: count });
    }
  };
  await Promise.all(Array.from({ length: GENERATE_CONCURRENCY }, runLane));

  await writeFile(join(dir, BENCH_MANIFEST_FILE), JSON.stringify({ version: BENCH_MANIFEST_VERSION, images }, null, 2));
  return { images, reused: false };
}

async function selfTest(dir: string): Promise<SelfTestResult> {
  await mkdir(join(dir, 'assets'), { recursive: true });
  const image = await generateBenchImage(dir, 0);
  const l2 = l2Size(image.width, image.height);
  const files = [
    cacheFiles.l0(image.key),
    cacheFiles.l1(image.key),
    ...computeTiles(l2.width, l2.height).map((tile) => cacheFiles.tile(image.key, tile)),
    image.original,
  ];
  const results = await Promise.all(
    files.map(async (file) => {
      const meta = await sharp(join(dir, file)).metadata();
      return { file, width: meta.width ?? 0, height: meta.height ?? 0, format: meta.format ?? '' };
    }),
  );
  return { sharpVersion: sharp.versions.sharp ?? 'unknown', files: results };
}

async function generateBenchImage(dir: string, index: number): Promise<GeneratedImage> {
  const key = `img-${String(index).padStart(3, '0')}`;
  const random = seededRandom(index + 1);
  const [width, height] = pickSize(index);
  const svg = buildSvg(width, height, index, random);
  const original = await sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
  const originalFile = `assets/${key}.png`;
  await writeFile(join(dir, originalFile), original);
  await writeCache(dir, key, original, width, height);
  return { key, width, height, original: originalFile };
}

function pickSize(index: number): [number, number] {
  switch (index % 4) {
    case 0:
      return [2048, 1024];
    case 1:
      return [1536, 2048];
    default:
      return [2048, 2048];
  }
}

function buildSvg(width: number, height: number, index: number, random: () => number): string {
  const hue = Math.floor(random() * 360);
  const shapes: string[] = [];
  for (let i = 0; i < 14; i++) {
    const shapeHue = (hue + Math.floor(random() * 120) - 60 + 360) % 360;
    const fill = `hsl(${shapeHue} ${50 + random() * 40}% ${45 + random() * 30}%)`;
    const x = random() * width;
    const y = random() * height;
    const size = (0.08 + random() * 0.28) * Math.min(width, height);
    shapes.push(
      i % 2 === 0
        ? `<circle cx="${x}" cy="${y}" r="${size / 2}" fill="${fill}" fill-opacity="0.85"/>`
        : `<rect x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" rx="${size * 0.22}" fill="${fill}" fill-opacity="0.85"/>`,
    );
  }
  const fontSize = Math.round(Math.min(width, height) * 0.22);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 60% 22%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 50) % 360} 70% 48%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  ${shapes.join('\n  ')}
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff" fill-opacity="0.92">${index + 1}</text>
</svg>`;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function readBenchManifest(dir: string): Promise<GeneratedImage[] | null> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, BENCH_MANIFEST_FILE), 'utf8')) as {
      version?: number;
      images?: GeneratedImage[];
    };
    return manifest.version === BENCH_MANIFEST_VERSION && manifest.images ? manifest.images : null;
  } catch {
    return null;
  }
}

async function allCachesFresh(dir: string, images: GeneratedImage[]): Promise<boolean> {
  const results = await Promise.all(images.map((image) => isCacheFresh(dir, image.key)));
  return results.every(Boolean);
}
