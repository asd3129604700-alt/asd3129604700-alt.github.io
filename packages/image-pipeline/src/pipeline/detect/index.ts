import type { TextRegion, Rect } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import { detectByOnnx, type DetectOutput } from "./onnxDetect";
import { detectByHeuristic } from './heuristicOnly';
import {
  detectSmallTextRegions,
  mergeStrokeMaskInto,
  type SmallTextDetectOptions,
} from './smallTextDetect';
import { isCoveredTextFragment, rectIou } from '../utils';
import { toErrorMessage } from '../../errorMessage';
import type { ModelRuntime } from '@shinobu/model-runtime';

export type { DetectOutput };
export type { SmallTextDetectOptions } from './smallTextDetect';

export type DetectionFallbackStrategy =
  | { kind: 'heuristic-only' }
  | {
      kind: 'tesseract-then-heuristic';
      detectWithTesseract(
        image: PipelineImage,
        platform: PlatformProvider,
      ): Promise<TextRegion[]>;
    };

/** inner 有多大比例落在 outer 里面 */
function coverageOf(outer: Rect, inner: Rect): number {
  const x0 = Math.max(outer.x, inner.x);
  const y0 = Math.max(outer.y, inner.y);
  const x1 = Math.min(outer.x + outer.width, inner.x + inner.width);
  const y1 = Math.min(outer.y + outer.height, inner.y + inner.height);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = inner.width * inner.height;
  return area <= 0 ? 0 : intersection / area;
}

export type DetectOptions = {
  /**
   * 小字自动补检（原生分辨率分块）。默认关闭，由宿主显式启用。
   * 英文资料网页版启用 documentMode，同时用于整图和框选补翻。
   * 传 true 或一个选项对象才启用；详见 smallTextDetect.ts。
   */
  smallTextEnhance?: boolean | Partial<SmallTextDetectOptions>;
};

export async function detectTextRegionsWithMask(
  image: PipelineImage,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
  fallbackStrategy: DetectionFallbackStrategy,
  options: DetectOptions = {},
): Promise<DetectOutput> {
  const fallbackReasons: string[] = [];
  try {
    const onnxResult = await detectByOnnx(image, platform, modelRuntime);
    return withSmallText(onnxResult, { ...onnxResult, engine: 'onnx' }, image, platform, options);
  } catch (error) {
    const reason = toErrorMessage(error);
    fallbackReasons.push(`onnx: ${reason}`);
    console.warn(`[detect] onnx detector unavailable, fallback to tesseract/heuristic: ${reason}`);
  }

  if (fallbackStrategy.kind === 'tesseract-then-heuristic') {
    try {
      const tessRegions = await fallbackStrategy.detectWithTesseract(image, platform);
      if (tessRegions.length > 0) {
        return {
          regions: tessRegions,
          rawMaskCanvas: null,
          engine: "tesseract",
          fallbackReason: fallbackReasons.join(" | ")
        };
      }
    } catch (error) {
      const reason = toErrorMessage(error);
      fallbackReasons.push(`tesseract: ${reason}`);
      console.warn(`[detect] tesseract fallback unavailable, switch to heuristic: ${reason}`);
    }
  }

  const heuristicRegions = await detectByHeuristic(image, platform);
  return {
    regions: heuristicRegions,
    rawMaskCanvas: null,
    engine: "heuristic",
    fallbackReason: fallbackReasons.join(" | ")
  };
}

/**
 * 把检测器结果与小字增强结果合起来。
 *
 * 只有"和已有区域基本不重叠"的小字区域才会被加进来 —— 检测器已经找到的地方
 * 它的框更准，没必要用小字那套粗糙的框覆盖它。
 * 掩膜取并集（笔画级），保证补回来的小字同样会被去字。
 */
function withSmallText(
  onnxResult: DetectOutput,
  base: DetectOutput,
  image: PipelineImage,
  platform: PlatformProvider,
  options: DetectOptions,
): DetectOutput {
  // 保留其他宿主默认行为；网页通过选项开启资料补检。
  if (options.smallTextEnhance !== true && typeof options.smallTextEnhance !== 'object') {
    return base;
  }

  let enhanced;
  try {
    enhanced = detectSmallTextRegions(
      image,
      platform,
      typeof options.smallTextEnhance === 'object' ? options.smallTextEnhance : {},
    );
  } catch (error) {
    // 小字增强失败不能影响主流程：检测器结果照常返回
    console.warn(`[detect] small-text enhancement failed: ${toErrorMessage(error)}`);
    return base;
  }

  if (enhanced.regions.length === 0 || !enhanced.mask) return base;

  const documentMode = typeof options.smallTextEnhance === 'object' && options.smallTextEnhance.documentMode;
  const primary = documentMode ? preferCompleteDocumentLines(onnxResult.regions, enhanced.regions) : onnxResult.regions;
  const extra = enhanced.regions.filter(
    (candidate) =>
      !primary.some((kept) => rectIou(kept.box, candidate.box) > 0.4)
      // 被检测器的框**整块包住**的小字也丢掉：那行文字检测器已经给出了，
      // 补检又把它切成几个碎片，翻译时会和整行重复画一遍。
      // 门槛取 0.8 而不是 1.0：补检切出来的碎片常常比检测器的框高几个像素。
      && !primary.some((kept) => coverageOf(kept.box, candidate.box) >= 0.8
        || (documentMode && isCoveredTextFragment(kept.box, candidate.box))),
  );

  const rawMaskCanvas = mergeStrokeMaskInto(
    onnxResult.rawMaskCanvas,
    enhanced.mask,
    image.naturalWidth,
    image.naturalHeight,
    platform,
  );

  if (extra.length === 0) {
    return { ...base, rawMaskCanvas };
  }

  console.info(
    `[detect] small-text enhancement: +${extra.length} regions (${enhanced.tiles} tiles, ` +
      `${enhanced.skippedTiles} skipped) on ${image.naturalWidth}×${image.naturalHeight}`,
  );

  return {
    ...base,
    regions: [...primary, ...extra].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x),
    rawMaskCanvas,
  };
}

/** 主检测器有时只找到一句的两端；不能用任一碎片的 IoU 丢掉补检的完整行。 */
export function preferCompleteDocumentLines(primary: TextRegion[], supplemental: TextRegion[]): TextRegion[] {
  const complete = supplemental.filter(candidate => !primary.some(kept =>
    coverageOf(kept.box, candidate.box) >= 0.8 || isCoveredTextFragment(kept.box, candidate.box)));
  return primary.filter(fragment => !complete.some(candidate => {
    const a = candidate.box, b = fragment.box;
    return a.width >= b.width * 1.2 && a.height <= b.height * 2.3
      && Math.abs(a.y + a.height / 2 - b.y - b.height / 2) <= Math.max(a.height, b.height) * 0.25
      && coverageOf(a, b) >= 0.85;
  }));
}

export async function detectTextRegions(
  image: PipelineImage,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
  fallbackStrategy: DetectionFallbackStrategy,
  options: DetectOptions = {},
): Promise<TextRegion[]> {
  const result = await detectTextRegionsWithMask(
    image,
    platform,
    modelRuntime,
    fallbackStrategy,
    options,
  );
  return result.regions;
}
