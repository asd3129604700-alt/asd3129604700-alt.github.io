import { WEB_MODEL_PACKAGE } from './modelPackage';

export const isGitHubPagesBuild = import.meta.env.VITE_GITHUB_PAGES === 'true';
export const upstreamModelRelease = 'https://github.com/DonutShinobu/ShinobuTranslator/releases/tag/models-v0.8.3';
let selected: Map<string, File> | undefined;

export function selectLocalModels(files: File[]): void {
  const next = new Map<string, File>();
  for (const asset of WEB_MODEL_PACKAGE.assets) {
    const matches = files.filter(file => file.name === asset.path);
    if (matches.length !== 1) throw new Error(`请选择一份 ${asset.path}，需要同时选择全部 5 个模型文件。`);
    if (matches[0].size !== asset.size) throw new Error(`${asset.path} 文件大小不符，请下载固定版本 models-v0.8.3。`);
    next.set(asset.url, matches[0]);
  }
  selected = next;
}

export function takeLocalModelFetch(): typeof fetch | undefined {
  const files = selected;
  selected = undefined;
  if (!files) {
    if (isGitHubPagesBuild) throw new Error('请先从上游下载模型，然后选择「导入模型文件」。');
    return undefined;
  }
  return async (input, options) => {
    options?.signal?.throwIfAborted();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const file = files.get(url);
    if (!file) throw new Error('所选文件未包含请求的模型。');
    // 返回完整文件，让原安装器处理断点覆盖、大小和 SHA-256 校验。
    return new Response(file, { status: 200, headers: { 'Content-Length': String(file.size) } });
  };
}
