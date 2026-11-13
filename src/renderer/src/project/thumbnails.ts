import { PROJECT_HOST } from '../../../shared/bench';
import { texturedImage } from '../../../shared/textures';
import type { Version } from '../../../shared/project';

/** 面板里用的 L0 缩略图地址；cacheBust 在缓存重建后递增，让 <img> 重新请求 */
export function thumbnailUrl(version: Version, cacheBust = 0): string {
  const url = texturedImage(PROJECT_HOST, version.id, version.width, version.height).urls[0];
  return cacheBust > 0 ? `${url}?v=${cacheBust}` : url;
}
