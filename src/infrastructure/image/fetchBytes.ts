/**
 * Downloads an image a search result pointed at.
 *
 * Not `SafeHttpClient`: that guard exists because *callers* supply URLs and the
 * workers sit next to Redis on an internal network. These URLs come from a
 * vendor API we authenticated to, over TLS, and they are CDN hosts — the SSRF
 * threat model does not apply, and its DNS pinning would break the CDNs' own
 * redirect chains.
 *
 * What does apply is size: a stock library will happily serve a 12MB original,
 * and the response is read into memory before `sharp` ever sees it. The cap is
 * enforced while streaming rather than from `content-length`, which a server is
 * free to lie about or omit.
 */
const MAX_BYTES = 12 * 1024 * 1024;

export async function fetchImageBytes(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { accept: 'image/*' },
  });

  if (!response.ok) throw new Error(`Image download failed: ${response.status} ${url}`);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of streamOf(response)) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new Error(`Image at ${url} exceeds ${MAX_BYTES} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function* streamOf(response: Response): AsyncGenerator<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield Buffer.from(value);
  }
}
