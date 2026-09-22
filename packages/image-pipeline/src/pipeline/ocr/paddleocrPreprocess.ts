import type { Rect, TextRegion } from '../../types';
import type { PlatformProvider, PipelineImage } from '../../runtime/platform';
import type { Direction } from './preprocess';
import { getTransformedRegion } from './preprocess';

export type PaddleOcrInputData = {
  data: Float32Array;
  dims: number[];
  resizedWidth: number;
};

export type PaddleOcrChannelOrder = 'rgb' | 'bgr';

/**
 * 从 image 裁剪 region 区域，对竖排文字做透视变换+90度旋转，
 * resize 到 inputHeight 高度，宽度按比例缩放（不超过 maxInputWidth），归一化后输出 NCHW Float32Array。
 */
export function buildPaddleOcrInput(
  image: PipelineImage,
  region: TextRegion,
  direction: Direction,
  inputHeight: number,
  maxInputWidth: number,
  normalize: 'zero_to_one' | 'minus_one_to_one',
  platform: PlatformProvider,
  channelOrder: PaddleOcrChannelOrder = 'rgb',
): PaddleOcrInputData {
  // 使用 getTransformedRegion 处理透视变换和竖排旋转
  const source = getTransformedRegion(image, region, direction, inputHeight, platform);
  const srcWidth = Math.max(1, source.width);
  const srcHeight = Math.max(1, source.height);

  // Resize 到 inputHeight，宽度按比例
  const ratio = srcWidth / srcHeight;
  const resizedWidth = Math.max(1, Math.min(maxInputWidth, Math.round(ratio * inputHeight)));

  const resizeCanvas = platform.createCanvas(resizedWidth, inputHeight);
  const resizeCtx = resizeCanvas.getContext('2d')!;
  resizeCtx.drawImage(source, 0, 0, srcWidth, srcHeight, 0, 0, resizedWidth, inputHeight);

  // 提取像素并归一化
  const imageData = resizeCtx.getImageData(0, 0, resizedWidth, inputHeight);
  const pixels = imageData.data;
  const pixelCount = resizedWidth * inputHeight;

  const floatData = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 4;
    const r = pixels[srcIdx];
    const g = pixels[srcIdx + 1];
    const b = pixels[srcIdx + 2];
    const first = channelOrder === 'bgr' ? b : r;
    const third = channelOrder === 'bgr' ? r : b;

    if (normalize === 'minus_one_to_one') {
      floatData[i] = first / 127.5 - 1;
      floatData[pixelCount + i] = g / 127.5 - 1;
      floatData[2 * pixelCount + i] = third / 127.5 - 1;
    } else {
      floatData[i] = first / 255;
      floatData[pixelCount + i] = g / 255;
      floatData[2 * pixelCount + i] = third / 255;
    }
  }

  return {
    data: floatData,
    dims: [1, 3, inputHeight, resizedWidth],
    resizedWidth,
  };
}

/** 留一点余量：贴边的字形再被 resize 一次就糊了 */
const OCR_CHUNK_ASPECT_MARGIN = 0.85;
/** 段数上限，防止又宽又扁的框切出上百段 */
const OCR_CHUNK_MAX_PARTS = 24;
/** 尾巴太短就并进上一段 */
const OCR_CHUNK_MIN_TAIL = 12;
/** 一行里"词的间隙"至少要有多少列没有墨（按行高的占比，字母之间的缝比词距窄得多） */
const OCR_CHUNK_WORD_GAP_RATIO = 0.12;

export type PaddleOcrChunkPlan = {
  rects: Rect[];
  /** 每段开头是否落在一个"词的间隙"上 —— 拼回整行时要补一个空格 */
  startsAtWordGap: boolean[];
};

