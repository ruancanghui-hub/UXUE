import { createHash } from 'node:crypto';

/** project.json 文本指纹：自己写入与磁盘回写相同时可忽略外部 watch */
export function hashProjectText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
