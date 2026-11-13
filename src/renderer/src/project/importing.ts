import type { ImportResult, ImportSource } from '../../../shared/api';

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|avif|tiff?|svg|heic)$/i;

/** 拖入或粘贴的文件：磁盘上的文件走路径（不经过渲染进程内存），截图之类只在剪贴板里的走字节 */
export async function sourcesFromFiles(files: Iterable<File>): Promise<ImportSource[]> {
  const sources: ImportSource[] = [];
  for (const file of files) {
    const path = window.anye.getPathForFile(file);
    if (path && IMAGE_EXTENSION.test(path)) {
      sources.push({ kind: 'path', path });
    } else if (file.type.startsWith('image/')) {
      const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      sources.push({ kind: 'bytes', name: file.name || `粘贴的图片.${extension}`, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
  }
  return sources;
}

export async function pickImageSources(): Promise<ImportSource[]> {
  const paths = await window.anye.pickImages();
  return paths.map((path) => ({ kind: 'path', path }));
}

export function describeImportErrors(result: ImportResult): string | null {
  if (result.errors.length === 0) return null;
  const head = result.errors.slice(0, 3).map((error) => `${error.name}：${error.message}`);
  const more = result.errors.length > 3 ? `，另有 ${result.errors.length - 3} 个` : '';
  return `${result.errors.length} 个文件没能导入（${head.join('；')}${more}）`;
}
