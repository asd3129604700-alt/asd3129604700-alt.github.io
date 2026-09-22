import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import {
  WEB_SETTINGS_STORAGE_KEY,
  decodeWebSettings,
  defaultWebProviderProfiles,
  encodeWebSettings,
  normalizeProviderTargetBinding,
  providerModelOptions,
  translationProviderOptions,
  type ProcessMode,
  type TargetLanguage,
  type TranslationProviderId,
  type UiLocale,
  type WebSettings,
} from '@shinobu/shared-config';
import brandIconUrl from '../../../public/icons/icon128.png';
import brandWordmarkUrl from '../../../public/brand/shinobu-wordmark.svg';
import { Icon, type IconName } from './icons';
import { localTranslationAvailability, prepareLocalTranslation, type LocalAvailability } from './runtime/localTranslation';
import { isGitHubPagesBuild, selectLocalModels, upstreamModelRelease } from './runtime/localModelImport';
import { describeImportRejection, getCopy } from './i18n';
import { HistoryView } from './features/history/HistoryView';
import { SettingsView } from './features/settings/SettingsView';
import { ContinuousCamera } from './features/camera/ContinuousCamera';
import { decodeBrowserImage } from './features/import/browserImageDecoder';
import { expandPdfToImageFiles, isPdfFile } from './features/import/pdfImporter';
import {
  addPatchRecord,
  composePatchOntoResult,
  cropRegionForPatch,
  selectionToWorkingRect,
  resultBlobForPatch,
  loadMergedResult,
  mergedStorageKey,
  patchFileName,
  readPatchRecords,
  saveMergedResult,
  type PatchRecord,
  type PatchRect,
} from './features/patch/regionPatch';
import {
  createImageImporter,
  imageImportLimitsForDevice,
} from './features/import/imageImporter';
import { useProviderSecrets } from './features/providers/useProviderSecrets';
import { fetchProviderModels } from './features/providers/modelCatalog';
import {
  type QueueJobStatus,
  type WebWorkbenchHistoryAction,
  type WebWorkbenchHistoryRejectionCode,
} from './features/workbench/webWorkbench';
import { createBrowserWorkbenchDiagnostics } from './features/workbench/browserWorkbenchDiagnostics';
import { createBrowserWebWorkbench } from './features/workbench/browserWebWorkbench';
import { useWebWorkbench } from './features/workbench/useWebWorkbench';
import {
  formatByteSize as formatBytes,
  type WebStorageSnapshot,
} from './features/storage/storageBudget';
import { usePwaLifecycle } from './pwa/usePwaLifecycle';
import { usePwaInstall } from './pwa/usePwaInstall';
import { WEB_MODEL_PACKAGE } from './runtime/modelPackage';
import { detectWebDeviceProfile } from './runtime/deviceProfile';

type MobilePane = 'queue' | 'preview' | 'settings';
type PreviewMode = 'original' | 'result' | 'merged';
/** 模型下拉里 自定义 那一项的值 */
const CUSTOM_MODEL_VALUE = '__custom__';
type PreviewScale = 'fit' | number;
type ActiveView = 'workbench' | 'history' | 'settings';
const processModes: ReadonlyArray<ProcessMode> = ['translate', 'original', 'erase'];
const previewZoomSteps = [0.5, 0.75, 1, 1.25, 1.5, 2];
const LOCAL_HISTORY_VERSIONS = {
  app: '0.1.0',
  core: '0.8.1',
  model: WEB_MODEL_PACKAGE.version,
  configSchema: 1,
} as const;

