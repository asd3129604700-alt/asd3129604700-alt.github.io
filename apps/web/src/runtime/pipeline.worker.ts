import {
  detectByTesseract,
} from '@shinobu/image-pipeline/benchmark';
import {
  attachWorkerTranslatorHost,
  type WorkerHostEndpoint,
} from '@shinobu/browser-runtime';
import {
  ImagePipelineCancelledError,
  ImagePipelineExecutionError,
  createImagePipeline,
  type ImagePipeline,
  type NormalizedWorkingCopySpec,
  type PipelinePlatform,
  type PipelineProgress,
} from '@shinobu/image-pipeline';
import {
  serializePipelineError,
} from '@shinobu/image-pipeline/protocol';
import {
  createDirectTextTranslationTransport,
  createTextTranslator,
} from '@shinobu/text-translation';
import type { ModelRuntime } from '@shinobu/model-runtime';
import { createBrowserModelRuntime } from '@shinobu/model-runtime/browser';
import onnxWorkerScriptUrl from '@shinobu/model-runtime/worker?worker&url';
import {
  createNormalizedWorkingFile,
  createOffscreenPlatform,
} from './offscreenPlatform';
import { createInstalledModelAssetSource } from './installedModelSource';
import type {
  WebPipelineInput,
  WebPipelineResult,
  WebWorkerPipelineConfig,
} from './webPipeline';
import { installTrustedTypesPolicy } from './trustedTypes';
import { createHybridTextTranslator } from './hybridTextTranslator';
import { requestLocalTranslation } from './localTranslationBridge';

installTrustedTypesPolicy();
const basePlatform = createOffscreenPlatform();
const platform: PipelinePlatform = {
  ...basePlatform,
  async prepareSource(source, workingCopy) {
    if (workingCopy.strategy !== 'normalized') {
      throw new Error('Web Worker 只接受 normalized 工作副本');
    }
    const file = source instanceof File
      ? source
      : new File([source], 'source-image', { type: source.type });
    return createNormalizedWorkingFile(file, workingCopy.size);
  },
};
const modelSourceResource = createInstalledModelAssetSource();
let installedModelSource: Awaited<typeof modelSourceResource> | null = null;
const concreteModelRuntime = modelSourceResource.then((installed) => {
  installedModelSource = installed;
  return createBrowserModelRuntime({
    workerUrl: onnxWorkerScriptUrl,
    ortPath: '/ort/',
    modelSource: installed.source,
    workerPolicy: 'direct-then-blob',
  });
});
const modelRuntime: ModelRuntime = {
  async readModel(name) {
    return (await concreteModelRuntime).readModel(name);
  },
  async getSession(name, preferred, options) {
    return (await concreteModelRuntime).getSession(name, preferred, options);
  },
  async run(sessionId, feeds) {
    return (await concreteModelRuntime).run(sessionId, feeds);
  },
  async runImage(sessionId, image) {
    return (await concreteModelRuntime).runImage(sessionId, image);
  },
  async readTextResource(url) {
    return (await concreteModelRuntime).readTextResource(url);
  },
  async releaseSession(name) {
    return (await concreteModelRuntime).releaseSession(name);
  },
  async dispose() {
    await (await concreteModelRuntime).dispose();
    installedModelSource?.dispose();
    installedModelSource = null;
  },
};
let runtime: ImagePipeline | null = null;

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
    && error.name === 'AbortError'
  ) || Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'TASK_CANCELLED'
  );
}

function normalizeWorkingCopy(
  input: WebPipelineInput,
): NormalizedWorkingCopySpec {
  if ('strategy' in input.workingCopy) return input.workingCopy;
  return {
    strategy: 'normalized',
    sourceSize: {
      width: input.workingCopy.width,
      height: input.workingCopy.height,
    },
    size: {
      width: input.workingCopy.width,
      height: input.workingCopy.height,
    },
    imageOrientation: 'from-image',
    background: '#ffffff',
  };
}

