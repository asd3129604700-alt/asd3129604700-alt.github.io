/** 浏览器内置翻译只在主线程调用；语言包首次使用可能需要下载。 */
export type LocalAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
type LocalSession = { translate(text: string, options?: { signal?: AbortSignal }): Promise<string>; destroy(): void };
type TranslatorFactory = {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<LocalAvailability>;
  create(options: { sourceLanguage: string; targetLanguage: string;
    signal?: AbortSignal;
    monitor?: (monitor: { addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void }) => void;
  }): Promise<LocalSession>;
};
const sessions = new Map<string, LocalSession>();
const pending = new Map<string, Promise<LocalSession>>();
const language = (target: string): string => target === 'zh-CHT' ? 'zh-Hant' : 'zh-Hans';
const factory = (): TranslatorFactory | undefined => (globalThis as unknown as { Translator?: TranslatorFactory }).Translator;

export async function localTranslationAvailability(target: string): Promise<LocalAvailability> {
  if (sessions.has(target)) return 'available';
  const api = factory();
  if (!api) return 'unavailable';
  try { return await api.availability({ sourceLanguage: 'en', targetLanguage: language(target) }); }
  catch { return 'unavailable'; }
}

export async function prepareLocalTranslation(target: string, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (sessions.has(target)) return;
  const api = factory();
  if (!api) throw new Error('当前浏览器不支持本地翻译，请使用支持 Translator 的桌面 Chrome / Edge。');
  let promise = pending.get(target);
  if (!promise) {
    // 必须从按钮点击调用 create，不能等 OCR 结束后才首次申请语言包。
    promise = api.create({ sourceLanguage: 'en', targetLanguage: language(target), signal,
      monitor: monitor => monitor.addEventListener('downloadprogress', event => onProgress?.(event.loaded)),
    });
    pending.set(target, promise);
  }
  try { sessions.set(target, await promise); }
  finally { pending.delete(target); }
}

export async function translateLocally(text: string, target: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!sessions.has(target)) {
    if (await localTranslationAvailability(target) !== 'available') {
      throw new Error('本地翻译尚未就绪，请先点击「准备本地翻译」下载语言包。');
    }
    await prepareLocalTranslation(target);
  }
  const result = await sessions.get(target)!.translate(text, { signal });
  signal?.throwIfAborted();
  if (!result.trim()) throw new Error('浏览器本地翻译返回了空结果。');
  return result;
}
