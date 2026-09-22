import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, Image } from 'canvas';
import { cropRegionForPatch, resultBlobForPatch, selectionToWorkingRect } from '../../apps/web/src/features/patch/regionPatch';

afterEach(() => vi.unstubAllGlobals());

describe('补翻坐标与图像', () => {
  it('原图和结果预览均按工作副本尺寸定位，并裁掉选区的越界部分', () => {
    expect(selectionToWorkingRect({ x: 100, y: 200, width: 50, height: 40 },
      { width: 1000, height: 800 }, { width: 2000, height: 1600 }))
      .toEqual({ x: 200, y: 400, width: 100, height: 80 });
    expect(selectionToWorkingRect({ x: -10, y: 70, width: 40, height: 20 },
      { width: 100, height: 80 }, { width: 1000, height: 800 }))
      .toEqual({ x: 0, y: 700, width: 300, height: 100 });
  });

  it('大选区等比缩放时仍包含右下角，不截取左上局部', async () => {
    const source = createCanvas(400, 200);
    const ctx = source.getContext('2d');
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 400, 200);
    ctx.fillStyle = '#0000ff'; ctx.fillRect(200, 100, 200, 100);
    vi.stubGlobal('HTMLImageElement', Image);
    vi.stubGlobal('createImageBitmap', async () => {
      const image = new Image(); image.src = source.toBuffer('image/png'); return image;
    });
    vi.stubGlobal('document', { createElement: () => {
      const canvas = createCanvas(1, 1);
      return Object.assign(canvas, { toBlob: (callback: (blob: Blob) => void) =>
        callback(new Blob([new Uint8Array(canvas.toBuffer('image/png'))], { type: 'image/png' })) });
    } });
    const crop = await cropRegionForPatch(new Blob(), { x: 0, y: 0, width: 200, height: 100 }, 0.5, { maxEdge: 100 });
    expect([crop.width, crop.height]).toEqual([100, 50]);
    const output = new Image(); output.src = Buffer.from(await crop.file.arrayBuffer());
    const check = createCanvas(100, 50).getContext('2d'); check.drawImage(output, 0, 0);
    expect([...check.getImageData(90, 40, 1, 1).data]).toEqual([0, 0, 255, 255]);
  });

  it('结果只有 URL 时仍可合并；优先使用已有 Blob', async () => {
    const blob = new Blob(['result']);
    const fetcher = vi.fn().mockResolvedValue(new Response(blob)); vi.stubGlobal('fetch', fetcher);
    expect(await resultBlobForPatch({ resultBlob: blob, resultUrl: 'blob:test' })).toBe(blob);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await (await resultBlobForPatch({ resultUrl: 'blob:test' }))!.text()).toBe('result');
    expect(await resultBlobForPatch(undefined)).toBeNull();
  });
});
