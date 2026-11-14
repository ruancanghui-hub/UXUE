import { net } from 'electron';

/**
 * 主进程对外请求统一走 Electron 的 net.fetch：它用 Chromium 的网络栈，会读系统代理设置；
 * Node 自带的 fetch 不走系统代理，开着代理软件或在海外时容易直接连不上。
 * 网络层失败时把"哪一步、哪个域名、什么原因"写进错误信息，方便判断是提交请求还是下载结果出的问题。
 */
export async function httpFetch(step: string, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await net.fetch(url, init);
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    const host = safeHost(url);
    const cause = error instanceof Error ? describeCause(error) : String(error);
    throw new Error(`${step}失败（连不上 ${host}：${cause}）`);
  }
}

function describeCause(error: Error): string {
  const nested = (error as Error & { cause?: unknown }).cause;
  const code = nested && typeof nested === 'object' && 'code' in nested ? String((nested as { code: unknown }).code) : '';
  const message = nested instanceof Error ? nested.message : error.message;
  return [code, message].filter(Boolean).join(' ') || '网络错误';
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}
