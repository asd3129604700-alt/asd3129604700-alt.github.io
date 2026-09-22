import { describe, expect, it } from 'vitest';
import { createDefaultWebSettings } from '../../packages/shared-config/src';
import { toWebPipelineConfig } from '../../apps/web/src/runtime/webPipelineConfig';
import { isLocalPipelineClientMessage } from '../../packages/image-pipeline/src/protocol';

describe('Web pipeline configuration Adapter', () => {
  it.each(['local', 'auto'] as const)('preserves %s through the worker protocol', translationMode => {
    const config = toWebPipelineConfig({ ...createDefaultWebSettings('zh-CN'), translationMode });
    const message = { type: 'start', jobId: 'local-test', config,
      file: { name: 'source.png', type: 'image/png', size: 1, lastModified: 1 }, input: { chunkCount: 1, totalChars: 4 } };
    expect(config.localTranslationMode).toBe(translationMode);
    expect(isLocalPipelineClientMessage(message)).toBe(true);
    expect(isLocalPipelineClientMessage({ ...message, config: { ...config, localTranslationMode: 'invalid' } })).toBe(false);
  });
  it('maps result semantics without placing the session key in task config', () => {
    const settings = createDefaultWebSettings('zh-CN');
    settings.translationProviderId = 'custom';
    settings.providerProfiles.custom = {
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-model',
    };

    const config = toWebPipelineConfig(settings);
    expect(config).toMatchObject({
      sourceLang: 'en',
      targetLang: 'zh-CHS',
      translator: 'llm',
      llmProvider: 'custom',
      llmAuthMode: 'api_key',
      llmBaseUrl: 'http://localhost:11434/v1',
      llmModel: 'local-model',
      llmUseCustomModel: true,
      processMode: 'translate',
    });
    expect(config).not.toHaveProperty('llmApiKey');
    expect(JSON.stringify(config)).not.toContain('session-secret');
  });
});
