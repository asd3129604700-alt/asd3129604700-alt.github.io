import type { WorkerClientEndpoint, WorkerHostEndpoint } from '@shinobu/browser-runtime';
import { translateLocally } from './localTranslation';

const channel = 'shinobu-local-translation';
type BridgeMessage = { channel: typeof channel; id: string; kind: 'request' | 'result' | 'cancel'; text?: string; target?: string; error?: string };
function message(value: unknown): value is BridgeMessage {
  return !!value && typeof value === 'object' && (value as BridgeMessage).channel === channel
    && typeof (value as BridgeMessage).id === 'string';
}

export function attachLocalTranslationBridge(worker: WorkerClientEndpoint): () => void {
  const active = new Map<string, AbortController>();
  const listener = ({ data }: { data: unknown }): void => {
    if (!message(data)) return;
    if (data.kind === 'cancel') { active.get(data.id)?.abort(); return; }
    if (data.kind !== 'request' || typeof data.text !== 'string' || typeof data.target !== 'string') return;
    const controller = new AbortController(); active.set(data.id, controller);
    void translateLocally(data.text, data.target, controller.signal).then(
      text => { if (!controller.signal.aborted) worker.postMessage({ channel, kind: 'result', id: data.id, text }); },
      error => { if (!controller.signal.aborted) worker.postMessage({ channel, kind: 'result', id: data.id, error: error instanceof Error ? error.message : String(error) }); },
    ).finally(() => active.delete(data.id));
  };
  worker.addEventListener('message', listener);
  return () => { worker.removeEventListener('message', listener); for (const c of active.values()) c.abort(); active.clear(); };
}

export function requestLocalTranslation(endpoint: WorkerHostEndpoint, text: string, target: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cleanup = (): void => { endpoint.removeEventListener('message', listener); signal?.removeEventListener('abort', abort); };
    const abort = (): void => { cleanup(); endpoint.postMessage({ channel, kind: 'cancel', id }); reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError')); };
    const listener = ({ data }: { data: unknown }): void => {
      if (!message(data) || data.kind !== 'result' || data.id !== id) return;
      cleanup();
      if (typeof data.error === 'string') reject(new Error(data.error));
      else if (typeof data.text === 'string') resolve(data.text);
      else reject(new Error('本地翻译返回格式错误'));
    };
    endpoint.addEventListener('message', listener); signal?.addEventListener('abort', abort, { once: true });
    endpoint.postMessage({ channel, kind: 'request', id, text, target });
  });
}
