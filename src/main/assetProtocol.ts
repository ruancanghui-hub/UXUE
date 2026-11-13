import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { ASSET_SCHEME } from '../shared/bench';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** 必须在 app ready 之前调用。 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/**
 * `ue-asset://<host>/<相对路径>` 只能读取 roots 里登记过的目录，
 * 渲染进程拿不到任意文件的访问权。
 */
export function handleAssetProtocol(roots: Map<string, string>): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const url = new URL(request.url);
    const root = roots.get(url.host);
    if (!root) return new Response('unknown host', { status: 404 });

    const filePath = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!filePath.startsWith(root + sep)) return new Response('forbidden', { status: 403 });

    const mime = MIME_TYPES[extname(filePath).toLowerCase()];
    if (!mime) return new Response('unsupported type', { status: 415 });

    const file = await net.fetch(pathToFileURL(filePath).toString());
    if (!file.ok) return new Response('not found', { status: 404 });
    return new Response(file.body, {
      headers: { 'content-type': mime, 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    });
  });
}
