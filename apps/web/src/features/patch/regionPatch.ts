/**
 * 手动补翻：把用户框选的一块区域单独重跑一遍流水线，再合成回结果图。
 *
 * 为什么要单独裁一块跑：
 *   检测模型的输入写死 1024×1024，一张 5100×3300 的整图送进去等于缩到 0.2 倍，
 *   小字直接消失。用户手动框出来的那一小块单独送进去，检测器看到的是
 *   **被放大到 1024 的局部**，小字就认得出来了。
 *   实测（hololive-deco.jpg）：框住一块 9px 小字的区域单独跑，能稳定读出
 *   `4.5"`、`SCALE`、`jakks` 这些整图那遍读不出来的内容。
 *   另一个实测结论：**不需要我们再放大** —— 检测器的 letterbox 会把小块自动放大到
 *   1024，我们再放大 2× 结果完全一样（1× 与 2× 的 OCR 输出逐字相同），
 *   白花时间和内存。
 *
 * 所以这里的流程是：按**原始分辨率**裁 → 单独跑流水线 → 贴回结果图的同一位置。
 */

/**
 * 合并结果落地：存进浏览器自己的 OPFS 空间（应用本来就用它放模型和原图），
 * 这样刷新页面后「合并」视图还在，也能随时下载。
 *
 * 为什么不去改历史记录：历史里的 result 由批处理流水线写入，改它要动
 * processingBatch / workbench / 历史三处；而"补翻结果"是用户在成品图上再加工的
 * 产物，放在同一个站点存储里、按原图 id 归档，语义更清楚，也不影响流水线的记录。
 * 需要它进历史的导出 ZIP，告诉我再加。
 */
const MERGED_DIR = 'shinobu-merged-patches';

/**
 * 合并结果的存档键：用**文件指纹**（名字 + 大小 + 像素尺寸），不用 imageId。
 *
 * 为什么不用 id：刷新后队列要从历史恢复，克隆成新批次时 item id 会变，用 id 当键就对不上。
 * 为什么不用 lastModified：从历史恢复出来的 File 是重新包装的，lastModified 会变
 * （实测就是栽在这里），而名字、大小、尺寸都不变。
 */
