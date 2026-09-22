import { describe, expect, it } from 'vitest';
import { isCoveredTextFragment } from '../../packages/image-pipeline/src/pipeline/utils';

describe('英文补检的同行碎片去重', () => {
  const line = { x: 380, y: 1300, width: 1800, height: 50 };

  it('整行已识别时，去掉带 OCR 留白的重复短片段', () => {
    expect(isCoveredTextFragment(line, { x: 410, y: 1290, width: 280, height: 74 })).toBe(true);
    expect(isCoveredTextFragment(line, { x: 870, y: 1308, width: 105, height: 56 })).toBe(true);
  });

  it('保留相邻行、旁边的独立单元格以及补检得到的更完整文本', () => {
    expect(isCoveredTextFragment(line, { x: 410, y: 1350, width: 280, height: 74 })).toBe(false);
    expect(isCoveredTextFragment(line, { x: 2200, y: 1300, width: 280, height: 50 })).toBe(false);
    expect(isCoveredTextFragment({ x: 410, y: 1300, width: 280, height: 50 }, line)).toBe(false);
  });
});
