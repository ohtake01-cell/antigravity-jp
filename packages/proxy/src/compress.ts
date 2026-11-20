/**
 * 軽量・高速 HTTP Gzip 圧縮ミドルウェア（Node.js 標準 node:zlib のみ使用）
 *
 * - Accept-Encoding に gzip が含まれる場合のみ有効
 * - 1KB 未満、既に Content-Encoding 付き、またはバイナリ/画像/SSE は素通り
 * - level: 4 は圧縮率と CPU レイテンシ（1〜3ms）の最適バランス
 */

import type { MiddlewareHandler } from "hono";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

const MIN_COMPRESS_BYTES = 1024;
const COMPRESSIBLE_RE =
  /^(?:application\/(?:json|javascript|xml|x-javascript)|text\/|image\/svg\+xml)/i;

export function gzipMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    const acceptEncoding = c.req.header("accept-encoding") ?? "";
    if (!/\bgzip\b/i.test(acceptEncoding)) return;

    const res = c.res;
    if (!res || !res.body) return;
    if (res.status < 200 || res.status === 204 || res.status === 304) return;
    if (res.headers.has("content-encoding")) return;

    const contentType = res.headers.get("content-type") ?? "";
    if (!COMPRESSIBLE_RE.test(contentType)) return;
    if (/text\/event-stream/i.test(contentType)) return;

    const rawBuf = Buffer.from(await res.arrayBuffer());
    if (rawBuf.byteLength < MIN_COMPRESS_BYTES) {
      const passthroughHeaders = new Headers(res.headers);
      c.res = new Response(rawBuf, {
        status: res.status,
        statusText: res.statusText,
        headers: passthroughHeaders,
      });
      return;
    }

    const compressed = await gzipAsync(rawBuf, { level: 4 });
    const headers = new Headers(res.headers);
    headers.set("content-encoding", "gzip");
    headers.set("content-length", String(compressed.byteLength));
    const existingVary = headers.get("vary");
    if (!existingVary) {
      headers.set("vary", "Accept-Encoding");
    } else if (!/\baccept-encoding\b/i.test(existingVary)) {
      headers.set("vary", `${existingVary}, Accept-Encoding`);
    }

    c.res = new Response(compressed, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}
