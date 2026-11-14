import { randomBytes } from 'node:crypto';

export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/**
 * 手工拼 multipart/form-data：OpenAI 兼容中转的 /images/edits 只收这种格式（图片是文件字段）。
 * 不用 FormData，是因为 net.fetch 对 FormData 请求体的支持随 Electron 版本变化。
 */
export function buildMultipart(
  fields: Record<string, string | number>,
  files: MultipartFile[],
  boundary = `----anye${randomBytes(12).toString('hex')}`,
): { body: Buffer; contentType: string } {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
      Buffer.from(file.data),
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
