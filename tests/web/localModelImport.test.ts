import { describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/web/src/runtime/modelPackage', () => ({ WEB_MODEL_PACKAGE: { assets: [
  { path: 'one.onnx', url: '/models/one.onnx', size: 3 },
  { path: 'dict.txt', url: '/models/dict.txt', size: 2 },
] } }));
import { selectLocalModels, takeLocalModelFetch } from '../../apps/web/src/runtime/localModelImport';

describe('手动导入上游模型', () => {
  const files = () => [new File(['abc'], 'one.onnx'), new File(['de'], 'dict.txt')];
  it('拒绝缺失、重复及大小不符的文件', () => {
    expect(() => selectLocalModels([])).toThrow('one.onnx');
    expect(() => selectLocalModels([...files(), files()[0]])).toThrow('one.onnx');
    expect(() => selectLocalModels([new File(['x'], 'one.onnx'), files()[1]])).toThrow('大小不符');
  });
  it('从选择的文件读取，完整响应交给既有安装器做 SHA-256 校验', async () => {
    selectLocalModels(files());
    const read = takeLocalModelFetch()!;
    const response = await read('/models/one.onnx', { headers: { Range: 'bytes=1-' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('abc');
    await expect(read('/models/unselected.onnx')).rejects.toThrow('未包含');
    expect(takeLocalModelFetch()).toBeUndefined();
  });
  it('取消时不继续读取文件', async () => {
    selectLocalModels(files());
    const read = takeLocalModelFetch()!, controller = new AbortController();
    controller.abort();
    await expect(read('/models/one.onnx', { signal: controller.signal })).rejects.toThrow();
  });
});
