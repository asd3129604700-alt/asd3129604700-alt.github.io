import type {
  PlatformProvider,
  PipelineCanvas,
  PipelineImage,
} from '../../runtime/platform';
import type { TextRegion } from '../../types';
import { connectedComponents, makeRegion } from './onnxDetect';
import { isCoveredTextFragment, rectIou } from '../utils';

/**
 * 小字增强检测。
 *
 * 为什么需要它：文本检测模型的输入是**写死的 1024×1024**（实测喂 1536/2048 直接报错），
 * 而它拿到的是一张 letterbox 到 1024 的整图。一张 5100×3300 的图纸因此被缩到 0.2 倍，
 * 14px 的小字只剩 2.8px —— 模型根本看不见，整张图只检出 9 个区域。
 *
 * 解法：把图按**当前工作分辨率**切成 1024 的块做笔画分析（不再缩小，也不调用 ONNX），
 * 再把结果映射回整图。为了不把插画噪点当成字，做了三层过滤：
 *   1. 连通块层：尺寸/实心度/墨量合理（字体笔画既不是实心色块，也不是稀疏噪点）
 *   2. 行层：按字高相近把块连成行（字高比 ≤1.8、纵向重叠 ≥60%、横向间隙 ≤1.2 倍行高）
 *   3. 行过滤：行高 6~90px、墨量 ≥60px、墨量/行高² ≥0.55；三个以上字形的横向短词放宽到 0.4
 *
 * 实测（hololive-deco.jpg 5100×3300，真实流水线在 Node 里跑）：
 *   只用整图检测 → 9 个区域 / OCR 出 9 行
 *   加上本模块   → 123 个区域 / OCR 出 114 行（其中多字符 87 行，8~16px 的小字都出来了）
 *   代价：纯 JS 约 0.4 秒，多出来的区域让 OCR 多花约 2.4 秒；ONNX 推理次数不变。
 *
 * 不做过滤的版本能出 198 行，但全是单字符垃圾，而且那些区域会被当成文字去**擦**，
 * 连累插画 —— 这就是必须过滤的原因。
 */

export type SmallTextDetectOptions = {
  /** 英文资料：同时检查深色/浅色文字，照片占比不再导致整个分块被跳过。 */
  documentMode: boolean;
  /** 分块边长。默认与检测器输入一致（1024），这样每块是 1:1 原生分辨率 */
  tileSize: number;
  /** 相邻块的重叠比例，避免正好切断文字 */
  overlap: number;
  /** 连通块高度范围（原图像素） */
  minGlyphHeight: number;
  maxGlyphHeight: number;
  /** 连成行之后的行高范围 */
  minLineHeight: number;
  maxLineHeight: number;
  /** 一行至少要有多少墨像素 */
  minLineInk: number;
  /** 墨量 / 行高² 的下限（"一行字至少要有几个字"） */
  minGlyphRatio: number;
  /**
   * 一行至少由几个连通块组成。真实文字行通常是多个字形连起来的；
   * 孤零零一个块更可能是噪点或插画碎片。
   * 实测（5100×3300 图纸）：1 时有 96 行 OCR 结果但 24 个单字符垃圾，
   * 2 时保住 70/72 条真实行、垃圾降到 7 —— 所以默认 2。
   */
  minComponentsPerLine: number;
  /** 分块数量上限；超过就自动放大块边长，保证耗时可控 */
  maxTiles: number;
  /** 区域数量上限（防御性上限） */
  maxRegions: number;
};

export const DEFAULT_SMALL_TEXT_OPTIONS: SmallTextDetectOptions = {
  documentMode: false,
  tileSize: 1024,
  overlap: 0.15,
  minGlyphHeight: 5,
  maxGlyphHeight: 70,
  minLineHeight: 6,
  maxLineHeight: 90,
  minLineInk: 60,
  minGlyphRatio: 0.55,
  minComponentsPerLine: 2,
  maxTiles: 64,
  maxRegions: 600,
};

export type SmallTextDetectResult = {
  regions: TextRegion[];
  /** 笔画级掩膜（255 = 文字笔画），尺寸与图像一致；没有命中时为 null */
  mask: Uint8Array | null;
  tiles: number;
  skippedTiles: number;
};