export function mergedStorageKey(
  input: { name: string; size: number; width?: number; height?: number },
): string {
  const source = `${input.name}\u0000${input.size}\u0000${input.width ?? 0}x${input.height ?? 0}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function mergedDirectory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(MERGED_DIR, { create });
  } catch {
    return null;
  }
}

export async function saveMergedResult(key: string, blob: Blob): Promise<boolean> {
  const directory = await mergedDirectory(true);
  if (!directory) return false;
  try {
    const handle = await directory.getFileHandle(`${key}.png`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

export async function loadMergedResult(key: string): Promise<Blob | null> {
  const directory = await mergedDirectory(false);
  if (!directory) return null;
  try {
    const handle = await directory.getFileHandle(`${key}.png`);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function deleteMergedResult(key: string): Promise<void> {
  const directory = await mergedDirectory(false);
  if (!directory) return;
  try {
    await directory.removeEntry(`${key}.png`);
  } catch {
    /* 不存在就算了 */
  }
}

export type PatchRect = {
  /** 工作副本坐标系（与结果图同一坐标系） */
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 任何预览（原图或结果）都先映射到工作副本坐标，避免大图在原图页框选时二次放大。 */
export function selectionToWorkingRect(
  rect: PatchRect,
  display: { width: number; height: number },
  working: { width: number; height: number },
): PatchRect | null {
  if (display.width <= 0 || display.height <= 0) return null;
  const x = Math.max(0, Math.min(display.width, rect.x));
  const y = Math.max(0, Math.min(display.height, rect.y));
  const right = Math.max(x, Math.min(display.width, rect.x + rect.width));
  const bottom = Math.max(y, Math.min(display.height, rect.y + rect.height));
  if (right - x < 8 || bottom - y < 8) return null;
  return {
    x: x / display.width * working.width,
    y: y / display.height * working.height,
    width: (right - x) / display.width * working.width,
    height: (bottom - y) / display.height * working.height,
  };
}

export async function resultBlobForPatch(
  result: { resultBlob?: Blob; resultUrl?: string } | undefined,
): Promise<Blob | null> {
  if (result?.resultBlob) return result.resultBlob;
  if (!result?.resultUrl) return null;
  const response = await fetch(result.resultUrl);
  if (!response.ok) throw new Error('无法读取补翻合成所需的图片');
  return response.blob();
}

export type PatchRecord = {
  /** 补翻图在队列里的文件名（导入器会保留文件名，用它反查 imageId） */
  name: string;
  /** 被补翻的那张图的 id */
  parentId: string;
  /** 补翻区域（工作副本坐标） */
  rect: PatchRect;
  /** 建立时间，用于排序 */
  createdAt: number;
};

const STORAGE_KEY = 'shinobu:web-patches';

export function readPatchRecords(storage: Storage | undefined = safeStorage()): PatchRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PatchRecord => (
      Boolean(item)
      && typeof (item as PatchRecord).name === 'string'
      && typeof (item as PatchRecord).parentId === 'string'
      && typeof (item as PatchRecord).rect === 'object'
    ));
  } catch {
    return [];
  }
}

export function writePatchRecords(
  records: readonly PatchRecord[],
  storage: Storage | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    /* 隐私模式下写不进去，不影响本次会话（内存里还有一份） */
  }
}

export function addPatchRecord(
  record: PatchRecord,
  storage: Storage | undefined = safeStorage(),
): PatchRecord[] {
  const next = [...readPatchRecords(storage).filter((item) => item.name !== record.name), record];
  writePatchRecords(next, storage);
  return next;
}

export function removePatchRecords(
  names: readonly string[],
  storage: Storage | undefined = safeStorage(),
): PatchRecord[] {
  const drop = new Set(names);
  const next = readPatchRecords(storage).filter((item) => !drop.has(item.name));
  writePatchRecords(next, storage);
  return next;
}

/** 补翻图的文件名：带上父图 id 与序号，便于人肉识别，也便于反查 */
export function patchFileName(parentName: string, parentId: string, index: number): string {
  const base = parentName.replace(/\.[a-z0-9]+$/iu, '');
  return `${base}·补翻${index + 1}[${parentId.slice(0, 8)}].png`;
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

async function decode(source: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(source);
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('图片解码失败'));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function sizeOf(image: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  return image instanceof HTMLImageElement
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('画布导出失败'));
    }, 'image/png');
  });
}

/**
 * 从原图裁出一块，按**原始分辨率**输出（工作副本坐标 → 原始坐标由 sourceScale 换算）。
 *
 * 为什么按原始分辨率而不是工作副本分辨率：工作副本可能已经把原图缩小过
 * （比如 5100px 的图纸工作副本只有 0.6 倍），从原始文件裁能得到更清楚的像素，
 * 小字的识别率更好。
 */
export async function cropRegionForPatch(
  source: Blob,
  rect: PatchRect,
  sourceScale: number,
  options: { maxEdge?: number } = {},
): Promise<{ file: Blob; width: number; height: number }> {
  const image = await decode(source);
  const natural = sizeOf(image);
  const scale = sourceScale > 0 ? sourceScale : 1;

  // 工作副本坐标 → 原始坐标
  const x = Math.max(0, Math.min(natural.width - 1, Math.round(rect.x / scale)));
  const y = Math.max(0, Math.min(natural.height - 1, Math.round(rect.y / scale)));
  const sourceWidth = Math.max(1, Math.min(natural.width - x, Math.round(rect.width / scale)));
  const sourceHeight = Math.max(1, Math.min(natural.height - y, Math.round(rect.height / scale)));
  let width = sourceWidth;
  let height = sourceHeight;

  // 太大的选区不裁那么大：检测器反正只吃 1024，太大只会更慢
  const maxEdge = options.maxEdge ?? 2048;
  const longEdge = Math.max(width, height);
  if (longEdge > maxEdge) {
    const k = maxEdge / longEdge;
    width = Math.max(1, Math.round(width * k));
    height = Math.max(1, Math.round(height * k));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建裁剪画布');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image as CanvasImageSource, x, y, sourceWidth, sourceHeight, 0, 0, width, height);
  if ('close' in image && typeof image.close === 'function') image.close();

  return { file: await toBlob(canvas), width, height };
}

/**
 * 把补翻结果贴回整图结果的对应位置。
 *
 * 补翻图是以"选区放大后的尺寸"跑出来的，它的坐标是相对选区自己的；
 * 贴回去时按 rect 的宽高等比缩放，位置与第一版严格对齐。
 */
export async function composePatchOntoResult(
  base: Blob,
  patch: Blob,
  rect: PatchRect,
): Promise<Blob> {
  const [baseImage, patchImage] = await Promise.all([decode(base), decode(patch)]);
  const baseSize = sizeOf(baseImage);

  const canvas = document.createElement('canvas');
  canvas.width = baseSize.width;
  canvas.height = baseSize.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建合成画布');
  context.drawImage(baseImage as CanvasImageSource, 0, 0);

  const dx = Math.max(0, Math.round(rect.x));
  const dy = Math.max(0, Math.round(rect.y));
  const dw = Math.max(1, Math.round(rect.width));
  const dh = Math.max(1, Math.round(rect.height));
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(patchImage as CanvasImageSource, 0, 0, sizeOf(patchImage).width, sizeOf(patchImage).height, dx, dy, dw, dh);

  if ('close' in baseImage && typeof baseImage.close === 'function') baseImage.close();
  if ('close' in patchImage && typeof patchImage.close === 'function') patchImage.close();

  return toBlob(canvas);
}
