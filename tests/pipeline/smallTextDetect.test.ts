import { describe, expect, it } from 'vitest';
import { nodePipelinePlatform } from '../../benchmark/nodePipelinePlatform';
import type { PipelineRenderingContext } from '../../packages/image-pipeline/src/runtime/platform';
import { detectSmallTextRegions } from '../../packages/image-pipeline/src/pipeline/detect/smallTextDetect';

const WIDTH = 1400;
const HEIGHT = 1100;

/** node-canvas 的 getContext 在类型上是可空的，测试里拿不到就没意义了 */
function requireContext(
  canvas: ReturnType<typeof nodePipelinePlatform.createCanvas>,
): PipelineRenderingContext {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建画布上下文');
  return context;
}

/** 造一张"小字"图：白底 + 若干行 11px 高的字形（每个字形是一圈笔画，中间留白） */
function createTextSheet(): { canvas: ReturnType<typeof nodePipelinePlatform.createCanvas> } {
  const canvas = nodePipelinePlatform.createCanvas(WIDTH, HEIGHT);
  const ctx = requireContext(canvas);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = '#111111';
  for (let line = 0; line < 6; line += 1) {
    const top = 60 + line * 120;
    for (let glyph = 0; glyph < 6; glyph += 1) {
      const left = 80 + glyph * 20;
      // 9×11 的笔画框，中间挖 3×5 的洞 —— 模拟一个真实的字形（fill≈0.85）
      ctx.fillRect(left, top, 9, 11);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(left + 3, top + 3, 3, 5);
      ctx.fillStyle = '#111111';
    }
  }
  return { canvas };
}

/** 造一张"大片实心 + 稀疏噪点"的图：都不该被当成文字行 */
function createNoiseSheet(): { canvas: ReturnType<typeof nodePipelinePlatform.createCanvas> } {
  const canvas = nodePipelinePlatform.createCanvas(WIDTH, HEIGHT);
  const ctx = requireContext(canvas);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  // 一大块实心深色（插画/色块）
  ctx.fillStyle = '#202020';
  ctx.fillRect(60, 60, 500, 400);
  // 稀疏噪点
  ctx.fillStyle = '#333333';
  for (let index = 0; index < 400; index += 1) {
    const x = (index * 97) % (WIDTH - 20);
    const y = 500 + ((index * 53) % (HEIGHT - 520));
    ctx.fillRect(x, y, 2, 2);
  }
  return { canvas };
}

function asImage(canvas: ReturnType<typeof nodePipelinePlatform.createCanvas>) {
  const shaped = canvas as unknown as { naturalWidth: number; naturalHeight: number };
  shaped.naturalWidth = canvas.width;
  shaped.naturalHeight = canvas.height;
  return shaped as never;
}