type Component = {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
  /** 由几个原始连通块连成（用于判断"这行是不是只有一个块"） */
  members: number;
};

/** Otsu 风格的均值-标准差阈值，与 heuristicOnly 里的做法一致 */
function estimateThreshold(grays: Uint8ClampedArray): number {
  let sum = 0;
  let squareSum = 0;
  for (let index = 0; index < grays.length; index += 1) {
    const value = grays[index];
    sum += value;
    squareSum += value * value;
  }
  const mean = sum / grays.length;
  const variance = Math.max(0, squareSum / grays.length - mean * mean);
  const threshold = Math.round(mean - Math.sqrt(variance) * 0.35);
  return Math.max(70, Math.min(170, threshold));
}

/** 把"像字"的连通块连成行 */
function groupIntoLines(components: readonly Component[]): Component[] {
  const lines: Component[] = [];
  const used = new Array<boolean>(components.length).fill(false);
  const sorted = components.slice().sort((a, b) => a.y - b.y || a.x - b.x);

  for (let start = 0; start < sorted.length; start += 1) {
    if (used[start]) continue;
    let current: Component = { ...sorted[start] };
    used[start] = true;

    let grew = true;
    while (grew) {
      grew = false;
      for (let index = 0; index < sorted.length; index += 1) {
        if (used[index]) continue;
        const candidate = sorted[index];
        const minHeight = Math.min(current.height, candidate.height);
        const maxHeight = Math.max(current.height, candidate.height);
        if (maxHeight / minHeight > 1.8) continue;
        const verticalOverlap =
          Math.min(current.y + current.height, candidate.y + candidate.height) -
          Math.max(current.y, candidate.y);
        if (verticalOverlap < minHeight * 0.6) continue;
        const gap =
          Math.max(current.x, candidate.x) -
          Math.min(current.x + current.width, candidate.x + candidate.width);
        if (gap > maxHeight * 1.2) continue;

        const left = Math.min(current.x, candidate.x);
        const top = Math.min(current.y, candidate.y);
        const right = Math.max(current.x + current.width, candidate.x + candidate.width);
        const bottom = Math.max(current.y + current.height, candidate.y + candidate.height);
        current = {
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
          pixels: current.pixels + candidate.pixels,
          members: current.members + candidate.members,
        };
        used[index] = true;
        grew = true;
      }
    }
    lines.push(current);
  }
  return lines;
}

function tileCount(size: number, tile: number, step: number): number {
  if (size <= tile) return 1;
  return Math.ceil((size - tile) / step) + 1;
}

/** 把重叠分块切断的同一行接回去；不跨空白间隔连接不同列/单元格。 */
function stitchTileLines(items: { region: TextRegion; ink: number }[]): typeof items {
  const result: typeof items = [];
  for (const item of items) {
    let box = item.region.box;
    let ink = item.ink;
    for (let index = 0; index < result.length; index += 1) {
      const other = result[index].region.box;
      const minHeight = Math.min(box.height, other.height);
      const overlapY = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
      const overlapX = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
      if (Math.max(box.height, other.height) > minHeight * 1.3
        || overlapY < minHeight * 0.85 || overlapX < Math.min(5, minHeight * 0.25)) continue;
      const x = Math.min(box.x, other.x), y = Math.min(box.y, other.y);
      box = { x, y, width: Math.max(box.x + box.width, other.x + other.width) - x,
        height: Math.max(box.y + box.height, other.y + other.height) - y };
      ink = Math.max(ink, result[index].ink);
      result.splice(index, 1);
      index = -1;
    }
    result.push({ region: makeRegion(box), ink });
  }
  return result;
}

/**
 * 找出被整图检测漏掉的小字区域。
 * 返回的 mask 是**笔画级**的（只覆盖文字笔画像素，不是把框涂满）——
 * 掩膜会被送去细化与修复，涂满会把框里的插画一起擦掉。
 */
