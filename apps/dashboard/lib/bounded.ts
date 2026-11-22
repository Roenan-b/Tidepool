/**
 * Reads a byte stream as UTF-8 text but stops (and cancels the stream) once it exceeds a limit, so an
 * oversized or chunked body without Content-Length cannot be buffered into memory in full.
 */
export type BoundedText = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'read_error' };

export async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<BoundedText> {
  if (!body) return { ok: true, text: '' };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'read_error' };
  } finally {
    reader.releaseLock();
  }
  return { ok: true, text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)) };
}
