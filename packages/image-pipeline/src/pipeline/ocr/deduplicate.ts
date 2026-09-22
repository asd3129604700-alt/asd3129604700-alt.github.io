import type { TextRegion } from '../../types';

const normalized = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** 识别之后再以文字和位置共同去重，避免高度不同的完整行/碎片重复翻译贴字。 */
export function deduplicateEnglishOcr(regions: TextRegion[]): TextRegion[] {
  const kept: TextRegion[] = [];
  const sorted = [...regions].sort((a, b) => normalized(b.sourceText).length - normalized(a.sourceText).length
    || (b.prob ?? 0) - (a.prob ?? 0));
  for (const candidate of sorted) {
    const text = normalized(candidate.sourceText);
    const duplicate = text.length >= 3 && kept.some(existing => {
      if (!normalized(existing.sourceText).includes(text)) return false;
      const a = existing.box, b = candidate.box;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      return overlapX >= b.width * 0.8 && overlapY >= Math.min(a.height, b.height) * 0.8
        && Math.abs(a.y + a.height / 2 - b.y - b.height / 2) <= Math.max(a.height, b.height) * 0.35;
    });
    if (!duplicate) kept.push(candidate);
  }
  const ids = new Set(kept.map(region => region.id));
  return regions.filter(region => ids.has(region.id));
}