export function detectSmallTextRegions(
  image: PipelineImage,
  platform: PlatformProvider,
  options: Partial<SmallTextDetectOptions> = {},
): SmallTextDetectResult {
  const opts: SmallTextDetectOptions = { ...DEFAULT_SMALL_TEXT_OPTIONS, ...options };
  const width = image.naturalWidth;
  const height = image.naturalHeight;

  // 手动补翻的裁图通常小于 1024。即使检测器会放大它，短词仍可能被模型漏掉，
  // 因此小图也做一次笔画补检。

  const baseStep = Math.max(1, Math.round(opts.tileSize * (1 - opts.overlap)));
  let tile = opts.tileSize;
  let step = baseStep;
  let tilesX = tileCount(width, tile, step);
  let tilesY = tileCount(height, tile, step);
  // 块太多就放大块边长，保证总耗时可控（宁可少一点细节，也不要让用户等太久）
  while (tilesX * tilesY > opts.maxTiles) {
    tile = Math.round(tile * 1.25);
    step = Math.max(1, Math.round(tile * (1 - opts.overlap)));
    tilesX = tileCount(width, tile, step);
    tilesY = tileCount(height, tile, step);
  }

  const mask = new Uint8Array(width * height);
  const found: { region: TextRegion; ink: number }[] = [];
  let tiles = 0;
  let skippedTiles = 0;

  for (let top = 0; top < height; top += step) {
    const tileHeight = Math.min(tile, height - top);
    if (tileHeight < opts.minLineHeight) break;
    for (let left = 0; left < width; left += step) {
      const tileWidth = Math.min(tile, width - left);
      if (tileWidth < 2) break;
      tiles += 1;

      const canvas = platform.createCanvas(tileWidth, tileHeight);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) continue;
      context.drawImage(image, left, top, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight);
      const pixels = context.getImageData(0, 0, tileWidth, tileHeight).data;

      const total = tileWidth * tileHeight;
      const grays = new Uint8ClampedArray(total);
      for (let index = 0, pixel = 0; index < total; index += 1, pixel += 4) {
        grays[index] = Math.round(
          pixels[pixel] * 0.299 + pixels[pixel + 1] * 0.587 + pixels[pixel + 2] * 0.114,
        );
      }
      let analyzedTile = false;
      for (const lightText of opts.documentMode ? [false, true] : [false]) {
        const signal = lightText ? grays.map((gray) => 255 - gray) : grays;
        const threshold = estimateThreshold(signal);
        const dark = new Uint8Array(total);
        let ink = 0;
        for (let index = 0; index < total; index += 1) {
          if (signal[index] < threshold) {
            dark[index] = 1;
            ink += 1;
          }
        }
        // 资料模式只跳过接近纯色的分块；照片占比高时仍检查其中和周边的文字。
        //
        // 下限特意压得很低（0.0004 ≈ 一块里 400 个墨点）：门槛高了会把
        // "只有一两行小字"的稀疏页面整块跳过 —— 那正是这个模块要救的情况。
        // 真正的空白块墨量几乎是 0，仍然会被跳过，省下的时间照样省。
        const density = ink / total;
        if (density < 0.0004 || density > (opts.documentMode ? 0.98 : 0.3)) {
          continue;
        }

        const components: Component[] = [];
        // 缩小后的 I / i / l 可能只有 2px 宽；检测掩膜默认的 4px 门槛不适用于字形。
        for (const rect of connectedComponents(dark, tileWidth, tileHeight, 2)) {
          if (rect.height < opts.minGlyphHeight || rect.height > opts.maxGlyphHeight) continue;
          if (rect.width < 2 || rect.width > opts.maxGlyphHeight * 6) continue;
          let pixelsInked = 0;
          for (let y = rect.y; y < rect.y + rect.height; y += 1) {
            const rowStart = y * tileWidth;
            for (let x = rect.x; x < rect.x + rect.width; x += 1) {
              if (dark[rowStart + x]) pixelsInked += 1;
            }
          }
          const fill = pixelsInked / Math.max(1, rect.width * rect.height);
          // 稀疏噪点：框里几乎没墨
          if (fill < 0.12) continue;
          // 方块状的实心块（色块 / 图案碎片）：CJK 字形内部有留白（fill 通常 <0.8），
          // 而细长的实心笔画（拉丁字母的竖笔）长宽比远离 1 —— 所以只看"接近正方形且全实心"。
          const aspect = rect.width / rect.height;
          if (fill > 0.9 && aspect > 0.5 && aspect < 2) continue;
          if (pixelsInked < 14) continue;
          components.push({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            pixels: pixelsInked,
            members: 1,
          });
        }
        if (components.length === 0) {
          continue;
        }
        analyzedTile = true;

        for (const line of groupIntoLines(components)) {
          if (line.height < opts.minLineHeight || line.height > opts.maxLineHeight) continue;
          if (line.pixels < opts.minLineInk) continue;
          const glyphRatio = line.pixels / (line.height * line.height);
          // Iris / Grey 等细笔画短词的墨量约为行高²的 0.4~0.5，原来的 0.55
          // 会把完整的词丢掉。只对至少三个字形组成的横向短词放宽，保留噪点过滤。
          const shortWord = line.members >= 3
            && line.width >= line.height * 1.5
            && line.width <= line.height * 4;
          if (glyphRatio < (shortWord ? Math.min(opts.minGlyphRatio, 0.4) : opts.minGlyphRatio)) continue;
          if (line.members < opts.minComponentsPerLine) continue;

          const box = {
            x: line.x + left,
            y: line.y + top,
            width: line.width,
            height: line.height,
          };
          found.push({ region: makeRegion(box), ink: line.pixels });

          // 笔画级掩膜：只把当前极性的笔画像素搬过去（映射到整图坐标）
          for (let y = line.y; y < line.y + line.height; y += 1) {
            const rowStart = y * tileWidth;
            const targetRow = (y + top) * width;
            for (let x = line.x; x < line.x + line.width; x += 1) {
              if (dark[rowStart + x]) mask[targetRow + x + left] = 255;
            }
          }
        }
      }
      if (!analyzedTile) skippedTiles += 1;

      if (left + tileWidth >= width) break;
    }
  }

  // 跨块去重：同一个字可能落在相邻块的重叠区里，被检出两次
  const regions: TextRegion[] = [];
  const sorted = (opts.documentMode ? stitchTileLines(found) : found).sort((a, b) => b.ink - a.ink);
  for (const item of sorted) {
    const duplicate = regions.some((kept) => rectIou(kept.box, item.region.box) > 0.5
      || (opts.documentMode && isCoveredTextFragment(kept.box, item.region.box)));
    if (duplicate) continue;
    if (opts.documentMode) {
      // 笔画紧贴 OCR 裁图边缘容易丢字，且会把正常英文单词误判为超长行。
      const b = item.region.box;
      const padX = Math.max(2, Math.ceil(b.height * 0.1));
      const padY = Math.max(2, Math.ceil(b.height * 0.15));
      const x = Math.max(0, b.x - padX), y = Math.max(0, b.y - padY);
      const padded = makeRegion({ x, y, width: Math.min(width, b.x + b.width + padX) - x,
        height: Math.min(height, b.y + b.height + padY) - y });
      padded.minOcrConfidence = 0.75;
      regions.push(padded);
    } else {
      regions.push(item.region);
    }
    if (regions.length >= opts.maxRegions) break;
  }

  return {
    regions,
    mask: regions.length > 0 ? mask : null,
    tiles,
    skippedTiles,
  };
}

/**
 * 把笔画掩膜并进检测器自己的掩膜里。
 *
 * 只对**笔画像素**做写入（掩膜里绝大多数是 0），避免在 16M 像素上做全量循环 ——
 * 全量循环在 5100×3300 上要好几秒，稀疏写入只要几十毫秒。
 */
export function mergeStrokeMaskInto(
  base: PipelineCanvas | null,
  mask: Uint8Array,
  width: number,
  height: number,
  platform: PlatformProvider,
): PipelineCanvas {
  const canvas = platform.createCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('小字增强：无法创建掩膜画布');

  // 没有基础掩膜时先铺一层不透明的黑，保证掩膜整体语义和检测器输出一致
  // （后续 putImageData 会按整块覆盖，透明与否会影响 downstream 的合成结果）
  if (!base) {
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
  } else {
    context.drawImage(base, 0, 0);
  }

  const imageData = context.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) continue;
    const pixel = index << 2;
    data[pixel] = 255;
    data[pixel + 1] = 255;
    data[pixel + 2] = 255;
    data[pixel + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
}
