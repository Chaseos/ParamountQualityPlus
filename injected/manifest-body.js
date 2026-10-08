const MAX_BYTES = 2 * 1024 * 1024;

export async function readBoundedManifest(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new Error('manifest-too-large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('unsupported-body');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      if (signal.aborted) throw new Error('cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { cancel(); throw new Error('manifest-too-large'); }
      text += decoder.decode(value, { stream: true });
    }
    if (signal.aborted) throw new Error('cancelled');
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
