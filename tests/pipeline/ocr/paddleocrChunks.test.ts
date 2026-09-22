import { describe, expect, it } from 'vitest';
import { planPaddleOcrChunks } from '../../../packages/image-pipeline/src/pipeline/ocr/paddleocrPreprocess';

/** PP-OCRv6 识别模型的输入：高 48、宽 320（见 public/models/models.json） */
const INPUT_HEIGHT = 48;
const MAX_INPUT_WIDTH = 320;
/** 能完整读进去的极限宽高比 */
const ASPECT_LIMIT = MAX_INPUT_WIDTH / INPUT_HEIGHT;

describe('planPaddleOcrChunks', () => {
  it('宽高比在模型能力内的行不切', () => {
    const box = { x: 10, y: 20, width: 200, height: 50 };
    const plan = planPaddleOcrChunks(box, INPUT_HEIGHT, MAX_INPUT_WIDTH);
    expect(plan.rects).toEqual([box]);
    expect(plan.startsAtWordGap).toEqual([false]);
  });

  it('长行切成若干段，每段都在模型吃得下的比例内，且首尾相接不重叠', () => {
    const box = { x: 381, y: 1299, width: 1885, height: 50 };
    const plan = planPaddleOcrChunks(box, INPUT_HEIGHT, MAX_INPUT_WIDTH);

    expect(plan.rects.length).toBeGreaterThan(1);
    expect(plan.rects[0].x).toBe(box.x);
    const last = plan.rects[plan.rects.length - 1];
    expect(last.x + last.width).toBe(box.x + box.width);

    for (const [index, rect] of plan.rects.entries()) {
      expect(rect.y).toBe(box.y);
      expect(rect.height).toBe(box.height);
      // 超过这个比例就会被 buildPaddleOcrInput 横向压扁，字就糊了
      expect(rect.width / rect.height).toBeLessThanOrEqual(ASPECT_LIMIT);
      if (index > 0) {
        const previous = plan.rects[index - 1];
        expect(rect.x).toBe(previous.x + previous.width);
      }
    }
  });

  it('有墨量时切点落在词的空隙上，拼回去要补空格', () => {
    const box = { x: 0, y: 0, width: 1885, height: 50 };
    // 造一条"字—缝—字"的墨量剖面：每 100 列里有 12 列是词距
    const columnInk = new Uint32Array(box.width).fill(20);
    for (let column = 0; column < box.width; column += 100) {
      for (let offset = 0; offset < 12; offset += 1) columnInk[column + offset] = 0;
    }

    const plan = planPaddleOcrChunks(box, INPUT_HEIGHT, MAX_INPUT_WIDTH, columnInk);

    expect(plan.rects.length).toBeGreaterThan(1);
    for (const [index, rect] of plan.rects.entries()) {
      if (index === 0) {
        expect(plan.startsAtWordGap[index]).toBe(false);
        continue;
      }
      // 切点必须落在没有墨的那 12 列里
      expect(columnInk[rect.x - box.x]).toBe(0);
      expect(plan.startsAtWordGap[index]).toBe(true);
    }
  });

  it('切点只能落在字母缝里时，标记为不需要补空格', () => {
    const box = { x: 0, y: 0, width: 1885, height: 50 };
    // 每一列都有墨：没有词距可挑，只能落在字母之间，不能当成词距补空格
    const columnInk = new Uint32Array(box.width).fill(20);
    columnInk[300] = 0;
    columnInk[301] = 0;

    const plan = planPaddleOcrChunks(box, INPUT_HEIGHT, MAX_INPUT_WIDTH, columnInk);
    expect(plan.rects.length).toBeGreaterThan(1);
    expect(plan.startsAtWordGap.some(Boolean)).toBe(false);
  });
});
