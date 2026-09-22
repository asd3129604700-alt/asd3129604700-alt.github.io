import type { TextTranslator, TextTranslationRegion, TextTranslationRequest, TextTranslationResult } from '@shinobu/text-translation';

/** 自动模式只把单行短词/短句交给本地模型，多行技术说明仍使用用户选择的 API。 */
export function isSimpleTranslation(text: string): boolean {
  return !/[\r\n]/u.test(text) && text.length <= 100 && text.trim().split(/\s+/u).length <= 12;
}

export function createHybridTextTranslator(api: TextTranslator,
  local: (text: string, target: string, signal?: AbortSignal) => Promise<string>): TextTranslator {
  return {
    async translateRegions<T extends TextTranslationRegion>(request: TextTranslationRequest<T>): Promise<TextTranslationResult<T>> {
      const mode = request.config.localTranslationMode;
      if (!mode) return api.translateRegions(request);
      const translated = new Map<string, T>();
      const remote: T[] = [];
      for (const region of request.regions) {
        request.signal?.throwIfAborted();
        if (mode === 'auto' && !isSimpleTranslation(region.sourceText)) { remote.push(region); continue; }
        try {
          // 明确的数字/色号无需翻译，避免本地模型改写这些值。
          // 浏览器小模型整段翻译可能吞掉中间句子；逐行翻译并保留换行。
          const lines: string[] = [];
          for (const line of region.sourceText.split(/\r?\n/u)) {
            request.signal?.throwIfAborted();
            const preserve = !line.trim() || /^(?:#[0-9a-f]{3,8}|[\d\s.,%°/+\-]+|(?:PMS\s*)?\d{3,6}[A-Z]?)$/iu.test(line.trim());
            lines.push(preserve ? line : await local(line, request.config.targetLang, request.signal));
          }
          const text = lines.join('\n');
          translated.set(region.id, { ...region, translatedText: text, translatedColumns: undefined });
        } catch (error) {
          request.signal?.throwIfAborted();
          if (mode === 'local') throw error; // 本地模式绝不偷偷调用外部 API。
          remote.push(region);
        }
      }
      const response = remote.length ? await api.translateRegions({ ...request, regions: remote }) : null;
      for (const region of response?.regions ?? []) translated.set(region.id, region);
      return { regions: request.regions.map(region => translated.get(region.id) ?? region), translationDebug: response?.translationDebug ?? null };
    },
  };
}
