import { describe, expect, it, vi } from 'vitest';
import type { WorkerClientEndpoint, WorkerHostEndpoint } from '@shinobu/browser-runtime';
import { attachLocalTranslationBridge, requestLocalTranslation } from '../../apps/web/src/runtime/localTranslationBridge';
import { translateLocally } from '../../apps/web/src/runtime/localTranslation';
vi.mock('../../apps/web/src/runtime/localTranslation', () => ({ translateLocally: vi.fn() }));

function pair() {
  type Listener = (event: { data: unknown }) => void;
  const main = new Set<Listener>(), worker = new Set<Listener>();
  const endpoint = (own: Set<Listener>, other: Set<Listener>) => ({
    postMessage(data: unknown) { for (const listener of other) listener({ data }); },
    addEventListener(_type: string, listener: Listener) { own.add(listener); },
    removeEventListener(_type: string, listener: Listener) { own.delete(listener); },
    terminate() {},
  });
  return { client: endpoint(main, worker) as WorkerClientEndpoint,
    host: endpoint(worker, main) as WorkerHostEndpoint, worker };
}

describe('浏览器主线程与 OCR worker 的本地翻译通信', () => {
  it('并发请求按 ID 返回各自结果，完成后移除监听器', async () => {
    vi.mocked(translateLocally).mockImplementation(async text => `译:${text}`);
    const { client, host, worker } = pair(), release = attachLocalTranslationBridge(client);
    expect(await Promise.all([requestLocalTranslation(host, 'LEFT', 'zh-CHS'), requestLocalTranslation(host, 'TOP', 'zh-CHS')])).toEqual(['译:LEFT', '译:TOP']);
    expect(worker.size).toBe(0); release();
  });
  it('把本地失败传回 worker，并清理监听器', async () => {
    vi.mocked(translateLocally).mockRejectedValue(new Error('语言包未准备'));
    const { client, host, worker } = pair(), release = attachLocalTranslationBridge(client);
    await expect(requestLocalTranslation(host, 'LEFT', 'zh-CHS')).rejects.toThrow('语言包未准备');
    expect(worker.size).toBe(0); release();
  });
  it('取消请求同时中止主线程翻译', async () => {
    let nativeSignal: AbortSignal | undefined;
    vi.mocked(translateLocally).mockImplementation((_text, _target, signal) => {
      nativeSignal = signal;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    });
    const { client, host, worker } = pair(), release = attachLocalTranslationBridge(client);
    const controller = new AbortController();
    const pending = requestLocalTranslation(host, 'LEFT', 'zh-CHS', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(nativeSignal?.aborted).toBe(true); expect(worker.size).toBe(0); release();
  });
});
