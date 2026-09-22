import { describe, expect, it } from 'vitest';
import { mergedStorageKey } from '../../apps/web/src/features/patch/regionPatch';

describe('补翻结果的存档键', () => {
  const base = { name: 'sheet.png', size: 1234, width: 5100, height: 3300 };

  it('同一个文件每次都得到同一个键', () => {
    expect(mergedStorageKey(base)).toBe(mergedStorageKey({ ...base }));
  });

  it('不依赖 lastModified —— 从历史恢复出来的 File 会换一个 lastModified，实测就栽在这里', () => {
    const withMtime = { ...base, lastModified: 1 } as typeof base & { lastModified: number };
    const restored = { ...base, lastModified: Date.now() } as typeof base & { lastModified: number };
    expect(mergedStorageKey(withMtime)).toBe(mergedStorageKey(restored));
  });

  it('不同文件（改名字 / 大小 / 尺寸）得到不同的键', () => {
    const keys = [
      mergedStorageKey(base),
      mergedStorageKey({ ...base, name: 'other.png' }),
      mergedStorageKey({ ...base, size: 1235 }),
      mergedStorageKey({ ...base, width: 5101 }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('键是定长十六进制，能直接当文件名用', () => {
    expect(mergedStorageKey(base)).toMatch(/^[0-9a-f]{8}$/u);
  });
});
