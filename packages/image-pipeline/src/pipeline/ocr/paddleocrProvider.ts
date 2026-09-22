import type { OcrProvider, OcrRecognizeOutput, OcrRecognizeResult } from './provider';
import type {
  OcrRunDebugChunk,
  OcrRunDebugInfo,
  PaddleOcrInferenceDebug,
  PaddleOcrRunDebug,
  TextRegion,
  QuadPoint,
} from '../../types';
import type { PlatformProvider, PipelineImage } from '../../runtime/platform';
import {
  serializeOnnxSessionOptions,
  type ModelDescriptor,
  type ModelRuntime,
  type ModelName,
  type OnnxSessionOptions,
  type RuntimeProvider,
  type TensorTransport,
  type WebNnDeviceType,
  type WorkerSessionHandle,
} from '@shinobu/model-runtime';
import { buildPaddleOcrInput, planPaddleOcrChunks } from './paddleocrPreprocess';
import type { PaddleOcrInputData } from './paddleocrPreprocess';
import { decodePaddleCtc } from './paddleocrDecode';
import type { PaddleCtcResult } from './paddleocrDecode';
import { loadCharset } from './ocrShared';
import type { Direction } from './preprocess';

const PADDLEOCR_CONFIDENCE_THRESHOLD = 0.2;
const PADDLEOCR_BATCH_BUCKET_WIDTH = 32;
const warmedPaddleSessionIds = new Set<string>();

type PaddleOcrModelName = Extract<ModelName, 'paddleocr_v6_medium_rec'>;

type PaddleOcrRuntimeFlags = typeof globalThis & {
  __shinobuPaddleOcrWidthBucketBatch?: boolean;
  __shinobuPaddleOcrProviders?: RuntimeProvider[];
  __shinobuPaddleOcrColdFirstSerial?: boolean;
  __shinobuPaddleOcrModelName?: PaddleOcrModelName;
  __shinobuPaddleOcrSessionOptions?: OnnxSessionOptions;
  __shinobuPaddleOcrFixedInputWidth?: number;
};

type PreparedPaddleRegion = {
  index: number;
  region: TextRegion;
  direction: Direction;
  inputData: PaddleOcrInputData;
  inputBytes: number;
  /** 这是该区域的第几段（宽行会被 planPaddleOcrChunks 切开；没切开就是 0） */
  partIndex: number;
};

type PaddleBatchDecodeOutput = {
  decoded: PaddleCtcResult[];
  timeSteps: number;
  numClasses: number;
};

type PreparedPaddleRuntime = {
  modelName: PaddleOcrModelName;
  model: ModelDescriptor;
  sessionHandle: WorkerSessionHandle;
  ctcCharset: string[];
  inputHeight: number;
  maxInputWidth: number;
  normalize: 'zero_to_one' | 'minus_one_to_one';
  channelOrder: 'rgb' | 'bgr';
  sessionOptions?: OnnxSessionOptions;
  timings: {
    modelLoadMs: number;
    sessionLoadMs: number;
    charsetLoadMs: number;
  };
};

export type PaddleOcrWarmupResult = {
  modelName: PaddleOcrModelName;
  provider: RuntimeProvider;
  webnnDeviceType?: WebNnDeviceType;
  inputDims: number[];
  outputDims?: number[];
  sessionLoadMs: number;
  charsetLoadMs: number;
  runMs: number;
  outputBytes: number;
};

function inferDirection(region: TextRegion): Direction {
  if (region.direction) return region.direction;
  return region.box.height > region.box.width ? 'v' : 'h';
}

function tensorByteLength(tensor: TensorTransport | undefined): number {
  return tensor?.data.byteLength ?? 0;
}