function runtimeFor(): ImagePipeline {
  if (!runtime) {
    runtime = createImagePipeline({
      platform,
      modelRuntime,
      detectionFallbackStrategy: {
        kind: 'tesseract-then-heuristic',
        detectWithTesseract: detectByTesseract,
      },
      fontSource: (path) => `/${path}`,
    });
  }
  return runtime;
}

attachWorkerTranslatorHost<
  WebPipelineInput,
  WebWorkerPipelineConfig,
  PipelineProgress,
  WebPipelineResult
>({
  endpoint: globalThis as unknown as WorkerHostEndpoint,
  async execute({ input, config }, { signal, reportProgress }) {
    const imageRuntime = runtimeFor();
    const translationTransport = createDirectTextTranslationTransport({
      apiKey: () => config.capabilities.textTranslation.apiKey,
      maxRetries: 0,
    });
    const task = imageRuntime.run({
      source: input.file,
      config: config.pipeline,
      workingCopy: normalizeWorkingCopy(input),
    }, {
      textTranslator: createHybridTextTranslator(createTextTranslator({
        transport: translationTransport,
      }), (text, target, localSignal) => requestLocalTranslation(
        globalThis as unknown as WorkerHostEndpoint, text, target, localSignal)),
      // 小字/短词补检：检测器输入写死 1024×1024，一张 2550px 的图被缩到 0.40 倍，
      // 短词只剩几个像素 → 直接被它的两道门槛（轮廓分数、短边）丢掉，
      // 表现就是"复杂的英文认得、简单的反而认不出"。
      // 这里按**原始分辨率**分块再检测一遍，把漏掉的补回来（详见 detect/smallTextDetect.ts）。
      // 实测：批注页 6→10 个区域，5100×3300 图纸 9→77 行；代价每页多两三秒。
      smallTextEnhance: { documentMode: true },
    });
    const stopProgress = task.progress(reportProgress);
    const cancel = (): void => {
      const reason = signal.reason instanceof ImagePipelineCancelledError
        ? signal.reason.reason
        : signal.reason
          && typeof signal.reason === 'object'
          && 'reason' in signal.reason
          && signal.reason.reason
          && typeof signal.reason.reason === 'object'
          && 'code' in signal.reason.reason
          && 'messageKey' in signal.reason.reason
            ? signal.reason.reason
            : {
                code: 'unknown',
                messageKey: 'pipeline.cancelled.unknown',
                diagnosticSummary: signal.reason instanceof Error
                  ? signal.reason.message
                  : String(signal.reason ?? ''),
              };
      task.cancel(reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const result = await task.result;
      const summary = result.diagnostics?.summary;
      return {
        ...result,
        summary: summary as WebPipelineResult['summary'],
      };
    } finally {
      signal.removeEventListener('abort', cancel);
      stopProgress();
      await imageRuntime.whenIdle();
    }
  },
  serializeError(error) {
    if (error instanceof ImagePipelineExecutionError) {
      return {
        name: error.name,
        message: error.message,
        code: error.failure.code,
        stage: error.failure.stage,
        scope: error.failure.scope,
        retryable: error.failure.retryable,
        messageKey: error.failure.messageKey,
        diagnostics: error.failure.diagnostics,
      };
    }
    return serializePipelineError(
      error,
      isAbortError(error) ? 'TASK_CANCELLED' : 'PIPELINE_STAGE_FAILED',
    );
  },
  async dispose(reason) {
    if (!runtime) return;
    const cancellation = (
      reason
      && typeof reason === 'object'
      && 'code' in reason
      && 'messageKey' in reason
    ) ? reason : {
      code: 'runtime-disposed',
      messageKey: 'pipeline.cancelled.runtimeDisposed',
      diagnosticSummary: reason instanceof Error
        ? reason.message
        : typeof reason === 'string' && reason
          ? reason
          : undefined,
    };
    await runtime.dispose(cancellation);
    runtime = null;
  },
});
