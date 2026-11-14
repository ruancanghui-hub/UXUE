import { describe, expect, it } from 'vitest';
import { buildMultipart } from './multipart';

describe('buildMultipart', () => {
  it('文本字段、文件字段和结尾分隔符都按 multipart/form-data 规范拼好', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { body, contentType } = buildMultipart(
      { model: 'gpt-image-2', prompt: '画一只猫', n: 1 },
      [{ field: 'image', filename: 'image-1.png', contentType: 'image/png', data: png }],
      'BOUNDARY',
    );
    expect(contentType).toBe('multipart/form-data; boundary=BOUNDARY');
    const text = body.toString('latin1');
    expect(text.startsWith('--BOUNDARY\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n')).toBe(true);
    expect(body.toString('utf8')).toContain('name="prompt"\r\n\r\n画一只猫\r\n');
    expect(text).toContain('name="n"\r\n\r\n1\r\n');
    expect(text).toContain('Content-Disposition: form-data; name="image"; filename="image-1.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n');
    expect(text.endsWith('--BOUNDARY--\r\n')).toBe(true);
  });

  it('多张图各占一个文件段', () => {
    const files = [1, 2].map((i) => ({ field: 'image[]', filename: `image-${i}.png`, contentType: 'image/png', data: new Uint8Array([i]) }));
    const text = buildMultipart({ prompt: 'x' }, files, 'B').body.toString('latin1');
    expect(text.match(/name="image\[\]"/g)).toHaveLength(2);
  });
});