describe('小字增强检测', () => {
  it('英文资料不因照片占比高而漏掉附近的彩色标注', () => {
    const canvas = nodePipelinePlatform.createCanvas(WIDTH, HEIGHT);
    const ctx = requireContext(canvas);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#174c75'; ctx.fillRect(0, 0, WIDTH, 980);
    for (let glyph = 0; glyph < 6; glyph++) {
      const x = 80 + glyph * 20;
      ctx.fillStyle = '#ef1743'; ctx.fillRect(x, 1000, 9, 11);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x + 3, 1003, 3, 5);
    }
    const old = detectSmallTextRegions(asImage(canvas), nodePipelinePlatform);
    expect(old.regions.some(r => r.box.y >= 995)).toBe(false);
    const result = detectSmallTextRegions(asImage(canvas), nodePipelinePlatform, { documentMode: true });
    expect(result.regions.some(r => r.box.y >= 995 && r.box.width > 100)).toBe(true);
  });

  it('英文资料支持深色背景上的反白字，掩膜只覆盖笔画', () => {
    const canvas = nodePipelinePlatform.createCanvas(220, 80);
    const ctx = requireContext(canvas);
    ctx.fillStyle = '#174c75'; ctx.fillRect(0, 0, 220, 80);
    for (let glyph = 0; glyph < 6; glyph++) {
      const x = 20 + glyph * 20;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x, 30, 9, 11);
      ctx.fillStyle = '#174c75'; ctx.fillRect(x + 3, 33, 3, 5);
    }
    const result = detectSmallTextRegions(asImage(canvas), nodePipelinePlatform, { documentMode: true });
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].minOcrConfidence).toBe(0.75);
    expect(result.mask?.[30 * 220 + 20]).toBe(255);
    expect(result.mask?.[0]).toBe(0);
    expect(result.mask?.[34 * 220 + 24]).toBe(0);
  });

  it('跨分块的长行拼接为完整区域，不重复输出被截断的词', () => {
    const canvas = nodePipelinePlatform.createCanvas(1400, 160);
    const ctx = requireContext(canvas);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1400, 160);
    for (let glyph = 0; glyph < 30; glyph++) {
      const x = 800 + glyph * 20;
      ctx.fillStyle = '#111111'; ctx.fillRect(x, 60, 9, 11);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x + 3, 63, 3, 5);
    }
    const result = detectSmallTextRegions(asImage(canvas), nodePipelinePlatform, { documentMode: true });
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].box.x).toBeLessThanOrEqual(800);
    expect(result.regions[0].box.x + result.regions[0].box.width).toBeGreaterThanOrEqual(1389);
  });

  it('能把 9px 高的小字行检出来，并给出笔画掩膜', () => {
    const { canvas } = createTextSheet();
    const result = detectSmallTextRegions(asImage(canvas), nodePipelinePlatform);

    expect(result.regions.length).toBeGreaterThanOrEqual(4);
    const heights = result.regions.map((region) => region.box.height);
    // 都是小字：行高应该落在 6~20px
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(6);
    expect(Math.max(...heights)).toBeLessThan(30);

    expect(result.mask).not.toBeNull();
    const ink = result.mask ? result.mask.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0) : 0;
    // 掩膜是笔画级的：墨量应该远小于"把所有框涂满"
    const filled = result.regions.reduce((sum, r) => sum + r.box.width * r.box.height, 0);
    expect(ink).toBeGreaterThan(0);
    expect(ink).toBeLessThan(filled * 0.6);

    // 分块：1400×1100 用 1024 的块、15% 重叠 → 2×2 = 4 块
    expect(result.tiles).toBeGreaterThan(1);
  });

  it('实心色块和稀疏噪点不会被当成文字', () => {
    const { canvas } = createNoiseSheet();
    const result = detectSmallTextRegions(asImage(canvas), nodePipelinePlatform);
    // 允许极少量误检，但不能把整块插画当文字
    const huge = result.regions.filter((region) => region.box.width > 300 && region.box.height > 200);
    expect(huge.length).toBe(0);
  });

  it('补翻小图也进行补检，孤立笔画仍不当成文字', () => {
    const small = nodePipelinePlatform.createCanvas(600, 400);
    const ctx = requireContext(small);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 600, 400);
    ctx.fillStyle = '#111111';
    ctx.fillRect(40, 40, 3, 9);
    const result = detectSmallTextRegions(asImage(small), nodePipelinePlatform);
    expect(result.tiles).toBe(1);
    expect(result.regions).toEqual([]);
  });

  it('保留多个细笔画字形组成的短词，不用大段文字的墨量门槛过滤', () => {
    const canvas = nodePipelinePlatform.createCanvas(220, 30);
    const ctx = requireContext(canvas);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 220, 30);
    ctx.fillStyle = '#333333';
    // 三个 12×28 的细笔画字形，墨量 360 / 28² = 0.459，复现旧门槛误杀。
    for (let i = 0; i < 3; i++) {
      const x = 20 + i * 17;
      ctx.fillRect(x, 1, 2, 28);
      ctx.fillRect(x, 1, 12, 2);
      ctx.fillRect(x, 14, 12, 2);
      ctx.fillRect(x, 27, 12, 2);
    }
    const result = detectSmallTextRegions(asImage(canvas), nodePipelinePlatform);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].box).toEqual({ x: 20, y: 1, width: 46, height: 28 });
    expect(result.mask?.[0]).toBe(0);
  });

  it('工作副本中仅 2px 宽的 I/i/l 笔画仍参与短词分组', () => {
    const canvas = nodePipelinePlatform.createCanvas(100, 30);
    const ctx = requireContext(canvas);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 100, 30);
    ctx.fillStyle = '#333333';
    ctx.fillRect(20, 5, 2, 18);
    ctx.fillRect(28, 5, 2, 18);
    ctx.fillRect(28, 5, 10, 2);
    ctx.fillRect(28, 21, 10, 2);
    ctx.fillRect(46, 5, 2, 18);
    const result = detectSmallTextRegions(asImage(canvas), nodePipelinePlatform);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].box).toEqual({ x: 20, y: 5, width: 28, height: 18 });
  });
});
