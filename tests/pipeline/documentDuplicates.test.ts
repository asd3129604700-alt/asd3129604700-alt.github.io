import { describe, it, expect } from 'vitest';
import { deduplicateEnglishOcr } from '../../packages/image-pipeline/src/pipeline/ocr/deduplicate';
import { preferCompleteDocumentLines } from '../../packages/image-pipeline/src/pipeline/detect';
import type { TextRegion, Rect } from '../../packages/image-pipeline/src/types';
const region = (id: string, sourceText: string, box: Rect): TextRegion => ({ id, sourceText, box, translatedText: '', direction: 'h' });

describe('英文资料完整行与碎片', () => {
  it('去掉同一句较高框中的重复片段，保留完整句', () => {
    const whole = region('whole', 'Can we improve her bow shape to match to the design as much as possible?', { x: 1203, y: 1130, width: 1153, height: 25 });
    const fragments = [
      region('fragment1', 'prove her bow shape to match to the desig', { x: 1359, y: 1121, width: 661, height: 46 }),
      region('fragment2', 'uch as p', { x: 2116, y: 1121, width: 129, height: 46 }),
    ];
    expect(deduplicateEnglishOcr([...fragments, whole])).toEqual([whole]);
    expect(deduplicateEnglishOcr([whole, ...fragments])).toEqual([whole]);
  });
  it('不删除不同位置的相同标签或同行不同文字', () => {
    const entries = [region('a', 'fabric', { x: 0, y: 0, width: 100, height: 25 }),
      region('b', 'fabric', { x: 0, y: 40, width: 100, height: 25 }),
      region('c', 'color', { x: 20, y: 0, width: 70, height: 25 })];
    expect(deduplicateEnglishOcr(entries)).toEqual(entries);
  });
  it('补检的完整长行替代主检测器两端碎片，保住中间漏字', () => {
    const fragments = [region('left', '', { x: 1288, y: 1526, width: 268, height: 24 }),
      region('right', '', { x: 1641, y: 1526, width: 685, height: 24 })];
    const complete = region('complete', '', { x: 1305, y: 1522, width: 1029, height: 38 });
    expect(preferCompleteDocumentLines(fragments, [complete])).toEqual([]);
  });
  it('保留邻行和主检测器已有的完整行', () => {
    const whole = region('whole', '', { x: 100, y: 100, width: 1000, height: 30 });
    const nearby = region('nearby', '', { x: 100, y: 150, width: 1200, height: 40 });
    const fragment = region('fragment', '', { x: 120, y: 100, width: 300, height: 40 });
    expect(preferCompleteDocumentLines([whole], [nearby, fragment])).toEqual([whole]);
  });
});
