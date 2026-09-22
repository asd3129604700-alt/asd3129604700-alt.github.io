import { describe, expect, it, vi } from 'vitest';
import { createHybridTextTranslator, isSimpleTranslation } from '../../apps/web/src/runtime/hybridTextTranslator';
import { toWebPipelineConfig } from '../../apps/web/src/runtime/webPipelineConfig';
import { createDefaultWebSettings } from '@shinobu/shared-config';
import type { TextTranslator, TextTranslationRegion, TextTranslationRequest } from '@shinobu/text-translation';

const config = toWebPipelineConfig(createDefaultWebSettings('zh-CN'));
const regions = ['LEFT', 'A long technical instruction.\nThe second line must be included.', '#ff00aa'].map((sourceText, i) => ({ id: String(i), sourceText, translatedText: '', marker: i }));
function remote() {
  const calls = vi.fn();
  const api: TextTranslator = { async translateRegions<T extends TextTranslationRegion>(request: TextTranslationRequest<T>) {
    calls(request); return { regions: request.regions.map(r => ({ ...r, translatedText: `API:${r.sourceText}` })), translationDebug: null };
  } };
  return { api, calls };
}
describe('本地与自动翻译路由', () => {
  it('手动本地翻译所有内容，不调用 API，保留区域信息和色号', async () => {
    const { api, calls } = remote(), local = vi.fn(async text => `本地:${text}`);
    const result = await createHybridTextTranslator(api, local).translateRegions({ regions, config: { ...config, localTranslationMode: 'local' } });
    expect(calls).not.toHaveBeenCalled(); expect(local).toHaveBeenCalledTimes(3);
    expect(result.regions.map(r => r.marker)).toEqual([0, 1, 2]);
    expect(result.regions[2].translatedText).toBe('#ff00aa');
    expect(result.regions[1].translatedText).toBe('本地:A long technical instruction.\n本地:The second line must be included.');
  });
  it('自动模式仅把复杂内容发给 API，结果保持原顺序', async () => {
    const { api, calls } = remote(), local = vi.fn(async () => '左侧');
    const result = await createHybridTextTranslator(api, local).translateRegions({ regions, config: { ...config, localTranslationMode: 'auto' } });
    expect(calls.mock.calls[0][0].regions).toEqual([regions[1]]);
    expect(result.regions.map(r => r.id)).toEqual(['0', '1', '2']);
    expect(result.regions[0].translatedText).toBe('左侧');
  });
  it('本地不可用时，手动模式报错且不会偷跑 API；自动模式允许回退', async () => {
    const { api, calls } = remote(), local = vi.fn(async () => { throw new Error('unavailable'); });
    const translator = createHybridTextTranslator(api, local);
    await expect(translator.translateRegions({ regions, config: { ...config, localTranslationMode: 'local' } })).rejects.toThrow('unavailable');
    expect(calls).not.toHaveBeenCalled();
    await translator.translateRegions({ regions, config: { ...config, localTranslationMode: 'auto' } });
    expect(calls.mock.calls[0][0].regions.map((r: TextTranslationRegion) => r.id)).toEqual(['0', '1']);
  });
  it('用户取消后不回退到 API', async () => {
    const { api, calls } = remote(), controller = new AbortController();
    const local = async () => { controller.abort(); throw new Error('cancelled'); };
    await expect(createHybridTextTranslator(api, local).translateRegions({ regions, config: { ...config, localTranslationMode: 'auto' }, signal: controller.signal })).rejects.toThrow();
    expect(calls).not.toHaveBeenCalled();
  });
  it('API 模式保持原有整批请求', async () => {
    const { api, calls } = remote(), local = vi.fn(async () => '');
    await createHybridTextTranslator(api, local).translateRegions({ regions, config });
    expect(local).not.toHaveBeenCalled(); expect(calls.mock.calls[0][0].regions).toEqual(regions);
    expect(isSimpleTranslation('LEFT')).toBe(true); expect(isSimpleTranslation('x'.repeat(101))).toBe(false);
  });
});
