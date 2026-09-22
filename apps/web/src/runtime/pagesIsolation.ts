/** GitHub Pages 无法自定义响应头；先让本站 Service Worker 接管，再启动 OCR。 */
export async function preparePagesIsolation(): Promise<boolean> {
  if (globalThis.crossOriginIsolated) {
    sessionStorage.removeItem('shinobu-pages-isolation-reloaded');
    return true;
  }
  if (!('serviceWorker' in navigator)) throw new Error('此浏览器不支持运行环境初始化，请使用桌面 Chrome / Edge。');
  if (sessionStorage.getItem('shinobu-pages-isolation-reloaded')) {
    throw new Error('浏览器未启用跨源隔离。请关闭隐私模式或限制本站的扩展后重新打开网页。');
  }
  const controlled = new Promise<void>((resolve, reject) => {
    const complete = (): void => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', complete); resolve(); };
    const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', complete); reject(new Error('初始化超时，请刷新重试。')); }, 20000);
    navigator.serviceWorker.addEventListener('controllerchange', complete);
    if (navigator.serviceWorker.controller) complete();
  });
  await Promise.all([navigator.serviceWorker.register('/sw.js', { scope: '/' }), controlled]);
  sessionStorage.setItem('shinobu-pages-isolation-reloaded', '1');
  window.location.reload();
  return false;
}