function readInitialSettings(): WebSettings {
  let serialized: string | null = null;
  try {
    serialized = localStorage.getItem(WEB_SETTINGS_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private or constrained contexts.
  }
  return decodeWebSettings(serialized, navigator.language).settings;
}

function historyRejectionMessage(
  code: WebWorkbenchHistoryRejectionCode,
  locale: UiLocale,
): string {
  const traditional = locale === 'zh-TW';
  const messages: Record<WebWorkbenchHistoryRejectionCode, [string, string]> = {
    'workbench-occupied': ['当前工作台已有草稿或活动批次', '目前工作台已有草稿或活動批次'],
    'batch-occupied': ['此处理批次正在另一个工作台中使用', '此處理批次正在另一個工作台中使用'],
    'partial-history': ['此本地历史部分损坏，无法执行该操作', '此本機歷史部分損壞，無法執行該操作'],
    'results-only': ['此记录只保留结果，不能恢复或克隆', '此記錄只保留結果，不能恢復或複製'],
    'no-results': ['此处理批次没有可导出的结果', '此處理批次沒有可匯出的結果'],
    'nothing-to-resume': ['此处理批次没有等待恢复的图片任务', '此處理批次沒有等待恢復的圖片任務'],
    'provider-unavailable': ['原处理批次的供应商当前不可用', '原處理批次的供應商目前不可用'],
    'result-unavailable': ['结果文件缺失或损坏', '結果檔案遺失或損壞'],
    'recovery-not-prepared': ['处理批次恢复准备已失效', '處理批次恢復準備已失效'],
    'pending-operation': ['已有一项等待撤销的历史操作', '已有一項等待復原的歷史操作'],
    'coordination-unavailable': ['当前浏览器无法安全协调多个工作台', '目前瀏覽器無法安全協調多個工作台'],
    'batch-not-found': ['找不到本地历史批次', '找不到本機歷史批次'],
  };
  return messages[code][traditional ? 1 : 0];
}

// PDF 在进入导入器之前就被展开成"每页一张 PNG"，下游（导入器、流水线、历史）
// 完全不知道 PDF 的存在，不需要为它改任何既有逻辑。
async function expandPdfFiles(files: readonly File[]): Promise<File[]> {
  const expanded: File[] = [];
  for (const file of files) {
    if (!isPdfFile(file)) {
      expanded.push(file);
      continue;
    }
    try {
      const { files: pages, notes } = await expandPdfToImageFiles(file);
      notes.forEach((note) => console.warn(note));
      if (pages.length === 0) console.warn(`${file.name}：没有可渲染的页面`);
      expanded.push(...pages);
    } catch (error) {
      console.error(`PDF 解析失败：${file.name}`, error);
    }
  }
  return expanded;
}

export function App() {
  const initialSettingsRef = useRef<WebSettings>(readInitialSettings());
  const [activeView, setActiveView] = useState<ActiveView>('workbench');
  const [dragging, setDragging] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>('preview');
  const [previewMode, setPreviewMode] = useState<PreviewMode>('original');
  const [previewScale, setPreviewScale] = useState<PreviewScale>('fit');
  const [providerDetailsOpen, setProviderDetailsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const [modelImportError, setModelImportError] = useState('');
  const dragDepthRef = useRef(0);
  const pwa = usePwaLifecycle();
  const pwaInstall = usePwaInstall();
  const deviceProfile = useMemo(() => detectWebDeviceProfile(), []);
  const diagnosticLifecycleRef = useRef({
    online: pwa.online,
    offlineReady: pwa.offlineReady,
    updateReady: pwa.updateReady,
    visibilityState: document.visibilityState,
  });
  diagnosticLifecycleRef.current = {
    online: pwa.online,
    offlineReady: pwa.offlineReady,
    updateReady: pwa.updateReady,
    visibilityState: document.visibilityState,
  };
  const diagnostics = useMemo(() => createBrowserWorkbenchDiagnostics({
    versions: LOCAL_HISTORY_VERSIONS,
    device: deviceProfile,
    lifecycle: () => diagnosticLifecycleRef.current,
  }), [deviceProfile]);
  const importerRef = useRef<ReturnType<typeof createImageImporter>>();
  if (!importerRef.current) {
    importerRef.current = createImageImporter({
      decodeImage: decodeBrowserImage,
      limits: imageImportLimitsForDevice(
        deviceProfile.mobile,
        deviceProfile.initialWorkPixelBudget,
      ),
    });
  }
  const settingsChangedRef = useRef<(next: WebSettings, previous: WebSettings) => void>(
    () => undefined,
  );
  const processingCompletedRef = useRef<() => void>(() => undefined);
  const credentialValuesRef = useRef<Partial<Record<TranslationProviderId, string>>>({});
  const credentialListenersRef = useRef(new Set<() => void>());
  const credentials = useMemo(() => ({
    status(settings: WebSettings) {
      const providerId = settings.translationProviderId;
      return {
        providerId,
        target: settings.providerProfiles[providerId].baseUrl,
        available: Boolean(credentialValuesRef.current[providerId]?.trim()),
      };
    },
    resolve(settings: WebSettings) {
      const providerId = settings.translationProviderId;
      return {
        providerId,
        target: settings.providerProfiles[providerId].baseUrl,
        value: credentialValuesRef.current[providerId] ?? '',
      };
    },
    subscribe(listener: () => void) {
      credentialListenersRef.current.add(listener);
      return () => credentialListenersRef.current.delete(listener);
    },
  }), []);

  const workbench = useMemo(() => createBrowserWebWorkbench({
    initialSettings: initialSettingsRef.current,
    importer: () => importerRef.current!,
    credentials,
    diagnostics,
    versions: LOCAL_HISTORY_VERSIONS,
    onSettingsChanged: (next, previous) => settingsChangedRef.current(next, previous),
    onProcessingCompleted: () => processingCompletedRef.current(),
  }), [credentials, diagnostics]);
  const workbenchSnapshot = useWebWorkbench(workbench);
  const {
    settings,
    images: queue,
    selectedImageId: selectedId,
    selectedPreviewUrl,
    jobs,
    itemActions,
    importing,
    rejections,
    notice: batchNotice,
    storageImportError,
    processing,
    runtime: runtimeView,
    provider: providerView,
    controls,
    primaryAction,
    diagnostics: diagnosticState,
    historyAction,
    camera: {
      open: continuousCameraOpen,
      round: continuousCameraRound,
      entry: cameraEntry,
    },
  } = workbenchSnapshot;
  const capability = runtimeView.capability ?? null;
  const [localAvailability, setLocalAvailability] = useState<LocalAvailability>('unavailable');
  const [localPreparing, setLocalPreparing] = useState(false);
  const [localMessage, setLocalMessage] = useState('');
  const localPrepareController = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    setLocalMessage('');
    setLocalAvailability('unavailable');
    void localTranslationAvailability(settings.targetLanguage).then(value => { if (active) setLocalAvailability(value); });
    return () => { active = false; };
  }, [settings.targetLanguage, settings.translationMode]);
  const prepareLocal = async (): Promise<void> => {
    const controller = new AbortController(); localPrepareController.current = controller;
    setLocalPreparing(true); setLocalMessage('正在准备本地翻译语言包…');
    try {
      await prepareLocalTranslation(settings.targetLanguage, progress => setLocalMessage(`正在下载语言包：${Math.round(progress * 100)}%`), controller.signal);
      setLocalAvailability('available'); setLocalMessage('本地翻译已就绪，文字不会发送给翻译服务商。');
    } catch (error) { setLocalMessage(controller.signal.aborted ? '已取消准备，可重试或选择其他翻译方式。' : error instanceof Error ? error.message : String(error)); }
    finally { localPrepareController.current = null; setLocalPreparing(false); }
  };
  const localBlocked = settings.processMode === 'translate' && settings.translationMode === 'local'
    && (localAvailability !== 'available' || localPreparing);
  const modelPackageState = runtimeView.modelPackage;
  const modelRuntimeProbe = runtimeView.modelProbe;
  const modelConsent = runtimeView.modelConsent;
  const storageChecking = runtimeView.storage.status === 'checking';
  const storageSnapshot: WebStorageSnapshot | null =
    runtimeView.storage.status === 'checking'
      ? null
      : runtimeView.storage;
  const imageImportLimits = useMemo(
    () => imageImportLimitsForDevice(
      deviceProfile.mobile,
      capability?.workPixelBudget ?? deviceProfile.initialWorkPixelBudget,
    ),
    [capability?.workPixelBudget, deviceProfile],
  );
  const importer = useMemo(
    () => createImageImporter({
      decodeImage: decodeBrowserImage,
      limits: imageImportLimits,
    }),
    [imageImportLimits],
  );
  importerRef.current = importer;
  const refreshStorage = useCallback(async (): Promise<WebStorageSnapshot> => {
    await workbench.dispatch({ type: 'refresh-storage' });
    const storage = workbench.snapshot().runtime.storage;
    if (storage.status === 'checking') {
      throw new Error('浏览器存储状态仍在检查');
    }
    return storage;
  }, [workbench]);
  const batchRunning = processing.status === 'running';
  const recoveryActive = workbenchSnapshot.phase === 'recovery';
  const processingSettingsEditable = controls.editProcessingSettings.status === 'available';
  const historySnapshot = workbenchSnapshot.history;
  const providerSecrets = useProviderSecrets(settings.providerProfiles);
  for (const provider of translationProviderOptions) {
    credentialValuesRef.current[provider.id] = providerSecrets.entries[provider.id].value;
  }
  useEffect(() => {
    for (const listener of credentialListenersRef.current) listener();
  }, [providerSecrets.entries]);
  settingsChangedRef.current = (nextSettings, previousSettings) => {
    const providerId = nextSettings.translationProviderId;
    let changed = true;
    try {
      changed = normalizeProviderTargetBinding(
        nextSettings.providerProfiles[providerId].baseUrl,
      ) !== normalizeProviderTargetBinding(
        previousSettings.providerProfiles[providerId].baseUrl,
      );
    } catch {
      // Invalid legacy targets must never retain a current provider secret.
    }
    if (changed) {
      credentialValuesRef.current[providerId] = '';
      providerSecrets.invalidateTarget(providerId);
    }
  };
  processingCompletedRef.current = () => {
    pwaInstall.offerAfterSuccess();
  };

  const copy = getCopy(settings.uiLocale);
  const historyCleanupFaultMessage = historySnapshot.cleanup.faultCount > 0
    ? settings.uiLocale === 'zh-TW'
      ? `${historySnapshot.cleanup.faultCount} 項本機資源仍待清理，尚未釋放 `
        + `${formatBytes(historySnapshot.cleanup.unreleasedBytes)}`
      : `${historySnapshot.cleanup.faultCount} 项本地资源仍待清理，尚未释放 `
        + `${formatBytes(historySnapshot.cleanup.unreleasedBytes)}`
    : undefined;
  const selectedImage = queue.find((image) => image.id === selectedId) ?? null;
  const selectedJob = selectedId ? jobs[selectedId] : undefined;
  const activeProviderProfile = settings.providerProfiles[settings.translationProviderId];
  const providerModelChoices = useMemo(
    () => providerModelOptions(settings.translationProviderId),
    [settings.translationProviderId],
  );
  /**
   * 模型选择框的形态：
   *  · 目录里有候选、且当前值就在候选里 → 用下拉（选项一眼可见，不用猜怎么选）
   *  · 目录外的值（手打过的）或提供商没有候选（OpenAI 兼容）→ 退回输入框
   *  · 用户主动选了「自定义…」→ 退回输入框
   */
  const [modelCustom, setModelCustom] = useState(false);
  /** 拉取回来的真实可用模型（按提供商+Base URL 缓存，切走就清掉） */
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [modelFetching, setModelFetching] = useState(false);
  const [modelFetchMessage, setModelFetchMessage] = useState('');
  const activeProviderSecret = providerSecrets.entries[settings.translationProviderId];
  const providerConfigurationError = providerView.configuration.status === 'blocked'
    ? providerView.configuration.reason === 'MODEL_MISSING'
      ? `${copy.model}不能为空`
      : providerView.configuration.reason === 'CREDENTIAL_MISSING'
        ? `${copy.apiKey}不能为空`
        : providerView.configuration.reason === 'CREDENTIAL_TARGET_MISMATCH'
          ? copy.startUnavailable
          : providerView.configuration.detail ?? copy.startUnavailable
    : null;
  const providerReady = providerView.configuration.status === 'available';
  // 拉取过就用真实列表，否则用项目里写死的目录候选
  const effectiveModelChoices = fetchedModels.length > 0 ? fetchedModels : providerModelChoices;
  const modelInCatalog = effectiveModelChoices.includes(activeProviderProfile.model);
  const showModelSelect = !modelCustom && modelInCatalog && effectiveModelChoices.length > 0;

  // 换提供商或改 Base URL 之后，之前拉到的列表就不作数了
  useEffect(() => {
    setFetchedModels([]);
    setModelFetchMessage('');
  }, [settings.translationProviderId, activeProviderProfile.baseUrl]);

  const runModelFetch = async (): Promise<void> => {
    if (modelFetching) return;
    setModelFetching(true);
    setModelFetchMessage('');
    const result = await fetchProviderModels({
      baseUrl: activeProviderProfile.baseUrl,
      apiKey: activeProviderSecret.value,
    });
    setModelFetching(false);
    if (!result.ok) {
      setModelFetchMessage(copy.modelFetchFailed(result.error));
      return;
    }
    setFetchedModels(result.models);
    setModelCustom(false);
    setModelFetchMessage(copy.modelFetchOk(result.models.length));
    // 当前填的模型不在返回列表里就换成第一个，省得用户点开发现是空的
    if (!result.models.includes(activeProviderProfile.model)) {
      patchActiveProviderProfile({ model: result.models[0] });
    }
  };

  /* ============================================================
   * 手动补翻：框选一块 → 单独重跑一遍流水线 → 贴回结果图
   *
   * 为什么有效：检测模型输入写死 1024×1024，整张大图送进去等于缩到 0.2 倍，
   * 小字直接消失；单独裁出来的小块会被 letterbox 放大到 1024，字就看得见了。
   * 实测：框住 9px 小字的一块单独跑，能读出整图那遍读不到的 4.5" / SCALE / jakks。
   * 详见 features/patch/regionPatch.ts。
   * ============================================================ */
  const previewImageRef = useRef<HTMLImageElement>(null);
  const [patchMode, setPatchMode] = useState(false);
  const [patchShape, setPatchShape] = useState<'box' | 'lasso'>('box');
  const [patchPath, setPatchPath] = useState<{ x: number; y: number }[]>([]);
  const [patchDrag, setPatchDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [patchRect, setPatchRect] = useState<PatchRect | null>(null);
  const [patchBusy, setPatchBusy] = useState(false);
  const [patchNotice, setPatchNotice] = useState('');
  const [mergedUrl, setMergedUrl] = useState<string | null>(null);
  const [patchRecords, setPatchRecords] = useState<PatchRecord[]>([]);

  useEffect(() => {
    setPatchRect(null);
    setPatchDrag(null);
    setPatchPath([]);
  }, [selectedId, previewMode]);

  useEffect(() => { setPatchNotice(''); }, [selectedId]);

  useEffect(() => {
    setPatchRecords(readPatchRecords());
  }, [selectedId, jobs]);

  // 切到某张图时，把它之前保存过的合并结果取回来（刷新页面、克隆新批次都还在）
  useEffect(() => {
    let cancelled = false;
    setMergedUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    if (!selectedImage) return () => { cancelled = true; };
    const key = mergedStorageKey({
      name: selectedImage.file.name,
      size: selectedImage.file.size,
      width: selectedImage.width,
      height: selectedImage.height,
    });
    void loadMergedResult(key).then((blob) => {
      if (cancelled || !blob) return;
      setMergedUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(blob);
      });
    });
    return () => { cancelled = true; };
  }, [selectedImage]);

  const parentPatches = patchRecords.filter((record) => record.parentId === selectedId);
  // 注意：完成的结果可能只有 resultUrl（blob 会被释放以省内存），
  // 所以这里只判断"有没有结果"，真正的像素在合并时再取。
  const patchCandidates = parentPatches.map((record) => {
    const image = queue.find((candidate) => candidate.file.name === record.name);
    const job = image ? jobs[image.id] : undefined;
    return {
      record,
      imageId: image?.id,
      hasResult: Boolean(job?.resultBlob || job?.resultUrl),
    };
  });
  const readyPatches = patchCandidates.filter((item) => item.hasResult);

  const dragRectStyle = ((): { left: number; top: number; width: number; height: number } | null => {
    if (!patchDrag) return null;
    const left = Math.min(patchDrag.x0, patchDrag.x1);
    const top = Math.min(patchDrag.y0, patchDrag.y1);
    return {
      left,
      top,
      width: Math.abs(patchDrag.x1 - patchDrag.x0),
      height: Math.abs(patchDrag.y1 - patchDrag.y0),
    };
  })();

  /** 显示坐标（相对 <img> 的 CSS 像素）→ 结果图像素坐标 */
  const displayRectToImage = (
    rect: { x0: number; y0: number; x1: number; y1: number },
  ): PatchRect | null => {
    const image = previewImageRef.current;
    if (!image || !image.naturalWidth) return null;
    const box = image.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    const width = Math.abs(rect.x1 - rect.x0);
    const height = Math.abs(rect.y1 - rect.y0);
    if (width < 8 || height < 8) return null;
    if (!selectedImage) return null;
    return selectionToWorkingRect({
      x: Math.min(rect.x0, rect.x1),
      y: Math.min(rect.y0, rect.y1),
      width,
      height,
    }, box, selectedImage.workingCopy);
  };

  const pointerInImage = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const image = previewImageRef.current;
    if (!image) return null;
    const box = image.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const runPatchSelection = async (): Promise<void> => {
    if (!selectedImage || !patchRect || patchBusy) return;
    setPatchBusy(true);
    setPatchNotice('');
    try {
      const scale = selectedImage.workingCopy.scale || 1;
      const cropped = await cropRegionForPatch(selectedImage.file, patchRect, scale);
      const index = patchRecords.filter((record) => record.parentId === selectedImage.id).length;
      const name = patchFileName(selectedImage.file.name, selectedImage.id, index);
      const file = new File([cropped.file], name, { type: 'image/png', lastModified: Date.now() });
      addPatchRecord({ name, parentId: selectedImage.id, rect: patchRect, createdAt: Date.now() });
      setPatchRecords(readPatchRecords());
      const parentId = selectedImage.id;
      await workbench.dispatch({ type: 'import-files', files: [file] });
      // 导入会把选中项切到刚加入的补翻图；这里切回原图 ——
      // 「合并补翻」是"把补翻贴回原图"，用户接下来要操作的还是原图。
      await workbench.dispatch({ type: 'select-image', imageId: parentId });
      // 不关掉框选模式：多半还要接着框下一处，关掉反而不方便
      setPatchRect(null);
      setPatchNotice(copy.patchQueued);
    } catch (error) {
      console.error('补翻裁剪失败', error);
      setPatchNotice(copy.patchFailed);
    } finally {
      setPatchBusy(false);
    }
  };

  const mergePatches = async (): Promise<void> => {
    if (!selectedId || patchBusy || !selectedImage) return;
    const baseJob = jobs[selectedId];
    if (!baseJob?.resultBlob && !baseJob?.resultUrl) {
      setPatchNotice(copy.patchNeedResult);
      return;
    }
    if (readyPatches.length === 0) {
      setPatchNotice(copy.patchNothingReady);
      return;
    }
    setPatchBusy(true);
    setPatchNotice('');
    try {
      const base = await resultBlobForPatch(baseJob);
      if (!base) return;
      // 已合并的选区可能不再保留在队列里，后续补翻从当前合并图继续。
      let merged = mergedUrl
        ? await resultBlobForPatch({ resultUrl: mergedUrl }) ?? base
        : base;
      let applied = 0;
      for (const item of patchCandidates) {
        if (!item.hasResult || !item.imageId) continue;
        const job = jobs[item.imageId];
        const patchBlob = await resultBlobForPatch(job);
        if (!patchBlob) continue;
        merged = await composePatchOntoResult(merged, patchBlob, item.record.rect);
        applied += 1;
      }
      if (applied === 0) {
        setPatchNotice(copy.patchNothingReady);
        return;
      }
      const saved = await saveMergedResult(
        mergedStorageKey({
          name: selectedImage.file.name,
          size: selectedImage.file.size,
          width: selectedImage.width,
          height: selectedImage.height,
        }),
        merged,
      );
      setMergedUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(merged);
      });
      setPreviewMode('merged');
      setPatchNotice(saved ? copy.patchMerged(applied) : copy.patchMergedUnsaved(applied));
    } catch (error) {
      console.error('补翻合并失败', error);
      setPatchNotice(copy.patchFailed);
    } finally {
      setPatchBusy(false);
    }
  };
  const totalBytes = queue.reduce((sum, image) => sum + image.file.size, 0);
  const queueRuntimeDecision = runtimeView.queue;
  const runtimeBlockerMessage = (
    decision: typeof queueRuntimeDecision,
  ): string => {
    if (decision.status === 'available') return '';
    switch (decision.reason) {
      case 'OFFLINE':
        return copy.offlineHistoryOnly;
      case 'CAPABILITY_CHECKING':
      case 'MODEL_PACKAGE_CHECKING':
      case 'MODEL_PROBING':
      case 'STORAGE_CHECKING':
        return copy.modelGateChecking;
      case 'MODEL_CONSENT_REQUIRED':
      case 'MODEL_PACKAGE_MISSING':
      case 'MODEL_INSTALLING':
      case 'MODEL_INSTALL_PAUSED':
        return copy.modelGatePending;
      case 'STORAGE_UNAVAILABLE':
        return copy.storageUnavailable;
      case 'INSUFFICIENT_STORAGE':
        return copy.storageImportBlocked(
          formatBytes(decision.requiredBytes ?? 0),
          formatBytes(decision.availableBytes ?? 0),
        );
      default:
        return decision.detail ?? copy.startUnavailable;
    }
  };
  const storageImportIssue = storageImportError
    ?? (controls.importImages.status === 'blocked'
      && controls.importImages.reason === 'STORAGE_UNAVAILABLE'
      ? copy.storageUnavailable
      : controls.importImages.status === 'blocked'
        && controls.importImages.reason === 'INSUFFICIENT_STORAGE'
        ? copy.storageLow(formatBytes(controls.importImages.availableBytes ?? 0))
        : undefined);

  useEffect(() => {
    if (settings.processMode === 'translate') {
      setProviderDetailsOpen(providerConfigurationError !== null);
    }
  }, [providerConfigurationError, settings.processMode, settings.translationProviderId]);

  useEffect(() => {
    setPreviewScale('fit');
  }, [selectedId]);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        void workbench.dispatch({ type: 'visibility-hidden' }).catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [workbench]);

  useEffect(() => {
    document.documentElement.lang = settings.uiLocale;
    try {
      localStorage.setItem(WEB_SETTINGS_STORAGE_KEY, encodeWebSettings(settings));
    } catch {
      // The workbench stays usable when preference persistence is unavailable.
    }
  }, [settings]);

  useEffect(() => {
    if (previewMode === 'result' && selectedJob?.status !== 'done') {
      setPreviewMode('original');
    }
  }, [previewMode, selectedJob?.status]);

  const importFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    const expansion = await expandPdfFiles(files);
    if (expansion.length === 0) return;
    await workbench.dispatch({ type: 'import-files', files: expansion });
    setMobilePane('preview');
  }, [workbench]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void importFiles(files);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [importFiles]);

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    void importFiles(files);
  };

  const patchSettings = (patch: Partial<WebSettings>): void => {
    if (
      !processingSettingsEditable
      && Object.keys(patch).some((key) => key !== 'uiLocale')
    ) {
      return;
    }
    void workbench.dispatch({
      type: 'update-settings',
      settings: { ...settings, ...patch },
    });
  };

  const patchActiveProviderProfile = (
    patch: Partial<WebSettings['providerProfiles'][TranslationProviderId]>,
  ): void => {
    if (!processingSettingsEditable) return;
    const providerId = settings.translationProviderId;
    if (patch.baseUrl !== undefined) {
      let targetChanged = patch.baseUrl !== activeProviderProfile.baseUrl;
      try {
        targetChanged = normalizeProviderTargetBinding(patch.baseUrl)
          !== normalizeProviderTargetBinding(activeProviderProfile.baseUrl);
      } catch {
        // An invalid intermediate edit is a different target and must drop the key.
      }
      if (targetChanged) {
        credentialValuesRef.current[providerId] = '';
        providerSecrets.invalidateTarget(providerId);
      }
    }
    void workbench.dispatch({
      type: 'update-settings',
      settings: {
        ...settings,
        providerProfiles: {
          ...settings.providerProfiles,
          [providerId]: {
            ...settings.providerProfiles[providerId],
            ...patch,
          },
        },
      },
    });
  };

  const updateProviderKey = (value: string): void => {
    credentialValuesRef.current[settings.translationProviderId] = value;
    providerSecrets.update(settings.translationProviderId, value);
  };

  const removeActiveProviderConfiguration = async (): Promise<void> => {
    if (!processingSettingsEditable) return;
    const providerId = settings.translationProviderId;
    credentialValuesRef.current[providerId] = '';
    await providerSecrets.clear(providerId);
    await workbench.dispatch({
      type: 'update-settings',
      settings: {
        ...settings,
        providerProfiles: {
          ...settings.providerProfiles,
          [providerId]: structuredClone(defaultWebProviderProfiles[providerId]),
        },
      },
    });
  };

  const downloadBlob = (blob: Blob, fileName: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const handleHistoryOutcome = async (
    intent: WebWorkbenchHistoryAction,
  ): Promise<void> => {
    const outcome = await workbench.dispatch(intent);
    if (outcome?.status !== 'effect') return;
    if (outcome.effect === 'download-history-artifact') {
      if (
        outcome.artifact.kind === 'results'
        && outcome.artifact.omissions.length > 0
        && !window.confirm(
          `有 ${outcome.artifact.omissions.length} 个结果缺失或损坏，将只导出其余 `
          + `${outcome.artifact.exportedCount} 个结果。是否继续？`,
        )
      ) {
        return;
      }
      downloadBlob(outcome.artifact.blob, outcome.artifact.fileName);
    }
    if (outcome.effect === 'open-workbench') {
      setActiveView('workbench');
      setPreviewMode('original');
      if (outcome.providerSelectionRequired) {
        setProviderDetailsOpen(true);
      }
    }
  };

  const exportHistoryProject = async (batchId: string): Promise<void> => {
    if (!window.confirm(copy.historyExportWarning)) return;
    await handleHistoryOutcome({ type: 'export-history-project', batchId });
  };

  const keepHistoryResultsOnly = async (batchId: string): Promise<void> => {
    if (!window.confirm(copy.historyKeepResultsWarning)) return;
    await handleHistoryOutcome({ type: 'keep-history-results', batchId });
  };

  const removeImage = async (id: string): Promise<void> => {
    await workbench.dispatch({ type: 'remove-image', imageId: id });
  };

  const moveImage = async (id: string, direction: -1 | 1): Promise<void> => {
    await workbench.dispatch({ type: 'move-image', imageId: id, direction });
  };

  const handleDragEnter = (event: DragEvent): void => {
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  };

  const handleDragLeave = (event: DragEvent): void => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  };

  const handleDrop = (event: DragEvent): void => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    void importFiles(Array.from(event.dataTransfer.files));
  };

  const modeLabel = (mode: ProcessMode): string => {
    if (mode === 'translate') return copy.translate;
    if (mode === 'original') return copy.originalReflow;
    return copy.eraseOnly;
  };

  const jobStatusLabel = (status: QueueJobStatus): string => {
    if (status === 'queued') return copy.statusQueued;
    if (status === 'running') return copy.statusRunning;
    if (status === 'done') return copy.statusDone;
    if (status === 'failed') return copy.statusFailed;
    return copy.statusCancelled;
  };

  const acceptModelDownload = (): void => {
    if (isGitHubPagesBuild) { modelInputRef.current?.click(); return; }
    void workbench.dispatch({ type: 'install-models' }).catch(() => undefined);
  };

  const cancelCurrent = (): void => {
    if (!processing.canCancelCurrent) return;
    void workbench.dispatch({ type: 'cancel-current' }).catch(() => undefined);
  };

  const stopBatch = (): void => {
    if (!processing.canStop) return;
    void workbench.dispatch({ type: 'stop-processing' }).catch(() => undefined);
  };

  const retryTask = (taskId: string): void => {
    if (!processing.canRetryTasks) return;
    void workbench.dispatch({ type: 'retry-task', taskId }).catch(() => undefined);
  };

  const exitHistoryResume = (): void => {
    if (batchRunning) return;
    void workbench.dispatch({ type: 'exit-recovery' }).catch(() => undefined);
  };

  const startBatch = async (): Promise<void> => {
    if (localBlocked) return;
    if (queueRuntimeDecision.status !== 'available') return;
    await workbench.dispatch({ type: 'start-processing' }).catch(() => undefined);
  };

  const startAllowed = (
    primaryAction.kind === 'start-processing'
    && primaryAction.availability.status === 'available'
    && !localBlocked
  );
  const continuousCameraAllowed = cameraEntry.kind === 'open-camera'
    && cameraEntry.availability.status === 'available';
  const continuousCameraBlocker = cameraEntry.kind === 'open-provider-settings'
    ? providerConfigurationError ?? copy.startUnavailable
    : storageImportIssue ?? runtimeBlockerMessage(cameraEntry.availability);

  const handleContinuousCameraEntry = (): void => {
    void workbench.dispatch({ type: 'activate-camera-entry' }).then((outcome) => {
      if (outcome?.status !== 'effect') return;
      if (outcome.effect === 'open-storage-settings') {
        setActiveView('settings');
        void refreshStorage();
      } else if (outcome.effect === 'open-provider-settings') {
        setProviderDetailsOpen(true);
        setMobilePane('settings');
      }
    }).catch(() => undefined);
  };

  const continueContinuousCamera = (): void => {
    void workbench.dispatch({ type: 'next-camera' });
  };

  const closeContinuousCamera = (): void => {
    void workbench.dispatch({ type: 'close-camera' }).catch(() => undefined);
  };

  const translateContinuousCameraCapture = async (file: File): Promise<void> => {
    await workbench.dispatch({ type: 'capture-camera', file });
  };

  useEffect(() => {
    const handleWorkbenchShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLSelectElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      const commandKey = event.ctrlKey || event.metaKey;
      if (commandKey && !event.altKey && key === 'o') {
        if (
          activeView === 'workbench'
          && !importing
          && controls.importImages.status === 'available'
        ) {
          event.preventDefault();
          fileInputRef.current?.click();
        }
        return;
      }
      if (commandKey && !event.altKey && key === 'enter') {
        if (activeView !== 'workbench') return;
        if (batchRunning) {
          event.preventDefault();
          stopBatch();
        } else if (startAllowed) {
          event.preventDefault();
          void startBatch();
        }
        return;
      }
      if (
        event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
        && (key === '1' || key === '2' || key === '3')
      ) {
        event.preventDefault();
        setActiveView('workbench');
        setMobilePane(key === '1' ? 'queue' : key === '2' ? 'preview' : 'settings');
      }
    };

    window.addEventListener('keydown', handleWorkbenchShortcut);
    return () => window.removeEventListener('keydown', handleWorkbenchShortcut);
  }, [
    activeView,
    batchRunning,
    importing,
    controls.importImages.status,
    startAllowed,
    startBatch,
    stopBatch,
  ]);

  const modelProgressPercent = Math.min(
    100,
    Math.round(
      (modelPackageState.storedBytes / Math.max(1, modelPackageState.totalBytes)) * 100,
    ),
  );
  const capabilityFailureDetail = (
    queueRuntimeDecision.status === 'blocked'
    && queueRuntimeDecision.reason === 'CAPABILITY_FAILED'
  )
    ? runtimeBlockerMessage(queueRuntimeDecision)
    : undefined;
  const modelGateState = capabilityFailureDetail
    ? 'error'
    : modelPackageState.status === 'installed'
    ? modelRuntimeProbe.status === 'ready'
      ? 'ready'
      : modelRuntimeProbe.status === 'failed'
        ? 'error'
        : 'pending'
    : modelPackageState.status === 'failed'
      ? 'error'
      : 'pending';
  const modelGateDetail = capabilityFailureDetail
    ?? (modelPackageState.status === 'checking'
    ? copy.modelGateChecking
    : modelPackageState.status === 'installed'
      ? modelRuntimeProbe.status === 'ready'
        ? copy.modelGateReady
        : modelRuntimeProbe.status === 'failed'
          ? copy.modelGateProbeFailed
          : modelRuntimeProbe.status === 'checking'
            ? copy.modelGateProbing(
              modelRuntimeProbe.progress?.modelId ?? 'runtime',
              modelRuntimeProbe.progress?.completed ?? 0,
              modelRuntimeProbe.progress?.total ?? 4,
            )
            : copy.modelGateChecking
      : modelPackageState.status === 'installing'
        ? modelPackageState.progress?.phase === 'verifying'
          ? copy.modelGateVerifying
          : copy.modelGateInstalling
        : modelPackageState.status === 'paused'
          ? copy.modelGatePaused
      : modelPackageState.status === 'failed'
            ? copy.modelGateFailed
            : copy.modelGatePending);
  const startBlockerDetail = queue.length === 0
    ? copy.queueRequired
    : storageImportIssue
      ?? runtimeBlockerMessage(queueRuntimeDecision);
  const queueRuntimeBlockerCode = queueRuntimeDecision.status === 'blocked'
    ? queueRuntimeDecision.reason
    : undefined;
  const modelProbeRetryAvailable = (
    queueRuntimeBlockerCode === 'MODEL_PROBE_FAILED'
    || queueRuntimeBlockerCode === 'CAPABILITY_FAILED'
  );
  const primaryActionLabel = primaryAction.kind === 'stop-processing'
    ? copy.stopBatch
    : primaryAction.kind === 'pick-images'
      ? copy.addImages
      : primaryAction.kind === 'open-storage-settings'
        ? copy.settings
        : primaryAction.kind === 'install-models'
          ? !modelConsent
            ? copy.modelConsent
            : modelPackageState.status === 'paused'
              ? copy.modelResume
              : copy.modelRetry
          : primaryAction.kind === 'retry-runtime'
            ? copy.modelProbeRetry
            : primaryAction.kind === 'open-provider-settings'
              ? copy.openProviderSettings
              : copy.start;
  const primaryActionIconName: IconName = primaryAction.kind === 'stop-processing'
    ? 'stop'
    : primaryAction.kind === 'pick-images'
      ? 'add'
      : primaryAction.kind === 'open-storage-settings'
        || primaryAction.kind === 'open-provider-settings'
        ? 'gear'
        : primaryAction.kind === 'install-models'
          ? 'download'
          : primaryAction.kind === 'retry-runtime'
            ? 'refresh'
            : 'play';
  const primaryActionDisabled = primaryAction.availability.status === 'blocked'
    || (primaryAction.kind === 'start-processing' && localBlocked);
  const handlePrimaryAction = (): void => {
    if (primaryAction.kind === 'install-models' && isGitHubPagesBuild) {
      modelInputRef.current?.click(); return;
    }
    if (primaryAction.kind === 'start-processing' && localBlocked) return;
    void workbench.dispatch({ type: 'activate-primary' }).then((outcome) => {
      if (outcome?.status !== 'effect') return;
      if (outcome.effect === 'pick-images') {
        fileInputRef.current?.click();
      } else if (outcome.effect === 'open-storage-settings') {
        setActiveView('settings');
        void refreshStorage();
      } else {
        setProviderDetailsOpen(true);
        setMobilePane('settings');
      }
    }).catch(() => undefined);
  };
  const visiblePreviewUrl = (
    previewMode === 'merged' && mergedUrl
      ? mergedUrl
      : previewMode === 'result' && selectedJob?.resultUrl
        ? selectedJob.resultUrl
        : selectedPreviewUrl
  );
  const previewScaleLabel = previewScale === 'fit'
    ? copy.previewFit
    : `${Math.round(previewScale * 100)}%`;
  const adjustPreviewScale = (direction: -1 | 1): void => {
    setPreviewScale((current) => {
      const currentScale = current === 'fit' ? 1 : current;
      const currentIndex = previewZoomSteps.indexOf(currentScale);
      const nextIndex = Math.max(
        0,
        Math.min(
          previewZoomSteps.length - 1,
          (currentIndex < 0 ? previewZoomSteps.indexOf(1) : currentIndex) + direction,
        ),
      );
      return previewZoomSteps[nextIndex];
    });
  };
  const activeProgress = queue
    .map((image) => jobs[image.id])
    .find((job) => job?.status === 'running')
    ?.progress;
  const mobileTaskDetail = batchRunning
    ? activeProgress?.detail ?? copy.batchRunning
    : batchNotice
      || storageImportIssue
      || (startAllowed ? copy.localMode : startBlockerDetail);

  return (
    <div
      className="app-shell"
      data-dragging={dragging}
      onDragEnter={activeView === 'workbench' ? handleDragEnter : undefined}
      onDragLeave={activeView === 'workbench' ? handleDragLeave : undefined}
      onDragOver={(event) => event.preventDefault()}
      onDrop={activeView === 'workbench' ? handleDrop : undefined}
    >
      <header className="topbar">
        <button
          className="brand brand-button"
          type="button"
          aria-label={copy.workbench}
          onClick={() => setActiveView('workbench')}
        >
          <img className="brand-icon" src={brandIconUrl} alt="" />
          <div className="brand-copy">
            <div className="brand-title-row">
              <img
                className="brand-wordmark"
                src={brandWordmarkUrl}
                alt="Shinobu Translator"
              />
              <span className="web-badge">{copy.webBadge}</span>
            </div>
            <span className="brand-subtitle">{copy.appSubtitle}</span>
          </div>
        </button>

        <nav className="topnav" aria-label="Primary">
          <button
            className={`topnav-item ${activeView === 'workbench' ? 'topnav-item-active' : ''}`}
            type="button"
            aria-current={activeView === 'workbench' ? 'page' : undefined}
            onClick={() => setActiveView('workbench')}
          >
            <Icon name="queue" />
            {copy.workbench}
          </button>
          <button
            className={`topnav-item ${activeView === 'history' ? 'topnav-item-active' : ''}`}
            type="button"
            aria-current={activeView === 'history' ? 'page' : undefined}
            onClick={() => {
              setActiveView('history');
              void workbench.dispatch({ type: 'refresh-history' });
            }}
          >
            <Icon name="clock" />
            {copy.history}
          </button>
          <button
            className={`topnav-item ${activeView === 'settings' ? 'topnav-item-active' : ''}`}
            type="button"
            aria-current={activeView === 'settings' ? 'page' : undefined}
            onClick={() => {
              setActiveView('settings');
              void refreshStorage();
            }}
          >
            <Icon name="gear" />
            {copy.settingsTitle}
          </button>
        </nav>

        <div className="topbar-actions">
          <nav className="mobile-view-nav" aria-label="Primary">
            <button
              className="mobile-view-trigger"
              type="button"
              aria-label={copy.history}
              aria-current={activeView === 'history' ? 'page' : undefined}
              onClick={() => {
                setActiveView('history');
                void workbench.dispatch({ type: 'refresh-history' });
              }}
            >
              <Icon name="clock" />
            </button>
            <button
              className="mobile-view-trigger"
              type="button"
              aria-label={copy.settingsTitle}
              aria-current={activeView === 'settings' ? 'page' : undefined}
              onClick={() => {
                setActiveView('settings');
                void refreshStorage();
              }}
            >
              <Icon name="gear" />
            </button>
          </nav>
          <button
            className="install-trigger"
            type="button"
            disabled={pwaInstall.installed}
            onClick={() => void pwaInstall.requestInstall()}
          >
            <Icon name="add" />
            <span>{pwaInstall.installed ? copy.appInstalled : copy.installApp}</span>
          </button>
          <div className="locale-switch" aria-label="界面语言">
            <button
              type="button"
              className={settings.uiLocale === 'zh-CN' ? 'locale-active' : ''}
              aria-pressed={settings.uiLocale === 'zh-CN'}
              onClick={() => patchSettings({ uiLocale: 'zh-CN' as UiLocale })}
            >
              简
            </button>
            <button
              type="button"
              className={settings.uiLocale === 'zh-TW' ? 'locale-active' : ''}
              aria-pressed={settings.uiLocale === 'zh-TW'}
              onClick={() => patchSettings({ uiLocale: 'zh-TW' as UiLocale })}
            >
              繁
            </button>
          </div>
        </div>
      </header>

      {pwa.updateReady && (
        <div className="update-banner" role="status">
          <strong>{copy.updateReady}</strong>
          <button
            className="button button-secondary button-compact"
            type="button"
            disabled={batchRunning}
            onClick={pwa.activateUpdate}
          >
            {copy.applyUpdate}
          </button>
        </div>
      )}

      {pwaInstall.suggestionVisible && !pwaInstall.installed && (
        <div className="install-prompt" role="dialog" aria-labelledby="install-prompt-title">
          <strong id="install-prompt-title">{copy.installTitle}</strong>
          <div>
            {pwaInstall.nativeAvailable && (
              <button
                className="button button-primary button-compact"
                type="button"
                onClick={() => void pwaInstall.requestInstall()}
              >
                {copy.installNow}
              </button>
            )}
            <button
              className="button button-secondary button-compact"
              type="button"
              onClick={pwaInstall.dismissSuggestion}
            >
              {copy.notNow}
            </button>
          </div>
        </div>
      )}

      {activeView === 'workbench' ? (
        <>
      <main className="workspace" data-mobile-pane={mobilePane}>
        <input ref={modelInputRef} type="file" multiple accept=".onnx,.ort,.txt" hidden
          aria-label="导入模型文件" onChange={event => {
            const files = Array.from(event.target.files ?? []); event.target.value = '';
            if (!files.length) return;
            try {
              selectLocalModels(files); setModelImportError('');
              void workbench.dispatch({ type: 'install-models' }).catch(() => undefined);
            } catch (error) { setModelImportError(error instanceof Error ? error.message : String(error)); }
          }} />
        <aside className="workspace-pane queue-pane" aria-label={copy.queue}>
          <div className="pane-header">
            <div>
              <h1>{copy.queue}</h1>
              <p>{copy.queueCount(queue.length)} · {copy.totalSize(formatBytes(totalBytes))}</p>
            </div>
            <input
              ref={fileInputRef}
              id="web-image-import"
              name="image-import"
              className="visually-hidden"
              type="file"
              tabIndex={-1}
              accept=".png,.jpg,.jpeg,.webp,.avif,.pdf,image/png,image/jpeg,image/webp,image/avif,application/pdf"
              multiple
              disabled={controls.importImages.status === 'blocked'}
              onChange={handleFileInput}
            />
            <div className="import-actions">
              <button
                className="button button-secondary button-compact camera-action"
                type="button"
                title={continuousCameraAllowed
                  ? copy.continuousCamera
                  : continuousCameraBlocker}
                disabled={cameraEntry.availability.status === 'blocked'}
                onClick={handleContinuousCameraEntry}
              >
                <Icon name="camera" />
                {copy.cameraCapture}
              </button>
              <button
                className="button button-secondary button-compact"
                type="button"
                aria-keyshortcuts="Control+O Meta+O"
                title={`${copy.addImages} (Ctrl/⌘+O)`}
                disabled={controls.importImages.status === 'blocked'}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="add" />
                {importing ? copy.importing : copy.addImages}
              </button>
            </div>
          </div>

          {storageImportIssue && (
            <div className="storage-import-warning" role="alert">
              <Icon name="warning" />
              <span>{storageImportIssue}</span>
              <button
                type="button"
                onClick={() => {
                  setActiveView('settings');
                  void refreshStorage();
                }}
              >
                {copy.settings}
              </button>
            </div>
          )}

          {queue.length === 0 ? (
            <div className="queue-empty">
              <div className="empty-illustration" aria-hidden="true">
                <Icon name="image" />
                <span><Icon name="add" /></span>
              </div>
              <h2>{copy.queueEmptyTitle}</h2>
              <p>{copy.queueEmptyBody}</p>
              <button
                className="button button-primary"
                type="button"
                aria-keyshortcuts="Control+O Meta+O"
                title={`${copy.addImages} (Ctrl/⌘+O)`}
                disabled={controls.importImages.status === 'blocked'}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="add" />
                {copy.addImages}
              </button>
            </div>
          ) : (
            <ol className="queue-list">
              {queue.map((image, index) => {
                const selected = selectedId === image.id;
                const job = jobs[image.id];
                const actions = itemActions[image.id];
                return (
                  <li
                    className="queue-item"
                    data-selected={selected}
                    key={image.id}
                    style={{ animationDelay: `${Math.min(index, 7) * 24}ms` }}
                  >
                    <button
                      className="queue-select"
                      type="button"
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => {
                        void workbench.dispatch({ type: 'select-image', imageId: image.id });
                        setMobilePane('preview');
                      }}
                    >
                      <span className="queue-index">{String(index + 1).padStart(2, '0')}</span>
                      <img src={image.thumbnailUrl} alt="" />
                      <span className="queue-copy">
                        <strong title={image.file.name}>{image.file.name}</strong>
                        <span>{copy.imageMeta(image.width, image.height, formatBytes(image.file.size))}</span>
                        <span className="queue-badges">
                          {image.duplicate && <em>{copy.duplicate}</em>}
                          {image.workingCopy.required && <em>{copy.workingCopy}</em>}
                          {job && (
                            <em data-job-status={job.status}>
                              {jobStatusLabel(job.status)}
                            </em>
                          )}
                        </span>
                        {job?.status === 'running' && job.progress && (
                          <span className="queue-progress">{job.progress.detail}</span>
                        )}
                        {job?.error && <span className="queue-error">{job.error}</span>}
                      </span>
                    </button>
                    <span className="queue-actions">
                      {(job?.status === 'failed' || job?.status === 'cancelled') && (
                        <button
                          type="button"
                          aria-label={copy.retryTask}
                          title={copy.retryTask}
                          disabled={actions?.retry.status === 'blocked'}
                          onClick={() => retryTask(image.id)}
                        >
                          <Icon name="refresh" />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={actions?.moveUp.status === 'blocked'}
                        aria-label={copy.moveUp}
                        title={copy.moveUp}
                        onClick={() => void moveImage(image.id, -1)}
                      >
                        <Icon name="arrow-up" />
                      </button>
                      <button
                        type="button"
                        disabled={actions?.moveDown.status === 'blocked'}
                        aria-label={copy.moveDown}
                        title={copy.moveDown}
                        onClick={() => void moveImage(image.id, 1)}
                      >
                        <Icon name="arrow-down" />
                      </button>
                      <button
                        type="button"
                        disabled={actions?.remove.status === 'blocked'}
                        aria-label={copy.remove}
                        title={copy.remove}
                        onClick={() => void removeImage(image.id)}
                      >
                        <Icon name="trash" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {rejections.length > 0 && (
            <section className="import-issues" aria-live="polite">
              <div className="issues-header">
                <h2><Icon name="warning" />{copy.issues} ({rejections.length})</h2>
                <button
                  type="button"
                  onClick={() => void workbench.dispatch({ type: 'clear-rejections' })}
                >
                  {copy.clearIssues}
                </button>
              </div>
              <ul>
                {rejections.map((rejection, index) => (
                  <li key={`${rejection.file.name}-${rejection.file.lastModified}-${index}`}>
                    <strong>{rejection.file.name}</strong>
                    <span>{describeImportRejection(settings.uiLocale, rejection.code)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>

        <section className="workspace-pane preview-pane" aria-label={copy.preview}>
          <div className="pane-header preview-header">
            <div>
              <h1>{copy.preview}</h1>
              {selectedImage && (
                <p>
                  {copy.imageMeta(
                    selectedImage.width,
                    selectedImage.height,
                    formatBytes(selectedImage.file.size),
                  )}
                </p>
              )}
            </div>
            <div
              className="preview-tabs"
              data-mode={previewMode}
              aria-label={copy.preview}
            >
              <span className="preview-tab-indicator" aria-hidden="true" />
              <button
                type="button"
                aria-pressed={previewMode === 'original'}
                onClick={() => setPreviewMode('original')}
              >
                {copy.original}
              </button>
              <button
                type="button"
                aria-pressed={previewMode === 'result'}
                disabled={selectedJob?.status !== 'done'}
                title={selectedJob?.status === 'done' ? undefined : copy.compareUnavailable}
                onClick={() => setPreviewMode('result')}
              >
                {copy.result}
              </button>
              <button
                type="button"
                aria-pressed={previewMode === 'merged'}
                disabled={!mergedUrl}
                title={mergedUrl ? undefined : copy.patchMergeHint}
                onClick={() => setPreviewMode('merged')}
              >
                {copy.patchMergedTab}
              </button>
            </div>
            {mergedUrl && (
              <a
                className="button button-secondary button-compact"
                href={mergedUrl}
                download={`${selectedImage ? selectedImage.file.name.replace(/\.[a-z0-9]+$/iu, '') : 'result'}·合并.png`}
              >
                {copy.patchDownload}
              </a>
            )}
          </div>

          <div className="preview-stage">
            {selectedImage && visiblePreviewUrl ? (
              <>
                <div className="preview-toolbar" aria-label={copy.previewZoom}>
                  <button
                    type="button"
                    aria-label={copy.zoomOut}
                    title={copy.zoomOut}
                    disabled={previewScale !== 'fit' && previewScale <= previewZoomSteps[0]}
                    onClick={() => adjustPreviewScale(-1)}
                  >
                    <Icon name="zoom-out" />
                  </button>
                  <button
                    className="preview-scale-button"
                    type="button"
                    aria-label={copy.previewFit}
                    title={copy.previewFit}
                    data-active={previewScale === 'fit'}
                    onClick={() => setPreviewScale('fit')}
                  >
                    <Icon name="fit" />
                    <span>{previewScaleLabel}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={copy.zoomIn}
                    title={copy.zoomIn}
                    disabled={previewScale !== 'fit'
                      && previewScale >= previewZoomSteps[previewZoomSteps.length - 1]}
                    onClick={() => adjustPreviewScale(1)}
                  >
                    <Icon name="zoom-in" />
                  </button>
                  {/* 手动补翻：框选一块单独重跑，再合并回结果 */}
                  <button
                    type="button"
                    className="patch-button"
                    aria-pressed={patchMode}
                    data-active={patchMode}
                    disabled={!selectedImage || patchBusy}
                    title={copy.patchSelectHint}
                    onClick={() => {
                      setPatchMode((on) => !on);
                      setPatchRect(null);
                    }}
                  >
                    {copy.patchSelect}
                  </button>
                  <button
                    type="button"
                    className="patch-button"
                    disabled={!patchRect || patchBusy}
                    title={copy.patchRunHint}
                    onClick={() => void runPatchSelection()}
                  >
                    {copy.patchRun}
                  </button>
                  {patchMode && (
                    <span className="patch-shape-switch">
                      <button
                        type="button"
                        aria-pressed={patchShape === 'box'}
                        data-active={patchShape === 'box'}
                        onClick={() => setPatchShape('box')}
                      >
                        {copy.patchShapeBox}
                      </button>
                      <button
                        type="button"
                        aria-pressed={patchShape === 'lasso'}
                        data-active={patchShape === 'lasso'}
                        onClick={() => setPatchShape('lasso')}
                      >
                        {copy.patchShapeLasso}
                      </button>
                    </span>
                  )}
                  <button
                    type="button"
                    className="patch-button"
                    disabled={patchBusy || readyPatches.length === 0}
                    title={copy.patchMergeHint}
                    onClick={() => void mergePatches()}
                  >
                    {copy.patchMerge}
                    {parentPatches.length > 0 ? ` (${readyPatches.length}/${parentPatches.length})` : ''}
                  </button>
                </div>
                <div
                  className="image-canvas"
                  data-view={previewScale === 'fit' ? 'fit' : 'zoom'}
                  data-patch={patchMode ? 'on' : 'off'}
                >
                  <div className="image-canvas-stage">
                    <img
                      key={`${selectedImage.id}:${previewMode}`}
                      ref={previewImageRef}
                      src={visiblePreviewUrl}
                      alt={selectedImage.file.name}
                      draggable={false}
                      style={previewScale === 'fit'
                        ? undefined
                        : { width: `${Math.round(selectedImage.width * previewScale)}px` }}
                    />
                    {patchMode && (
                      <div
                        className="patch-layer"
                        data-shape={patchShape}
                        onPointerDown={(event) => {
                          const point = pointerInImage(event);
                          if (!point) return;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          if (patchShape === 'lasso') {
                            setPatchPath([point]);
                            setPatchRect(null);
                          } else {
                            setPatchDrag({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
                          }
                        }}
                        onPointerMove={(event) => {
                          const point = pointerInImage(event);
                          if (!point) return;
                          if (patchShape === 'lasso') {
                            if (patchPath.length === 0) return;
                            // 采样间隔别太密：手感一样，点数少很多
                            const last = patchPath[patchPath.length - 1];
                            if (Math.hypot(point.x - last.x, point.y - last.y) < 4) return;
                            setPatchPath((path) => [...path, point]);
                            return;
                          }
                          if (!patchDrag) return;
                          setPatchDrag({ ...patchDrag, x1: point.x, y1: point.y });
                        }}
                        onPointerUp={() => {
                          if (patchShape === 'lasso') {
                            setPatchPath((path) => {
                              if (path.length >= 2) {
                                // 画圈最终也用**外接矩形**去裁、去贴：
                                // 补翻是"把这块重新认一遍再整块贴回"，用矩形最简单也最稳
                                const xs = path.map((p) => p.x);
                                const ys = path.map((p) => p.y);
                                setPatchRect(displayRectToImage({
                                  x0: Math.min(...xs),
                                  y0: Math.min(...ys),
                                  x1: Math.max(...xs),
                                  y1: Math.max(...ys),
                                }));
                              }
                              return [];
                            });
                            return;
                          }
                          if (!patchDrag) return;
                          setPatchRect(displayRectToImage(patchDrag));
                          setPatchDrag(null);
                        }}
                      />
                    )}
                    {patchPath.length > 1 && (
                      <svg className="patch-lasso" aria-hidden="true">
                        <polyline
                          points={patchPath.map((point) => `${point.x},${point.y}`).join(' ')}
                          fill="rgba(79,127,255,0.12)"
                          stroke="#4f7fff"
                          strokeWidth="2"
                          strokeDasharray="4 3"
                        />
                      </svg>
                    )}
                    {dragRectStyle && (
                      <div
                        className="patch-rect"
                        style={{
                          left: `${dragRectStyle.left}px`,
                          top: `${dragRectStyle.top}px`,
                          width: `${dragRectStyle.width}px`,
                          height: `${dragRectStyle.height}px`,
                        }}
                      />
                    )}
                    {!dragRectStyle && patchRect && (
                      <div
                        className="patch-rect"
                        style={{
                          left: `${patchRect.x / selectedImage.workingCopy.width * 100}%`,
                          top: `${patchRect.y / selectedImage.workingCopy.height * 100}%`,
                          width: `${patchRect.width / selectedImage.workingCopy.width * 100}%`,
                          height: `${patchRect.height / selectedImage.workingCopy.height * 100}%`,
                        }}
                      />
                    )}
                  </div>
                </div>
                <div className="preview-meta">
                  {patchNotice && (
                    <div className="patch-notice">{patchNotice}</div>
                  )}
                  <div>
                    <strong>{selectedImage.file.name}</strong>
                    <span>
                      {selectedImage.format.toUpperCase()} · {formatBytes(selectedImage.file.size)}
                    </span>
                  </div>
                  <div>
                    <strong>{selectedImage.width} × {selectedImage.height}</strong>
                    <span>
                      {selectedImage.workingCopy.required
                        ? copy.workMeta(
                            selectedImage.workingCopy.width,
                            selectedImage.workingCopy.height,
                            selectedImage.workingCopy.scale,
                          )
                        : `${(selectedImage.pixelCount / 1_000_000).toFixed(1)} MP`}
                    </span>
                  </div>
                </div>
                {selectedJob?.status === 'running' && selectedJob.progress && (
                  <div className="task-callout" data-state="running" aria-live="polite">
                    <strong>{copy.statusRunning}</strong>
                    <span>{selectedJob.progress.detail}</span>
                  </div>
                )}
                {selectedJob?.error && (
                  <div className="task-callout" data-state="failed" role="alert">
                    <strong>{jobStatusLabel(selectedJob.status)}</strong>
                    <span>{selectedJob.error}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="preview-empty">
              <div className="preview-empty-symbol"><Icon name="image" /></div>
              <h2>{copy.previewEmptyTitle}</h2>
                <p>{copy.previewEmptyBody}</p>
                <button
                  className="button button-primary camera-empty-action"
                  type="button"
                  title={continuousCameraAllowed
                    ? copy.continuousCamera
                    : continuousCameraBlocker}
                  disabled={cameraEntry.availability.status === 'blocked'}
                  onClick={handleContinuousCameraEntry}
                >
                  <Icon name="camera" />
                  {copy.cameraCapture}
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="workspace-pane settings-pane" aria-label={copy.batchSettings}>
          <div className="pane-header">
            <h1>{copy.batchSettings}</h1>
          </div>

          <div className="settings-content">
            <form
              className="settings-section"
              onSubmit={(event) => event.preventDefault()}
            >
              <h2>{copy.processMode}</h2>
              <div className="segmented-control" role="radiogroup" aria-label={copy.processMode}>
                <span
                  className="segmented-indicator"
                  data-mode={settings.processMode}
                  aria-hidden="true"
                />
                {processModes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={settings.processMode === mode}
                    data-active={settings.processMode === mode}
                    disabled={!processingSettingsEditable}
                    onClick={() => patchSettings({ processMode: mode })}
                  >
                    {modeLabel(mode)}
                  </button>
                ))}
              </div>

              <label className="field">
                <span>{copy.targetLanguage}</span>
                <select
                  id="batch-target-language"
                  name="target-language"
                  value={settings.targetLanguage}
                  disabled={!processingSettingsEditable || localPreparing}
                  onChange={(event) =>
                    patchSettings({ targetLanguage: event.target.value as TargetLanguage })}
                >
                  <option value="zh-CHS">{copy.simplifiedChinese}</option>
                  <option value="zh-CHT">{copy.traditionalChinese}</option>
                </select>
              </label>

              {settings.processMode === 'translate' && <>
                <label className="field">
                  <span>翻译方式</span>
                  <select id="batch-translation-mode" value={settings.translationMode ?? 'api'}
                    disabled={!processingSettingsEditable || localPreparing}
                    onChange={event => patchSettings({ translationMode: event.target.value as 'api' | 'local' | 'auto' })}>
                    <option value="api">API 翻译</option>
                    <option value="local">浏览器本地（不调用 API）</option>
                    <option value="auto">自动（短句本地，复杂内容用 API）</option>
                  </select>
                </label>
                {settings.translationMode && settings.translationMode !== 'api' && <div className="field">
                  <small role="status">{localMessage || (localAvailability === 'available' ? '浏览器本地翻译可用。'
                    : localAvailability === 'unavailable' ? '当前浏览器不支持此语言的本地翻译，请尝试桌面 Chrome / Edge。'
                    : '首次使用需下载浏览器语言包，下载后可在本机翻译。')}</small>
                  <button type="button" className="button button-secondary button-compact"
                    disabled={!processingSettingsEditable || localPreparing || localAvailability === 'unavailable'}
                    onClick={() => void prepareLocal()}>{localPreparing ? '正在准备…' : '准备本地翻译'}</button>
                  {localPreparing && <button type="button" className="button button-secondary button-compact"
                    onClick={() => localPrepareController.current?.abort()}>取消准备</button>}
                  {settings.translationMode === 'auto' && <small>单行且不超过 100 字符、12 个词时优先本地；多行说明、长句或本地不可用时使用下方 API。</small>}
                </div>}
              </>}
              {settings.translationMode !== 'local' && <label className="field">
                <span>{copy.provider}</span>
                <select
                  id="batch-translation-provider"
                  name="translation-provider"
                  value={settings.translationProviderId}
                  disabled={
                    !processingSettingsEditable
                    || settings.processMode !== 'translate'
                  }
                  onChange={(event) =>
                    patchSettings({
                      translationProviderId: event.target.value as TranslationProviderId,
                    })}
                >
                  {translationProviderOptions.map((provider) => (
                    <option value={provider.id} key={provider.id}>{provider.label}</option>
                  ))}
                </select>
              </label>}
              {settings.processMode === 'translate' && settings.translationMode !== 'local' && (
                <details
                  className="provider-disclosure"
                  open={providerDetailsOpen}
                  onToggle={(event) => setProviderDetailsOpen(event.currentTarget.open)}
                >
                  <summary>
                    <span>
                      <strong>{copy.providerSettingsTitle}</strong>
                      <small>
                        {providerReady ? copy.providerReady : copy.providerGatePending}
                      </small>
                    </span>
                    <span className="provider-disclosure-action" aria-hidden="true">
                      <Icon name="chevron-down" />
                    </span>
                  </summary>
                  <div className="workspace-provider-fields">
                    <div className="workspace-provider-grid">
                      <label className="field">
                        <span>{copy.baseUrl}</span>
                        <input
                          id="batch-provider-base-url"
                          name="provider-base-url"
                          type="url"
                          value={activeProviderProfile.baseUrl}
                          disabled={!processingSettingsEditable}
                          spellCheck={false}
                          onChange={(event) =>
                            patchActiveProviderProfile({ baseUrl: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{copy.model}</span>
                        {showModelSelect ? (
                          <select
                            id="batch-provider-model"
                            name="provider-model"
                            value={activeProviderProfile.model}
                            disabled={!processingSettingsEditable}
                            title={processingSettingsEditable ? undefined : copy.modelLocked}
                            onChange={(event) => {
                              if (event.target.value === CUSTOM_MODEL_VALUE) {
                                setModelCustom(true);
                                return;
                              }
                              setModelCustom(false);
                              patchActiveProviderProfile({ model: event.target.value });
                            }}
                          >
                            {effectiveModelChoices.map((model) => (
                              <option key={model} value={model}>{model}</option>
                            ))}
                            <option value={CUSTOM_MODEL_VALUE}>{copy.modelCustom}</option>
                          </select>
                        ) : (
                          <input
                            id="batch-provider-model"
                            name="provider-model"
                            type="text"
                            value={activeProviderProfile.model}
                            disabled={!processingSettingsEditable}
                            spellCheck={false}
                            title={processingSettingsEditable ? undefined : copy.modelLocked}
                            onChange={(event) =>
                              patchActiveProviderProfile({ model: event.target.value })}
                          />
                        )}
                        {/* 把"这一批实际会用哪个模型"直接写出来，不用去猜 */}
                        <small className="muted tiny">
                          {copy.modelInUse(
                            translationProviderOptions.find(
                              (provider) => provider.id === settings.translationProviderId,
                            )?.label ?? settings.translationProviderId,
                            activeProviderProfile.model || '—',
                          )}
                        </small>
                        {!processingSettingsEditable && (
                          <small className="muted tiny">{copy.modelLocked}</small>
                        )}
                        <span className="model-fetch-row">
                          <button
                            type="button"
                            className="button button-secondary button-compact"
                            disabled={modelFetching || !processingSettingsEditable}
                            title={copy.modelFetchHint}
                            onClick={() => void runModelFetch()}
                          >
                            {modelFetching ? copy.modelFetching : copy.modelFetch}
                          </button>
                          {modelFetchMessage && (
                            <small className="muted tiny">{modelFetchMessage}</small>
                          )}
                        </span>
                      </label>
                    </div>
                    <label className="field">
                      <span>{copy.apiKey}</span>
                      <input
                        id="batch-provider-api-key"
                        name="provider-api-key"
                        type="password"
                        value={activeProviderSecret.value}
                        disabled={
                          !processingSettingsEditable
                          || activeProviderSecret.busy
                        }
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => updateProviderKey(event.target.value)}
                      />
                      {activeProviderSecret.restoreStatus === 'restoring' && (
                        <small>{copy.deviceKeyRestoring}</small>
                      )}
                      {activeProviderSecret.restoreStatus === 'target-mismatch' && (
                        <small className="field-error" role="alert">
                          {copy.deviceKeyTargetMismatch}
                        </small>
                      )}
                      {activeProviderSecret.restoreStatus === 'corrupt' && (
                        <small className="field-error" role="alert">
                          {copy.deviceKeyCorrupt}
                        </small>
                      )}
                      {activeProviderSecret.error && (
                        <small className="field-error" role="alert">
                          {activeProviderSecret.error}
                        </small>
                      )}
                    </label>
                    <div className="provider-config-actions">
                      <label className="remember-control">
                        <input
                          id="batch-remember-device"
                          name="remember-provider-key"
                          type="checkbox"
                          checked={activeProviderSecret.persistence === 'device'}
                          disabled={
                            !processingSettingsEditable
                            || activeProviderSecret.busy
                            || !activeProviderSecret.value.trim()
                          }
                          onChange={(event) => {
                            const action = event.target.checked
                              ? providerSecrets.remember(settings.translationProviderId)
                              : providerSecrets.forget(settings.translationProviderId);
                            void action.catch(() => undefined);
                          }}
                        />
                        <span>{copy.rememberDevice}</span>
                      </label>
                      <button
                        className="delete-config"
                        type="button"
                        disabled={!processingSettingsEditable}
                        onClick={() => void removeActiveProviderConfiguration()}
                      >
                        {copy.deleteProviderConfig}
                      </button>
                    </div>
                    {providerConfigurationError && (
                      <small className="provider-error" role="alert">
                        {providerConfigurationError}
                      </small>
                    )}
                  </div>
                </details>
              )}
            </form>

            <section className="settings-section runtime-section model-download-section">
              <h2>{copy.modelGate}</h2>
              {isGitHubPagesBuild && modelPackageState.status !== 'installed' && <div className="field">
                <p>首次使用：从上游下载 5 个模型文件，然后同时选择导入。约 196 MiB，仅保存在此浏览器。</p>
                <a href={upstreamModelRelease} target="_blank" rel="noreferrer">打开上游模型下载页（models-v0.8.3）</a>
                <small>detector.ort、aot_inpaint_512.onnx、bubble.onnx、PP-OCRv6_medium_rec.onnx、paddleocr_v6_dict.txt</small>
                <button type="button" className="button button-secondary" disabled={modelPackageState.status === 'installing'}
                  onClick={() => modelInputRef.current?.click()}>导入模型文件</button>
              </div>}
              {modelImportError && <p role="alert">{modelImportError}</p>}
              <div className="readiness-row" data-state={modelGateState}>
                <span className="readiness-icon">
                  <Icon name={modelGateState === 'ready' ? 'check' : 'clock'} />
                </span>
                <span>
                  <strong>{modelGateDetail}</strong>
                  {modelProbeRetryAvailable && (
                    <>
                      {(capabilityFailureDetail
                        ?? (modelRuntimeProbe.status === 'failed'
                          ? modelRuntimeProbe.error
                          : undefined)) && (
                        <small className="model-error" role="alert">
                          {capabilityFailureDetail
                            ?? (modelRuntimeProbe.status === 'failed'
                              ? modelRuntimeProbe.error
                              : '')}
                        </small>
                      )}
                      <button
                        className="inline-action"
                        type="button"
                        onClick={() => {
                          void workbench.dispatch({ type: 'retry-runtime' });
                        }}
                      >
                        {copy.modelProbeRetry}
                      </button>
                    </>
                  )}
                  {modelPackageState.status !== 'installed' && (
                    <>
                      {modelPackageState.storedBytes > 0 && (
                        <small>
                          {copy.modelDownloadProgress(
                            modelProgressPercent,
                            formatBytes(modelPackageState.storedBytes),
                            formatBytes(modelPackageState.totalBytes),
                          )}
                        </small>
                      )}
                      {modelPackageState.status === 'installing' && (
                        <progress
                          className="model-progress"
                          max={modelPackageState.totalBytes}
                          value={modelPackageState.storedBytes}
                          aria-label={copy.modelGateInstalling}
                        />
                      )}
                      {modelPackageState.error && (
                        <small className="model-error" role="alert">
                          {modelPackageState.error}
                        </small>
                      )}
                      {modelPackageState.status === 'installing' ? (
                        <button
                          className="inline-action"
                          type="button"
                          onClick={() => {
                            void workbench.dispatch({ type: 'cancel-model-install' });
                          }}
                        >
                          {copy.modelCancel}
                        </button>
                      ) : modelPackageState.status !== 'checking' && (
                        <button
                          className="inline-action"
                          type="button"
                          onClick={acceptModelDownload}
                        >
                          {!modelConsent
                            ? copy.modelConsent
                            : modelPackageState.status === 'paused'
                              ? copy.modelResume
                              : copy.modelRetry}
                        </button>
                      )}
                    </>
                  )}
                </span>
              </div>
              {batchRunning && (
                <div className="task-controls">
                  <span>{copy.batchRunning}</span>
                  <button
                    className="button button-secondary button-compact"
                    type="button"
                    onClick={cancelCurrent}
                    disabled={!processing.canCancelCurrent}
                  >
                    {copy.cancelCurrent}
                  </button>
                </div>
              )}
            </section>

          </div>

          <div className="run-footer">
            {!batchRunning && (
              <p className="run-hint" aria-live="polite">
                {startAllowed ? copy.localMode : startBlockerDetail}
              </p>
            )}
            <button
              className="button button-primary button-run"
              type="button"
              aria-keyshortcuts="Control+Enter Meta+Enter"
              title={`${batchRunning ? copy.stopBatch : copy.start} (Ctrl/⌘+Enter)`}
              disabled={primaryActionDisabled}
              onClick={handlePrimaryAction}
            >
              <Icon name={primaryActionIconName} weight="bold" />
              {primaryActionLabel}
            </button>
            {recoveryActive && !batchRunning && (
              <button
                className="button button-secondary button-compact"
                type="button"
                onClick={exitHistoryResume}
              >
                {copy.historyExitResume}
              </button>
            )}
          </div>
        </aside>
      </main>

      {(batchRunning || mobilePane === 'settings') && (
      <div className="mobile-task-bar" aria-live="polite">
        <span title={mobileTaskDetail}>{mobileTaskDetail}</span>
        <button
          className="button button-primary button-compact"
          type="button"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          title={`${batchRunning ? copy.stopBatch : copy.start} (Ctrl/⌘+Enter)`}
          disabled={primaryActionDisabled}
          onClick={handlePrimaryAction}
        >
          <Icon name={primaryActionIconName} weight="bold" />
          {primaryActionLabel}
        </button>
      </div>
      )}

      <nav className="mobile-nav" aria-label="Workspace">
        <button
          type="button"
          aria-keyshortcuts="Alt+1"
          title={`${copy.queue} (Alt+1)`}
          data-active={mobilePane === 'queue'}
          onClick={() => setMobilePane('queue')}
        >
          <Icon name="queue" />
          {copy.queue}
          {queue.length > 0 && <span>{queue.length}</span>}
        </button>
        <button
          type="button"
          aria-keyshortcuts="Alt+2"
          title={`${copy.preview} (Alt+2)`}
          data-active={mobilePane === 'preview'}
          onClick={() => setMobilePane('preview')}
        >
          <Icon name="image" />
          {copy.preview}
        </button>
        <button
          type="button"
          aria-keyshortcuts="Alt+3"
          title={`${copy.batchSettings} (Alt+3)`}
          data-active={mobilePane === 'settings'}
          onClick={() => setMobilePane('settings')}
        >
          <Icon name="settings" />
          {copy.batchSettings}
        </button>
      </nav>
        </>
      ) : activeView === 'history' ? (
        <HistoryView
          copy={copy}
          locale={settings.uiLocale}
          entries={historySnapshot.entries}
          loading={historySnapshot.status === 'loading'}
          busy={historySnapshot.busy}
          error={
            (historyAction?.status === 'rejected'
              ? historyRejectionMessage(historyAction.code, settings.uiLocale)
              : historyAction?.status === 'failed'
                ? `${historyAction.operation}: ${historyAction.cause}`
                : undefined)
            ?? historyCleanupFaultMessage
            ?? (historySnapshot.failure
              ? `${historySnapshot.failure.operation}: ${historySnapshot.failure.cause}`
              : undefined)
          }
          onRefresh={() => void handleHistoryOutcome({ type: 'refresh-history' })}
          onResume={(batchId) => void handleHistoryOutcome({
            type: 'resume-history',
            batchId,
          })}
          onClone={(batchId) => void handleHistoryOutcome({
            type: 'clone-history',
            batchId,
          })}
          onDownload={(batchId, itemId) => void handleHistoryOutcome({
            type: 'download-history-result',
            batchId,
            itemId,
          })}
          onExportResults={(batchId) => void handleHistoryOutcome({
            type: 'export-history-results',
            batchId,
          })}
          onExportProject={(batchId) => void exportHistoryProject(batchId)}
          onImportProject={(file) => void handleHistoryOutcome({
            type: 'import-history-project',
            file,
          })}
          onKeepResults={(batchId) => void keepHistoryResultsOnly(batchId)}
          onDelete={(batchId) => void handleHistoryOutcome({
            type: 'stage-history-delete',
            batchId,
          })}
        />
      ) : (
        <SettingsView
          copy={copy}
          settings={settings}
          historyLocked={recoveryActive}
          storageSnapshot={storageSnapshot}
          storageChecking={storageChecking}
          diagnosticBusy={diagnosticState.exporting}
          onLocaleChange={(locale) => patchSettings({ uiLocale: locale })}
          onRefreshStorage={() => {
            void refreshStorage();
          }}
          onManageHistory={() => {
            setActiveView('history');
            void workbench.dispatch({ type: 'refresh-history' });
          }}
          onExportDiagnostics={() => {
            void workbench.dispatch({ type: 'export-diagnostics' }).catch(() => undefined);
          }}
        />
      )}

      {continuousCameraOpen && (
        <ContinuousCamera
          copy={copy}
          round={continuousCameraRound}
          onCapture={translateContinuousCameraCapture}
          onNext={continueContinuousCamera}
          onExit={closeContinuousCamera}
        />
      )}

      {historySnapshot.pending && (
        <div className="undo-toast" role="status">
          <span>
            {historySnapshot.pending.type === 'delete'
              ? copy.historyDeletePending
              : copy.historyKeepResults}
          </span>
          <button
            type="button"
            onClick={() => void handleHistoryOutcome({ type: 'undo-history-action' })}
          >
            {copy.historyUndoDelete}
          </button>
        </div>
      )}

      {dragging && activeView === 'workbench' && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <Icon name="add" />
            <strong>{copy.dropHint}</strong>
          </div>
        </div>
      )}
      <span className="visually-hidden" aria-live="polite">
        {importing ? copy.importing : ''}
      </span>
    </div>
  );
}
