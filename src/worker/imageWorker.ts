import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import type { ImportSource, SketchBox, SketchLabel, SketchStroke } from '../shared/api';
import { safeFileName, type ExportResult } from '../shared/export';
import { CACHE_VERSION, cacheFiles, computeTiles, l2Size, tileExtent } from '../shared/textures';
import type {
  EnsureCacheResult,
  ExportRequest,
  GeneratedImage,
  ImportedImage,
  MockGenerateResult,
  PreparedInput,
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
      case 'prepareInput':
        data = await prepareInput(request.path, request.maxEdge, request.enlarge);
        break;
      case 'mockGenerate':
        data = await mockGenerate(request);
        break;
      case 'exportPage':
        data = await exportPage(request);
        break;
      case 'sampleLowFi':
        data = await sampleLowFi(request.path);
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

async function importImage(dir: string, key: string, source: ImportSource): Promise<ImportedImage> {
  const input =
    source.kind === 'path'
      ? source.path
      : source.kind === 'bytes'
        ? Buffer.from(source.bytes)
        : source.kind === 'sketch'
          ? await sharp(Buffer.from(sketchSvg(source.width, source.height, source.boxes, source.strokes, source.texts))).png().toBuffer()
          : await sharp(join(dir, source.file)).extract(source.rect).png().toBuffer();
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

// ───────────────────────── 生成 ─────────────────────────

const INPUT_MAX_EDGE = 2048;

async function prepareInput(path: string, maxEdge = INPUT_MAX_EDGE, enlarge = false): Promise<PreparedInput> {
  const { data, info } = await sharp(path)
    .rotate()
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: !enlarge })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { base64: data.toString('base64'), mime: 'image/png', width: info.width, height: info.height };
}

/** 模拟结果要一眼能看出"变了"：每张换一个色相、做海报化，并在角上标出提示词开头 */
async function mockGenerate(request: Extract<WorkerRequest, { type: 'mockGenerate' }>): Promise<MockGenerateResult> {
  const { width, height, count, seed, prompt, inputs } = request;
  const label = escapeXml(prompt.replace(/\s+/g, ' ').slice(0, 24));
  const images: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const hue = Math.round(((seed * 97 + i * 137) % 360) + 360) % 360;
    const base = inputs[0]
      ? sharp(inputs[0]).rotate().resize(width, height, { fit: 'cover' })
      : sharp(Buffer.from(gradientSvg(width, height, hue)));
    const tinted = await base
      .modulate({ hue, saturation: 1.35, brightness: 1.05 })
      .png({ colors: 24 })
      .toBuffer();
    const badge = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect x="24" y="${height - 84}" rx="14" width="${Math.min(width - 48, 40 + label.length * 26)}" height="60" fill="rgba(10,10,20,0.72)"/>
        <text x="44" y="${height - 44}" font-family="PingFang SC, Helvetica, sans-serif" font-size="26" fill="#ffffff">模拟 ${i + 1} · ${label}</text>
      </svg>`,
    );
    const png = await sharp(tinted).composite([{ input: badge }]).png().toBuffer();
    images.push(new Uint8Array(png));
  }
  return { images };
}

function gradientSvg(width: number, height: number, hue: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 70% 30%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 80% 60%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
  </svg>`;
}

/**
 * 布局草图示意图：白底，每个区块一个浅灰圆角框，框中央写名字（字号随框大小，放得下为止）；
 * 草图笔迹画成黑色圆头折线，草图文字照原位置写上。
 */