function shouldUsePaddleWidthBucketBatch(
  provider: PaddleOcrRunDebug['provider'],
  webnnDeviceType: PaddleOcrRunDebug['webnnDeviceType'],
): boolean {
  const configured = (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrWidthBucketBatch;
  if (configured !== undefined) {
    return configured;
  }
  return provider === 'webgpu' || provider === 'cuda' || (provider === 'webnn' && webnnDeviceType !== 'cpu');
}

function shouldUsePaddleColdFirstSerial(
  provider: PaddleOcrRunDebug['provider'],
  sessionId: string,
): boolean {
  const configured = (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrColdFirstSerial;
  if (configured !== undefined) {
    return configured;
  }
  return provider === 'webgpu' && !warmedPaddleSessionIds.has(sessionId);
}

function resolvePaddleOcrModelName(defaultModelName: PaddleOcrModelName): PaddleOcrModelName {
  const configured = (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrModelName;
  return configured === 'paddleocr_v6_medium_rec' ? configured : defaultModelName;
}

function resolvePaddleSessionOptions(): OnnxSessionOptions | undefined {
  const configured = (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrSessionOptions;
  if (!configured) {
    return undefined;
  }
  return {
    enableGraphCapture: configured.enableGraphCapture,
    preferredOutputLocation: configured.preferredOutputLocation,
    freeDimensionOverrides: configured.freeDimensionOverrides
      ? { ...configured.freeDimensionOverrides }
      : undefined,
  };
}

function resolvePaddleFixedInputWidth(maxInputWidth: number): number | undefined {
  const configured = (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrFixedInputWidth;
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return undefined;
  }
  return Math.max(1, Math.min(maxInputWidth, Math.round(configured)));
}

function resolvePaddleRuntimeProviders(modelRuntime: RuntimeProvider[] | undefined): RuntimeProvider[] {
  const configured = (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrProviders;
  if (configured && configured.length > 0) {
    return configured;
  }
  return modelRuntime ?? ['webgpu', 'webnn', 'wasm'];
}

export async function preparePaddleOcrRuntime(
  modelRuntime: ModelRuntime,
  defaultModelName: PaddleOcrModelName = 'paddleocr_v6_medium_rec',
): Promise<PreparedPaddleRuntime> {
  const modelName = resolvePaddleOcrModelName(defaultModelName);
  const modelT0 = performance.now();
  const model = await modelRuntime.readModel(modelName);
  const modelLoadMs = performance.now() - modelT0;
  const sessionOptions = resolvePaddleSessionOptions();
  const sessionT0 = performance.now();
  const sessionHandle = await modelRuntime.getSession(
    modelName,
    resolvePaddleRuntimeProviders(model.runtime),
    sessionOptions,
  );
  const sessionLoadMs = performance.now() - sessionT0;
  const charsetT0 = performance.now();
  const charset = await loadCharset(modelRuntime, model.dictUrl);
  const charsetLoadMs = performance.now() - charsetT0;
  if (!charset) {
    throw new Error('PaddleOCR 字典加载失败');
  }

  return {
    modelName,
    model,
    sessionHandle,
    ctcCharset: ['', ...charset, ' '],
    inputHeight: model.input[0],
    maxInputWidth: model.input[1],
    normalize: model.normalize ?? 'minus_one_to_one',
    channelOrder: model.channelOrder ?? 'rgb',
    sessionOptions,
    timings: {
      modelLoadMs,
      sessionLoadMs,
      charsetLoadMs,
    },
  };
}

export async function warmupPaddleOcrRuntime(options: {
  inputWidth?: number;
  batchSize?: number;
}, modelRuntime: ModelRuntime): Promise<PaddleOcrWarmupResult> {
  const runtime = await preparePaddleOcrRuntime(modelRuntime);
  const inputWidth = Math.max(1, Math.min(runtime.maxInputWidth, Math.round(options.inputWidth ?? runtime.maxInputWidth)));
  const batchSize = Math.max(1, Math.round(options.batchSize ?? 1));
  const imageInputName = runtime.sessionHandle.inputNames[0];
  const outputName = runtime.sessionHandle.outputNames[0];
  if (!imageInputName) {
    throw new Error('PaddleOCR 模型缺少输入名称');
  }
  const inputDims = [batchSize, 3, runtime.inputHeight, inputWidth];
  const inputData = new Float32Array(batchSize * 3 * runtime.inputHeight * inputWidth);
  const runT0 = performance.now();
  const inferenceResult = await modelRuntime.run(runtime.sessionHandle.sessionId, {
    [imageInputName]: {
      data: inputData,
      dims: inputDims,
      type: 'float32',
    },
  });
  const runMs = performance.now() - runT0;
  if (inferenceResult.error) {
    throw new Error(inferenceResult.error);
  }
  warmedPaddleSessionIds.add(runtime.sessionHandle.sessionId);
  const output = outputName ? inferenceResult.outputs[outputName] : Object.values(inferenceResult.outputs)[0];
  return {
    modelName: runtime.modelName,
    provider: runtime.sessionHandle.provider,
    webnnDeviceType: runtime.sessionHandle.webnnDeviceType,
    inputDims,
    outputDims: output ? [...output.dims] : undefined,
    sessionLoadMs: runtime.timings.sessionLoadMs,
    charsetLoadMs: runtime.timings.charsetLoadMs,
    runMs,
    outputBytes: tensorByteLength(output),
  };
}

function makeRegionQuad(region: TextRegion): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  return region.quad ?? [
    { x: region.box.x, y: region.box.y },
    { x: region.box.x + region.box.width, y: region.box.y },
    { x: region.box.x + region.box.width, y: region.box.y + region.box.height },
    { x: region.box.x, y: region.box.y + region.box.height },
  ];
}

/**
 * 行内每一列的墨像素数（下标 = 相对 box.x 的偏移），用来把切段位置挪到字的空隙里。
 * 阈值取这一小块灰度的 (最小+最大)/2：文字行基本是"纸 + 墨"两极，够用了。
 */
function regionColumnInk(
  image: PipelineImage,
  box: TextRegion['box'],
  platform: PlatformProvider,
): Uint32Array | undefined {
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  try {
    const canvas = platform.createCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(image, box.x, box.y, width, height, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let min = 255;
    let max = 0;
    const grays = new Uint8ClampedArray(width * height);
    for (let index = 0; index < grays.length; index += 1) {
      const pixel = index * 4;
      const gray = Math.round(
        pixels[pixel] * 0.299 + pixels[pixel + 1] * 0.587 + pixels[pixel + 2] * 0.114,
      );
      grays[index] = gray;
      if (gray < min) min = gray;
      if (gray > max) max = gray;
    }
    const threshold = (min + max) / 2;
    const ink = new Uint32Array(width);
    for (let row = 0; row < height; row += 1) {
      const rowStart = row * width;
      for (let column = 0; column < width; column += 1) {
        if (grays[rowStart + column] < threshold) ink[column] += 1;
      }
    }
    return ink;
  } catch {
    // 拿不到像素就退回固定宽度切段
    return undefined;
  }
}

/**
 * 拼接两段识别结果时要不要补空格：只在两边都是拉丁字母/数字（或紧邻数字的标点）时补，
 * 中文被切开时插空格是错的。
 */
function needsJoinSpace(left: string, right: string): boolean {
  if (/[\s，。、；：！？）】」』]$/u.test(left) || /^[\s，。、；：！？（【「『]/u.test(right)) {
    return false;
  }
  return /[A-Za-z0-9,.;:!?'")\]]$/.test(left) && /^[A-Za-z0-9("'[]/.test(right);
}

function resolvePaddleBucketWidth(resizedWidth: number, maxInputWidth: number): number {
  return Math.max(1,
    Math.min(maxInputWidth, Math.ceil(resizedWidth / PADDLEOCR_BATCH_BUCKET_WIDTH) * PADDLEOCR_BATCH_BUCKET_WIDTH),
  );
}

function packPaddleBatch(items: PreparedPaddleRegion[], inputHeight: number, width: number): Float32Array {
  const batchData = new Float32Array(items.length * 3 * inputHeight * width);
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const input = items[itemIndex].inputData;
    const srcWidth = input.resizedWidth;
    for (let channel = 0; channel < 3; channel += 1) {
      const srcChannelOffset = channel * inputHeight * srcWidth;
      const dstChannelOffset = itemIndex * 3 * inputHeight * width + channel * inputHeight * width;
      for (let y = 0; y < inputHeight; y += 1) {
        batchData.set(
          input.data.subarray(srcChannelOffset + y * srcWidth, srcChannelOffset + y * srcWidth + srcWidth),
          dstChannelOffset + y * width,
        );
      }
    }
  }
  return batchData;
}

function buildPaddleGroupInput(items: PreparedPaddleRegion[], inputHeight: number, width: number): Float32Array {
  if (items.length === 1 && items[0].inputData.resizedWidth === width) {
    return items[0].inputData.data;
  }
  return packPaddleBatch(items, inputHeight, width);
}

function decodePaddleBatchOutput(
  output: TensorTransport,
  batchSize: number,
  ctcCharset: string[],
): PaddleBatchDecodeOutput | null {
  const logitsData = output.data as Float32Array;
  const logitsDims = output.dims;
  if (logitsDims.length === 3) {
    const outputBatchSize = logitsDims[0];
    const timeSteps = logitsDims[1];
    const numClasses = logitsDims[2];
    if (outputBatchSize < batchSize) {
      return null;
    }
    const itemStride = timeSteps * numClasses;
    const decoded = Array.from({ length: batchSize }, (_, index) => {
      const logits = logitsData.subarray(index * itemStride, (index + 1) * itemStride);
      return decodePaddleCtc(logits, timeSteps, numClasses, ctcCharset);
    });
    return { decoded, timeSteps, numClasses };
  }
  if (logitsDims.length === 2 && batchSize === 1) {
    const timeSteps = logitsDims[0];
    const numClasses = logitsDims[1];
    return {
      decoded: [decodePaddleCtc(logitsData, timeSteps, numClasses, ctcCharset)],
      timeSteps,
      numClasses,
    };
  }
  return null;
}

function createPaddleDebugInfo(
  modelName: PaddleOcrModelName,
  inputHeight: number,
  maxInputWidth: number,
  normalize: 'zero_to_one' | 'minus_one_to_one',
  channelOrder: 'rgb' | 'bgr',
  timings: {
    modelLoadMs: number;
    sessionLoadMs: number;
    charsetLoadMs: number;
  },
  options: {
    fixedInputWidth?: number;
    sessionOptionsKey?: string;
  } = {},
): { debugInfo: OcrRunDebugInfo; paddleDebug: PaddleOcrRunDebug } {
  const paddleDebug: PaddleOcrRunDebug = {
    modelName,
    batchMode: 'serial',
    inputHeight,
    maxInputWidth,
    fixedInputWidth: options.fixedInputWidth,
    sessionOptionsKey: options.sessionOptionsKey,
    normalize,
    channelOrder,
    modelLoadMs: timings.modelLoadMs,
    sessionLoadMs: timings.sessionLoadMs,
    charsetLoadMs: timings.charsetLoadMs,
    preprocessTotalMs: 0,
    inferenceTotalMs: 0,
    decodeTotalMs: 0,
    inputBytesTotal: 0,
    outputBytesTotal: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    missingOutputCount: 0,
    regions: [],
    inferenceRuns: [],
  };
  const debugInfo: OcrRunDebugInfo = {
    mode: 'ctc',
    candidateCount: 0,
    preparedCount: 0,
    preprocessTotalMs: 0,
    preprocessPerRegionMs: [],
    chunkBatchSize: 1,
    chunks: [],
    colorDecodeMode: 'none',
    colorBatchSize: 0,
    colorSessionRunCount: 0,
    colorSessionRunTotalMs: 0,
    colorTotalMs: 0,
    colorFallbackRegions: [],
    fallbackTriggerCount: 0,
    totalSessionRunCount: 0,
    totalSessionRunMs: 0,
    paddle: paddleDebug,
  };
  return { debugInfo, paddleDebug };
}

function addPaddleChunk(
  debugInfo: OcrRunDebugInfo,
  runIndex: number,
  regionIds: string[],
  durationMs: number,
  acceptedCount: number,
): void {
  const chunk: OcrRunDebugChunk = {
    chunkIndex: runIndex,
    chunkSize: regionIds.length,
    regionIds,
    decodeMode: 'batch',
    decodeAccepted: acceptedCount,
    decodeSessionRunCount: 1,
    decodeSessionRunTotalMs: durationMs,
    decodeSteps: [{
      step: runIndex,
      activeCount: regionIds.length,
      batchSize: regionIds.length,
      durationMs,
    }],
    fallbackRegions: [],
  };
  debugInfo.chunks.push(chunk);
  debugInfo.totalSessionRunCount += 1;
  debugInfo.totalSessionRunMs += durationMs;
}

function createPaddleOcrProvider(name: string, modelName: PaddleOcrModelName): OcrProvider {
  return {
    name,
    async recognize(
      image: PipelineImage,
      regions: TextRegion[],
      platform?: PlatformProvider,
      modelRuntime?: ModelRuntime,
    ): Promise<OcrRecognizeOutput> {
      if (!platform) {
        throw new Error('PaddleOCR 需要可用的运行平台');
      }
      if (!modelRuntime) {
        throw new Error('PaddleOCR 需要 ModelRuntime');
      }
      const runtime = await preparePaddleOcrRuntime(modelRuntime, modelName);
      const {
        modelName: resolvedModelName,
        sessionHandle,
        ctcCharset,
        inputHeight,
        maxInputWidth,
        normalize,
        channelOrder,
        sessionOptions,
        timings,
      } = runtime;
      const requestedFixedInputWidth = resolvePaddleFixedInputWidth(maxInputWidth);
      const { debugInfo, paddleDebug } = createPaddleDebugInfo(
        resolvedModelName,
        inputHeight,
        maxInputWidth,
        normalize,
        channelOrder,
        timings,
        {
          fixedInputWidth: requestedFixedInputWidth,
          sessionOptionsKey: serializeOnnxSessionOptions(sessionOptions),
        },
      );
      debugInfo.candidateCount = regions.length;
      paddleDebug.provider = sessionHandle.provider;
      paddleDebug.webnnDeviceType = sessionHandle.webnnDeviceType;

      const imageInputName = sessionHandle.inputNames[0];
      const logitsOutputName = sessionHandle.outputNames[0];
      if (!imageInputName) {
        throw new Error('PaddleOCR 模型缺少输入名称');
      }
      if (!logitsOutputName) {
        throw new Error('PaddleOCR 模型缺少输出名称');
      }

      const preparedRegions: PreparedPaddleRegion[] = [];
      const resultsByIndex: Array<OcrRecognizeResult | null> = Array.from({ length: regions.length }, () => null);
      /** 切过段的区域：先按段号收着，识别完再拼回一整行 */
      const partResultsByIndex = new Map<number, Array<OcrRecognizeResult | undefined>>();
      /** 每段开头是不是落在字与字的空隙上（拼回去时决定要不要补空格） */
      const partGapByIndex = new Map<number, boolean[]>();
      const debugRegionById = new Map<string, PaddleOcrRunDebug['regions'][number]>();
      for (const [index, region] of regions.entries()) {
        const direction = inferDirection(region);
        // 识别模型输入宽只有 maxInputWidth，长行送进去会被横向压扁到读不出字（见 planPaddleOcrChunks）。
        // 竖排文字会被旋转后送进去，长度落在高上，不切。
        // 墨量用来把切段位置挪到词的间隙里；竖排不切，不用算。
        const boxesColumnInk = direction === 'h'
          ? regionColumnInk(image, region.box, platform)
          : undefined;
        const plan = direction === 'h'
          ? planPaddleOcrChunks(region.box, inputHeight, maxInputWidth, boxesColumnInk)
          : { rects: [region.box], startsAtWordGap: [false] };
        const boxes = plan.rects;
        if (boxes.length > 1) partGapByIndex.set(index, plan.startsAtWordGap);
        for (const [partIndex, box] of boxes.entries()) {
          // 切段时必须把 quad 一起换掉：裁图用的是 quad（getTransformedRegion），
          // 留着整行的 quad 会让每一段都裁出整行，拼回来就变成重复文字。
          const partRegion = boxes.length === 1
            ? region
            : {
                ...region,
                id: `${region.id}#${partIndex}`,
                box,
                quad: [
                  { x: box.x, y: box.y },
                  { x: box.x + box.width, y: box.y },
                  { x: box.x + box.width, y: box.y + box.height },
                  { x: box.x, y: box.y + box.height },
                ] as [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
              };
          const preprocessT0 = performance.now();
          const inputData = buildPaddleOcrInput(
            image,
            partRegion,
            direction,
            inputHeight,
            maxInputWidth,
            normalize,
            platform,
            channelOrder,
          );
          const preprocessMs = performance.now() - preprocessT0;
          const inputBytes = inputData.data.byteLength;
          debugInfo.preparedCount += 1;
          debugInfo.preprocessTotalMs += preprocessMs;
          debugInfo.preprocessPerRegionMs.push({ regionId: partRegion.id, durationMs: preprocessMs });
          paddleDebug.preprocessTotalMs += preprocessMs;
          const regionDebug: PaddleOcrRunDebug['regions'][number] = {
            regionId: partRegion.id,
            direction,
            box: { ...box },
            inputDims: [...inputData.dims],
            resizedWidth: inputData.resizedWidth,
            inputBytes,
            preprocessMs,
          };
          paddleDebug.regions.push(regionDebug);
          debugRegionById.set(partRegion.id, regionDebug);
          preparedRegions.push({ index, region: partRegion, direction, inputData, inputBytes, partIndex });
        }
      }

      const fixedInputWidth = requestedFixedInputWidth === undefined
        ? undefined
        : Math.max(requestedFixedInputWidth, ...preparedRegions.map((item) => item.inputData.resizedWidth));
      if (fixedInputWidth !== requestedFixedInputWidth) {
        paddleDebug.fixedInputWidth = fixedInputWidth;
      }

      let inferenceRunIndex = 0;
      const runPreparedGroup = async (
        group: PreparedPaddleRegion[],
        inputWidth: number,
        allowFallback: boolean,
      ): Promise<void> => {
        const currentRunIndex = inferenceRunIndex;
        inferenceRunIndex += 1;
        const regionIds = group.map((item) => item.region.id);
        const batchInput = buildPaddleGroupInput(group, inputHeight, inputWidth);
        const inputDims = [group.length, 3, inputHeight, inputWidth];
        const inputBytes = batchInput.byteLength;
        const runDebug: PaddleOcrInferenceDebug = {
          runIndex: currentRunIndex,
          regionIds,
          inputDims,
          inputBytes,
          outputBytes: 0,
          durationMs: 0,
          decodeMs: 0,
          accepted: false,
          acceptedCount: 0,
          rejectedCount: 0,
        };

        const feeds: Record<string, TensorTransport> = {
          [imageInputName]: {
            data: batchInput,
            dims: inputDims,
            type: 'float32' as const,
          },
        };

        const inferenceT0 = performance.now();
        let inferenceResult: Awaited<ReturnType<ModelRuntime['run']>>;
        try {
          inferenceResult = await modelRuntime.run(sessionHandle.sessionId, feeds);
        } catch (error) {
          const inferenceMs = performance.now() - inferenceT0;
          runDebug.durationMs = inferenceMs;
          runDebug.error = error instanceof Error ? error.message : String(error);
          paddleDebug.inferenceTotalMs += inferenceMs;
          paddleDebug.inputBytesTotal += inputBytes;
          paddleDebug.inferenceRuns.push(runDebug);
          addPaddleChunk(debugInfo, currentRunIndex, regionIds, inferenceMs, 0);
          if (allowFallback && group.length > 1) {
            for (const item of group) {
              await runPreparedGroup([item], item.inputData.resizedWidth, false);
            }
            return;
          }
          throw error;
        }
        const inferenceMs = performance.now() - inferenceT0;
        runDebug.durationMs = inferenceMs;
        paddleDebug.inferenceTotalMs += inferenceMs;
        paddleDebug.inputBytesTotal += inputBytes;
        if (inferenceResult.error) {
          runDebug.error = inferenceResult.error;
          paddleDebug.inferenceRuns.push(runDebug);
          addPaddleChunk(debugInfo, currentRunIndex, regionIds, inferenceMs, 0);
          if (allowFallback && group.length > 1) {
            for (const item of group) {
              await runPreparedGroup([item], item.inputData.resizedWidth, false);
            }
            return;
          }
          throw new Error(inferenceResult.error);
        }

        const logitsOutput = inferenceResult.outputs[logitsOutputName];
        if (!logitsOutput) {
          paddleDebug.missingOutputCount += group.length;
          runDebug.error = '模型未返回 logits 输出';
          paddleDebug.inferenceRuns.push(runDebug);
          addPaddleChunk(debugInfo, currentRunIndex, regionIds, inferenceMs, 0);
          if (allowFallback && group.length > 1) {
            for (const item of group) {
              await runPreparedGroup([item], item.inputData.resizedWidth, false);
            }
            return;
          }
          throw new Error(runDebug.error);
        }

        const logitsDims = logitsOutput.dims;
        const outputBytes = tensorByteLength(logitsOutput);
        paddleDebug.outputBytesTotal += outputBytes;
        runDebug.outputBytes = outputBytes;
        runDebug.outputDims = [...logitsDims];
        const decodeT0 = performance.now();
        const decodedOutput = decodePaddleBatchOutput(logitsOutput, group.length, ctcCharset);
        const decodeMs = performance.now() - decodeT0;
        runDebug.decodeMs = decodeMs;
        paddleDebug.decodeTotalMs += decodeMs;
        if (!decodedOutput) {
          runDebug.error = `不支持的 logits 维度: ${logitsDims.join('x')}`;
          paddleDebug.inferenceRuns.push(runDebug);
          addPaddleChunk(debugInfo, currentRunIndex, regionIds, inferenceMs, 0);
          if (allowFallback && group.length > 1) {
            for (const item of group) {
              await runPreparedGroup([item], item.inputData.resizedWidth, false);
            }
            return;
          }
          throw new Error(runDebug.error);
        }

        let acceptedCount = 0;
        let rejectedCount = 0;
        const texts: string[] = [];
        for (let itemIndex = 0; itemIndex < group.length; itemIndex += 1) {
          const item = group[itemIndex];
          const decoded = decodedOutput.decoded[itemIndex];
          // 笔画补检的单/双字符更容易来自插画纹理；保留有足够把握的短标签。
          const shortStrokeCandidate = item.region.minOcrConfidence !== undefined
            && Array.from(decoded.text.replace(/\s/gu, '')).length <= 2;
          const accepted = (
            decoded.confidence >= Math.max(PADDLEOCR_CONFIDENCE_THRESHOLD,
              item.region.minOcrConfidence ?? 0, shortStrokeCandidate ? 0.85 : 0)
            && decoded.text.trim() !== ''
          );
          const regionDebug = debugRegionById.get(item.region.id);
          if (regionDebug) {
            regionDebug.decodedText = decoded.text;
            regionDebug.confidence = decoded.confidence;
            regionDebug.accepted = accepted;
          }
          texts.push(decoded.text);
          if (!accepted) {
            rejectedCount += 1;
            continue;
          }
          acceptedCount += 1;
          const parts = partResultsByIndex.get(item.index) ?? [];
          parts[item.partIndex] = {
            regionId: item.region.id,
            text: decoded.text,
            confidence: decoded.confidence,
            quad: makeRegionQuad(item.region),
          };
          partResultsByIndex.set(item.index, parts);
        }
        paddleDebug.acceptedCount += acceptedCount;
        paddleDebug.rejectedCount += rejectedCount;
        runDebug.accepted = acceptedCount > 0;
        runDebug.acceptedCount = acceptedCount;
        runDebug.rejectedCount = rejectedCount;
        runDebug.timeSteps = decodedOutput.timeSteps;
        runDebug.numClasses = decodedOutput.numClasses;
        runDebug.texts = texts;
        if (group.length === 1) {
          const decoded = decodedOutput.decoded[0];
          runDebug.text = decoded.text;
          runDebug.confidence = decoded.confidence;
        }
        paddleDebug.inferenceRuns.push(runDebug);
        addPaddleChunk(debugInfo, currentRunIndex, regionIds, inferenceMs, acceptedCount);
      };

      const useWidthBucketBatch = shouldUsePaddleWidthBucketBatch(sessionHandle.provider, sessionHandle.webnnDeviceType);
      paddleDebug.batchMode = useWidthBucketBatch ? 'width-bucket' : 'serial';
      if (useWidthBucketBatch) {
        paddleDebug.batchBucketWidth = PADDLEOCR_BATCH_BUCKET_WIDTH;
        const useColdFirstSerial = preparedRegions.length > 1
          && shouldUsePaddleColdFirstSerial(sessionHandle.provider, sessionHandle.sessionId);
        paddleDebug.coldFirstSerial = useColdFirstSerial;
        let bucketCandidates = preparedRegions;
        if (useColdFirstSerial) {
          warmedPaddleSessionIds.add(sessionHandle.sessionId);
          const [firstRegion, ...remainingRegions] = preparedRegions;
          await runPreparedGroup([firstRegion], fixedInputWidth ?? firstRegion.inputData.resizedWidth, false);
          bucketCandidates = remainingRegions;
        }
        const groups = new Map<number, PreparedPaddleRegion[]>();
        for (const item of bucketCandidates) {
          const bucketWidth = fixedInputWidth ?? resolvePaddleBucketWidth(item.inputData.resizedWidth, maxInputWidth);
          const group = groups.get(bucketWidth);
          if (group) {
            group.push(item);
          } else {
            groups.set(bucketWidth, [item]);
          }
        }
        debugInfo.chunkBatchSize = Math.max(1, ...Array.from(groups.values(), (group) => group.length));
        for (const [bucketWidth, group] of groups) {
          await runPreparedGroup(group, bucketWidth, true);
        }
      } else {
        warmedPaddleSessionIds.add(sessionHandle.sessionId);
        for (const item of preparedRegions) {
          await runPreparedGroup([item], fixedInputWidth ?? item.inputData.resizedWidth, false);
        }
      }

      warmedPaddleSessionIds.add(sessionHandle.sessionId);
      // 切过段的行：各段文字按顺序拼回一整行。
      // 切点落在字间空隙上时要补回那个空格（识别结果不会带着段首/段尾的空格），
      // 但只对拉丁文补 —— 中文被切开时插空格是错的。
      for (const [index, parts] of partResultsByIndex) {
        const parent = regions[index];
        const gapFlags = partGapByIndex.get(index) ?? [];
        let text = '';
        let joined = 0;
        let confidence = Number.POSITIVE_INFINITY;
        for (const [partIndex, part] of parts.entries()) {
          if (!part) continue;
          if (joined > 0 && gapFlags[partIndex] !== false && needsJoinSpace(text, part.text)) {
            text += ' ';
          }
          text += part.text;
          joined += 1;
          confidence = Math.min(confidence, part.confidence);
        }
        if (joined === 0) continue;
        resultsByIndex[index] = {
          regionId: parent.id,
          text,
          confidence,
          quad: makeRegionQuad(parent),
        };
      }
      const results = resultsByIndex.filter((result): result is OcrRecognizeResult => result !== null);
      return { results, provider: sessionHandle.provider, webnnDeviceType: sessionHandle.webnnDeviceType, debug: debugInfo };
    },
  };
}

export const paddleocrV6MediumProvider = createPaddleOcrProvider('paddleocr_v6_medium', 'paddleocr_v6_medium_rec');
