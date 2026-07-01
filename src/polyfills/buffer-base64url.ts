/**
 * Teach the browser `Buffer` polyfill the `base64url` encoding.
 *
 * `@ar.io/sdk/solana`'s `deriveRecipientId` (used by `canonicalMessage`/
 * `canonicalMessageV2`) calls `Buffer.from(bytes).toString('base64url')`.
 * Node's native Buffer supports `base64url`, but the userland `buffer`
 * polyfill that `vite-plugin-node-polyfills` injects (feross/buffer) does
 * NOT — it throws `Unknown encoding: base64url`, crashing the claim page.
 *
 * `base64url` is just standard base64 with `+`→`-`, `/`→`_`, and no `=`
 * padding (RFC 4648 §5). We wrap the polyfill's `toString`/`write` and the
 * static `Buffer.from` to translate `base64url` to/from `base64`, leaving
 * every other encoding untouched. Imported first in `main.tsx` so the patch
 * is in place before any SDK code runs.
 */
import { Buffer } from 'buffer';

type AnyBuffer = typeof Buffer;

function base64ToUrl(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function urlToBase64(b64url: string): string {
  const s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  return pad ? s + '='.repeat(4 - pad) : s;
}

function isBase64Url(enc?: unknown): boolean {
  return typeof enc === 'string' && enc.toLowerCase() === 'base64url';
}

// Guard against double-patching (HMR / repeated imports).
const PATCHED = '__base64urlPatched__';
const proto = Buffer.prototype as unknown as Record<string, unknown>;

if (!proto[PATCHED]) {
  const originalToString = Buffer.prototype.toString;
  Buffer.prototype.toString = function patchedToString(
    this: Buffer,
    encoding?: string,
    start?: number,
    end?: number,
  ): string {
    if (isBase64Url(encoding)) {
      return base64ToUrl(originalToString.call(this, 'base64', start, end));
    }
    return originalToString.call(this, encoding as BufferEncoding, start, end);
  } as typeof Buffer.prototype.toString;

  const originalWrite = Buffer.prototype.write;
  Buffer.prototype.write = function patchedWrite(
    this: Buffer,
    string: string,
    ...rest: unknown[]
  ): number {
    // Find the encoding argument (it's the last string arg per Node's
    // overloads: write(string[, offset[, length]][, encoding])).
    const encIdx = rest.findIndex(isBase64Url);
    if (encIdx !== -1) {
      const fixed = [...rest];
      fixed[encIdx] = 'base64';
      return (originalWrite as (...a: unknown[]) => number).call(
        this,
        urlToBase64(string),
        ...fixed,
      );
    }
    return (originalWrite as (...a: unknown[]) => number).call(
      this,
      string,
      ...rest,
    );
  } as typeof Buffer.prototype.write;

  const originalFrom = Buffer.from.bind(Buffer) as AnyBuffer['from'];
  // Only the (string, encoding) overload needs translating.
  Buffer.from = function patchedFrom(
    this: unknown,
    value: unknown,
    encodingOrOffset?: unknown,
    length?: unknown,
  ): Buffer {
    if (typeof value === 'string' && isBase64Url(encodingOrOffset)) {
      return originalFrom(urlToBase64(value), 'base64');
    }
    return (originalFrom as (...a: unknown[]) => Buffer)(
      value,
      encodingOrOffset,
      length,
    );
  } as AnyBuffer['from'];

  Object.defineProperty(proto, PATCHED, {
    value: true,
    enumerable: false,
  });
}