/**
 * 把一行文字切成识别模型吃得下的若干段。
 *
 * 识别模型的输入是固定的 48×320（高×宽），buildPaddleOcrInput 会先把框按比例缩到
 * 高 48、**再把宽度截断到 320** —— 也就是说宽高比超过 320/48 ≈ 6.67 的行会被横向压扁。
 * 实测：一条 1885×50 的英文行整条送进去读出**空串**，切成 8 段送进去能完整读出
 * "-Please improve the overall colors of her outfit, especially the all gold color"。
 *
 * 所以宽的行先切段，每段单独识别，再按顺序拼回一整行（见 paddleocrProvider）。
 * 不需要切的（宽高比在模型能力内）原样返回单段，调用方行为不变。
 *
 * 传了 columnInk（该行每一列的墨像素数，下标是相对 box.x 的偏移）时，切点会挪到
 * 标称位置之前**空格游程最长的那一列**，也就是词与词之间。
 * 试过两种更简单的做法，都会毁掉结果：固定宽度切会切进字母里丢字；留一点重叠又把
 * 交界处的字母读两遍（"impprove"、"colorrs"）；只挑"墨最少的一列"则会落在字母缝里，
 * 拼回去时被当成词距补上空格（"im prove"、"col ors"）。所以必须区分词距和字母缝。
 */
export function planPaddleOcrChunks(
  box: Rect,
  inputHeight: number,
  maxInputWidth: number,
  columnInk?: Uint32Array,
): PaddleOcrChunkPlan {
  const height = Math.max(1, box.height);
  const aspectLimit = maxInputWidth / Math.max(1, inputHeight);
  let chunkWidth = Math.max(1, Math.floor(height * aspectLimit * OCR_CHUNK_ASPECT_MARGIN));
  if (box.width <= chunkWidth) return { rects: [box], startsAtWordGap: [false] };

  if (Math.ceil(box.width / chunkWidth) > OCR_CHUNK_MAX_PARTS) {
    chunkWidth = Math.max(chunkWidth, Math.ceil(box.width / OCR_CHUNK_MAX_PARTS));
  }

  const gapRuns = columnGapRuns(columnInk, Math.max(1, Math.round(height * 0.02)));
  const minWordGap = Math.max(3, Math.round(height * OCR_CHUNK_WORD_GAP_RATIO));

  const cuts: number[] = [0];
  while (box.width - cuts[cuts.length - 1] > chunkWidth) {
    const start = cuts[cuts.length - 1];
    const nominal = Math.min(box.width - 1, start + chunkWidth);
    const cut = pickCut(start, nominal, box.width, gapRuns);
    cuts.push(cut);
  }
  cuts.push(box.width);

  const rects: Rect[] = [];
  const startsAtWordGap: boolean[] = [];
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const start = cuts[index];
    let end = cuts[index + 1];
    // 尾巴太短就并进上一段（短尾巴单独识别基本是噪声）
    if (box.width - end < OCR_CHUNK_MIN_TAIL) end = box.width;
    rects.push({
      x: box.x + start,
      y: box.y,
      width: Math.max(1, end - start),
      height: box.height,
    });
    // 第一段前面没有内容，谈不上"补空格"
    startsAtWordGap.push(index > 0 && (gapRuns?.[start] ?? 0) >= minWordGap);
    if (end >= box.width) break;
  }
  return { rects, startsAtWordGap };
}

/**
 * 每一列所属的"空白游程"长度：连续多少列没有墨（有墨的列是 0）。
 * 词距会有十几列，字母之间的缝只有两三列，用游程长度就能把两者分开。
 */
function columnGapRuns(
  columnInk: Uint32Array | undefined,
  emptyThreshold: number,
): Uint16Array | undefined {
  if (!columnInk) return undefined;
  const runs = new Uint16Array(columnInk.length);
  let start = -1;
  for (let column = 0; column <= columnInk.length; column += 1) {
    const empty = column < columnInk.length && columnInk[column] <= emptyThreshold;
    if (empty) {
      if (start < 0) start = column;
      continue;
    }
    if (start >= 0) {
      const length = column - start;
      for (let fill = start; fill < column; fill += 1) runs[fill] = length;
      start = -1;
    }
  }
  return runs;
}

/**
 * 在 [start + 一半段宽, nominal] 里挑一列下刀：空白游程最长的列（词距），
 * 一样长时取离 nominal 最近的。没有游程信息就直接用 nominal。
 */
function pickCut(
  start: number,
  nominal: number,
  width: number,
  gapRuns: Uint16Array | undefined,
): number {
  if (!gapRuns) return nominal;
  const from = Math.max(start + 1, Math.floor((start + nominal) / 2));
  const to = Math.min(nominal, width - 1);
  let best = nominal;
  let bestRun = 0;
  for (let offset = to; offset >= from; offset -= 1) {
    const run = gapRuns[offset] ?? 0;
    if (run > bestRun) {
      bestRun = run;
      best = offset;
    }
  }
  return best;
}
