/**
 * 按提供商拉取"账号里真实可用的模型列表"。
 *
 * 各家的 OpenAI 兼容端点都提供 `GET {baseUrl}/models`，返回 `{ data: [{ id }] }`；
 * 少数实现返回 `{ models: [...] }` 或 `{ data: { models: [...] } }`，这里都兼容一下。
 *
 * 为什么要这个：界面上原来那份模型候选是项目里写死的目录，和账号里实际开通的模型
 * 未必一致 —— 拉一次就知道到底能用哪些。
 */

export type ModelFetchResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string };

/** baseUrl 可能被填成 ".../v1"、".../v1/"、甚至 ".../v1/chat/completions"，都归一化到 /models */
export function buildModelsUrl(baseUrl: string): string | null {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/u, '');
  if (!trimmed) return null;
  const chatSuffix = /\/chat\/completions$/iu;
  const base = chatSuffix.test(trimmed) ? trimmed.replace(chatSuffix, '') : trimmed;
  return `${base}/models`;
}

export function extractModelIds(payload: unknown): string[] {
  const fromList = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          const id = record.id ?? record.name ?? record.model;
          return typeof id === 'string' ? id : null;
        }
        return null;
      })
      .filter((id): id is string => Boolean(id));
  };

  if (Array.isArray(payload)) return fromList(payload);
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const direct = fromList(record.data) || [];
    if (direct.length) return direct;
    const nested = fromList(record.models);
    if (nested.length) return nested;
    if (record.data && typeof record.data === 'object') {
      const inner = fromList((record.data as Record<string, unknown>).models);
      if (inner.length) return inner;
    }
  }
  return [];
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fetchProviderModels(input: {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<ModelFetchResult> {
  const url = buildModelsUrl(input.baseUrl);
  if (!url) return { ok: false, error: 'Base URL 为空' };
  if (!input.apiKey.trim()) return { ok: false, error: 'API Key 为空' };

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.apiKey.trim()}`,
        Accept: 'application/json',
      },
      signal: input.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body.trim().slice(0, 160);
      return {
        ok: false,
        error: `HTTP ${response.status}${detail ? `：${detail}` : ''}`,
      };
    }
    const payload: unknown = await response.json();
    const models = extractModelIds(payload);
    if (models.length === 0) return { ok: false, error: '返回里没有找到模型 id' };
    return { ok: true, models: Array.from(new Set(models)).sort() };
  } catch (error) {
    return { ok: false, error: messageFor(error) };
  }
}
