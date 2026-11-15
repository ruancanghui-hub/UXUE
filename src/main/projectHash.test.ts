import { describe, expect, it } from 'vitest';
import { hashProjectText } from './projectHash';

describe('hashProjectText', () => {
  it('相同内容指纹相同，改一个字符就不同', () => {
    const a = '{\n  "schemaVersion": 2\n}\n';
    const b = '{\n  "schemaVersion": 2\n}\n';
    const c = '{\n  "schemaVersion": 3\n}\n';
    expect(hashProjectText(a)).toBe(hashProjectText(b));
    expect(hashProjectText(a)).not.toBe(hashProjectText(c));
    expect(hashProjectText(a)).toMatch(/^[a-f0-9]{64}$/);
  });
});