function sketchSvg(width: number, height: number, boxes: SketchBox[], strokes: SketchStroke[], texts: SketchLabel[]): string {
  const shapes = boxes.map((box) => {
    const size = Math.max(18, Math.min(56, box.height * 0.32, (box.width * 0.9) / Math.max(1, box.name.length)));
    return [
      `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="16" fill="#EFEFF2" stroke="#8E8E99" stroke-width="4"/>`,
      `<text x="${box.x + box.width / 2}" y="${box.y + box.height / 2}" font-family="PingFang SC, Helvetica" font-size="${size}" fill="#55555F" text-anchor="middle" dominant-baseline="middle">${escapeXml(box.name)}</text>`,
    ].join('');
  });
  const lines = strokes.map((stroke) => {
    const points = [];
    for (let i = 0; i + 1 < stroke.points.length; i += 2) points.push(`${stroke.points[i]},${stroke.points[i + 1]}`);
    return `<polyline points="${points.join(' ')}" fill="none" stroke="#1D1D24" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  const labels = texts.map((label) => {
    const rows = label.text.split('\n').map(
      (row, i) => `<tspan x="${label.x}" dy="${i === 0 ? 0 : label.fontSize * 1.3}">${escapeXml(row)}</tspan>`,
    );
    return `<text x="${label.x}" y="${label.y + label.fontSize}" font-family="PingFang SC, Helvetica" font-size="${label.fontSize}" fill="#1D1D24">${rows.join('')}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#FFFFFF"/>${shapes.join('')}${lines.join('')}${labels.join('')}</svg>`;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

// ───────────────────────── 导出 ─────────────────────────

const ASSET_SCALES = [1, 2, 3];

async function exportPage({ dir, folder, plan }: ExportRequest): Promise<ExportResult> {
  const out = join(dir, folder);
  await mkdir(join(out, 'assets'), { recursive: true });
  const { width, height } = plan;

  const base = plan.base
    ? await sharp(join(dir, plan.base.file)).rotate().resize(width, height, { fit: 'fill' }).png().toBuffer()
    : null;
  const stack = plan.stack ?? [
    ...(plan.shapes ?? []).map((shape) => ({ kind: 'shape' as const, shape })),
    ...plan.layers.map((layer) => ({ kind: 'image' as const, layer })),
  ];
  const layerPngs = new Map<string, Buffer>();
  await Promise.all(
    stack
      .filter((item): item is { kind: 'image'; layer: (typeof plan.layers)[number] } => item.kind === 'image')
      .map(async ({ layer }) => {
        const png = await sharp(join(dir, layer.file)).rotate().resize(layer.width, layer.height, { fit: 'fill' }).png().toBuffer();
        layerPngs.set(layer.versionId + layer.file + layer.x + layer.y, png);
      }),
  );
  const layerKey = (layer: (typeof plan.layers)[number]) => layer.versionId + layer.file + layer.x + layer.y;

  // 整页 PNG：按可叠层栈从下到上；超出页面的部分裁掉
  const composites: OverlayOptions[] = [];
  if (base) composites.push({ input: base, left: 0, top: 0 });
  for (const item of stack) {
    if (item.kind === 'shape') {
      const shape = item.shape;
      const shapePng = await roundedRectPng(shape.width, shape.height, shape.fill, shape.cornerRadius);
      const left = Math.max(0, -shape.x);
      const top = Math.max(0, -shape.y);
      const visibleWidth = Math.min(shape.width, width - shape.x) - left;
      const visibleHeight = Math.min(shape.height, height - shape.y) - top;
      if (visibleWidth <= 0 || visibleHeight <= 0) continue;
      const input =
        left === 0 && top === 0 && visibleWidth === shape.width && visibleHeight === shape.height
          ? shapePng
          : await sharp(shapePng).extract({ left, top, width: visibleWidth, height: visibleHeight }).toBuffer();
      composites.push({ input, left: shape.x + left, top: shape.y + top });
      continue;
    }
    const { layer } = item;
    const png = layerPngs.get(layerKey(layer));
    if (!png) continue;
    const left = Math.max(0, -layer.x);
    const top = Math.max(0, -layer.y);
    const visibleWidth = Math.min(layer.width, width - layer.x) - left;
    const visibleHeight = Math.min(layer.height, height - layer.y) - top;
    if (visibleWidth <= 0 || visibleHeight <= 0) continue;
    const input =
      left === 0 && top === 0 && visibleWidth === layer.width && visibleHeight === layer.height
        ? png
        : await sharp(png).extract({ left, top, width: visibleWidth, height: visibleHeight }).toBuffer();
    composites.push({ input, left: layer.x + left, top: layer.y + top });
  }
  const pagePng = 'page.png';
  await sharp({ create: { width, height, channels: 4, background: plan.background } })
    .composite(composites)
    .png()
    .toFile(join(out, pagePng));

  // 分层 SVG：按可叠层栈交错写 rect / image
  const dataUrl = (buffer: Buffer): string => `data:image/png;base64,${buffer.toString('base64')}`;
  const svgStack: string[] = [];
  for (const item of stack) {
    if (item.kind === 'shape') {
      const shape = item.shape;
      svgStack.push(
        `      <rect id="${xmlAttr(shape.name)}" x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${shape.cornerRadius}" ry="${shape.cornerRadius}" fill="${xmlAttr(shape.fill)}"/>`,
      );
      continue;
    }
    const { layer } = item;
    const png = layerPngs.get(layerKey(layer));
    if (!png) continue;
    svgStack.push(
      `      <image id="${xmlAttr(layer.name)}" x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" preserveAspectRatio="none" href="${dataUrl(png)}"/>`,
    );
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <g id="${xmlAttr(plan.pageName)}">`,
    `    <rect id="背景" width="${width}" height="${height}" fill="${plan.background}"/>`,
    base ? `    <image id="低保真原型" width="${width}" height="${height}" preserveAspectRatio="none" href="${dataUrl(base)}"/>` : '',
    `    <g id="内容">`,
    ...svgStack,
    `    </g>`,
    `  </g>`,
    `</svg>`,
  ]
    .filter(Boolean)
    .join('\n');
  const pageSvg = 'page.svg';
  await writeFile(join(out, pageSvg), svg);

  // 素材包：每个素材按逻辑尺寸导出 @1x/@2x/@3x，超过原图分辨率的倍数跳过
  const files = [pagePng, pageSvg];
  const manifest: { name: string; x: number; y: number; width: number; height: number; files: string[] }[] = [];
  const imageLayers = stack.filter((item): item is { kind: 'image'; layer: (typeof plan.layers)[number] } => item.kind === 'image').map((item) => item.layer);
  for (const layer of imageLayers) {
    const logicalWidth = layer.width / plan.exportScale;
    const logicalHeight = layer.height / plan.exportScale;
    const meta = await sharp(join(dir, layer.file)).metadata();
    const originalWidth = meta.autoOrient?.width ?? meta.width ?? 0;
    const entry = {
      name: layer.name,
      x: round2(layer.x / plan.exportScale),
      y: round2(layer.y / plan.exportScale),
      width: round2(logicalWidth),
      height: round2(logicalHeight),
      files: [] as string[],
    };
    for (const scale of ASSET_SCALES) {
      const targetWidth = Math.round(logicalWidth * scale);
      if (scale > 1 && targetWidth > originalWidth) continue;
      const file = `assets/${safeFileName(layer.name)}@${scale}x.png`;
      await sharp(join(dir, layer.file))
        .rotate()
        .resize(Math.max(1, targetWidth), Math.max(1, Math.round(logicalHeight * scale)), { fit: 'fill' })
        .png()
        .toFile(join(out, file));
      entry.files.push(file);
      files.push(file);
    }
    manifest.push(entry);
  }
  await writeFile(
    join(out, 'manifest.json'),
    JSON.stringify(
      {
        page: plan.pageName,
        logicalWidth: plan.logicalWidth,
        logicalHeight: plan.logicalHeight,
        exportScale: plan.exportScale,
        layers: manifest,
        shapes: (plan.shapes ?? []).map((shape) => ({
          name: shape.name,
          x: round2(shape.x / plan.exportScale),
          y: round2(shape.y / plan.exportScale),
          width: round2(shape.width / plan.exportScale),
          height: round2(shape.height / plan.exportScale),
          fill: shape.fill,
          cornerRadius: round2(shape.cornerRadius / plan.exportScale),
        })),
        blocks: plan.blocks ?? [],
      },
      null,
      2,
    ),
  );
  files.push('manifest.json');
  return {
    folder,
    files,
    png: { width, height },
    svg: { layers: imageLayers.map((layer) => layer.name), bytes: Buffer.byteLength(svg) },
  };
}

async function roundedRectPng(width: number, height: number, fill: string, cornerRadius: number): Promise<Buffer> {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const r = Math.max(0, Math.min(cornerRadius, w / 2, h / 2));
  const safeFill = fill.replace(/[<>&'"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${safeFill}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function xmlAttr(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 首页线框：顶部 Banner 区、一排四个金刚位圆、两行瓷片、底部导航，全是灰块和占位文字 */
async function sampleLowFi(path: string): Promise<{ path: string; width: number; height: number }> {
  const w = 1179;
  const h = 2556;
  const box = (x: number, y: number, bw: number, bh: number, r = 24, fill = '#D9D9DE'): string =>
    `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${r}" fill="${fill}"/>`;
  const label = (x: number, y: number, text: string, size = 40, fill = '#7A7A85'): string =>
    `<text x="${x}" y="${y}" font-family="PingFang SC, Helvetica" font-size="${size}" fill="${fill}">${text}</text>`;
  const icons = [0, 1, 2, 3].map((i) => {
    const cx = 160 + i * 286;
    return `<circle cx="${cx}" cy="1060" r="110" fill="#D9D9DE"/>${label(cx - 80, 1230, ['热门寿司', '今日上新', '店长推荐', '全部菜单'][i], 38)}`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#FFFFFF"/>
    ${label(72, 230, '寿司点餐', 64, '#2B2A2E')}
    ${box(72, 300, 1035, 520, 36)}${label(450, 580, 'Banner', 56)}
    ${icons.join('')}
    ${label(72, 1400, '今日推荐', 52, '#2B2A2E')}
    ${box(72, 1460, 500, 420)}${box(607, 1460, 500, 420)}
    ${box(72, 1920, 500, 300)}${box(607, 1920, 500, 300)}
    ${box(0, 2340, 1179, 216, 0, '#EFEFF2')}
    ${[0, 1, 2, 3].map((i) => `<circle cx="${147 + i * 295}" cy="2420" r="34" fill="#C9C9CF"/>`).join('')}
  </svg>`;
  await mkdir(join(path, '..'), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(path);
  return { path, width: w, height: h };
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
