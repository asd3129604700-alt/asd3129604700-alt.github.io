import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// pdf.js 自 5.x 起不再用 eval 编译字体代码（v6 连 isEvalSupported 选项都删了），
// 所以本项目的 CSP 不需要为此开 'unsafe-eval'。但 worker 必须指向本地打包出来的
// 文件（默认走 CDN，会被 CSP 的 script-src 'self' 拦掉）。
GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfImportLimits = {
  maxPages: number;
  targetLongEdge: number;
  maxLongEdge: number;
  maxPixels: number;
};

export const PDF_IMPORT_LIMITS: Readonly<PdfImportLimits> = {
  maxPages: 100,
  targetLongEdge: 3_000,
  maxLongEdge: 8_192,
  maxPixels: 40_000_000,
};

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/iu.test(file.name);
}

export type PdfExpansion = {
  files: File[];
  notes: string[];
};

function pageFileName(pdfName: string, pageNumber: number): string {
  const base = pdfName.replace(/\.pdf$/iu, '');
  return `${base}-p${String(pageNumber).padStart(3, '0')}.png`;
}

function planScale(
  baseWidth: number,
  baseHeight: number,
  limits: Readonly<PdfImportLimits>,
): number {
  const longEdge = Math.max(baseWidth, baseHeight);
  const byLongEdge = limits.targetLongEdge / longEdge;
  const byMaxLongEdge = limits.maxLongEdge / longEdge;
  const byPixels = Math.sqrt(limits.maxPixels / (baseWidth * baseHeight));
  const cap = Math.min(byMaxLongEdge, byPixels);
  return Math.max(0.1, Math.min(byLongEdge, cap));
}

async function renderPageToPng(page: PDFPageProxy, scale: number): Promise<Blob> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('canvas-2d-unavailable');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/png');
  });
  if (!blob) throw new Error('png-encode-failed');
  return blob;
}

export async function expandPdfToImageFiles(
  file: File,
  limits: Readonly<PdfImportLimits> = PDF_IMPORT_LIMITS,
): Promise<PdfExpansion> {
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = getDocument({ data });
  const document_ = await loadingTask.promise;
  const notes: string[] = [];
  const files: File[] = [];

  try {
    if (document_.numPages > limits.maxPages) {
      notes.push(
        `${file.name}：共 ${document_.numPages} 页，本次只导入前 ${limits.maxPages} 页`,
      );
    }
    const pageCount = Math.min(document_.numPages, limits.maxPages);

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document_.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const blob = await renderPageToPng(page, planScale(base.width, base.height, limits));
      files.push(
        new File([blob], pageFileName(file.name, pageNumber), {
          type: 'image/png',
          lastModified: file.lastModified,
        }),
      );
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  return { files, notes };
}
