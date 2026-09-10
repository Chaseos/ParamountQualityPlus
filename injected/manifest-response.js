// Body replacement is isolated from stream selection. Nonmatching responses
// retain their native body, headers and identity.
const bodyHeaders = new Set(['content-length', 'content-encoding', 'etag', 'content-md5', 'digest']);

export function replaceManifestResponse(response, text) {
  const headers = new Headers(response.headers);
  for (const name of bodyHeaders) headers.delete(name);
  const wrap = body => {
    const replacement = new Response(body, { status: response.status, statusText: response.statusText, headers });
    for (const key of ['url', 'redirected', 'type']) Object.defineProperty(replacement, key, { value: response[key] });
    const clone = replacement.clone.bind(replacement);
    Object.defineProperty(replacement, 'clone', { value: () => {
      const copy = clone();
      return wrap(copy.body);
    } });
    return replacement;
  };
  return wrap(text);
}

// Accessors ensure even a handler registered before open() sees the selected
// manifest. Native XHR still owns networking, headers, event order and aborts.
export function installManifestXhrView(xhr, transform) {
  xhr._pqi_restoreManifestView?.();
  const originals = new Map();
  const readers = {};
  for (const key of ['responseText', 'response', 'responseXML']) {
    let proto = xhr;
    let descriptor;
    while (proto && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(proto, key);
      proto = Object.getPrototypeOf(proto);
    }
    if (!descriptor?.get) return false;
    readers[key] = () => descriptor.get.call(xhr);
  }
  const header = xhr.getResponseHeader.bind(xhr);
  const allHeaders = xhr.getAllResponseHeaders.bind(xhr);
  let resolved = false;
  let result = null;
  let xml = null;
  const resolve = () => {
    if (resolved || xhr.readyState !== 4) return;
    resolved = true;
    if (xhr.status < 200 || xhr.status >= 300 || !['', 'text', 'document'].includes(xhr.responseType || '')) return;
    const type = header('content-type') || '';
    if (!/\.mpd(?:$|\?)/i.test(xhr._pqi_url || '') && !type.includes('dash+xml')) return;
    const documentResponse = xhr.responseType === 'document';
    const native = documentResponse ? readers.responseXML() : readers.responseText();
    if (!native) return;
    const text = documentResponse ? new XMLSerializer().serializeToString(native) : native;
    result = transform(text);
    if (result !== null) xml = new DOMParser().parseFromString(result, 'application/xml');
  };
  const restore = () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(xhr, key, descriptor);
      else delete xhr[key];
    }
    delete xhr._pqi_restoreManifestView;
  };
  const define = (key, descriptor) => {
    originals.set(key, Object.getOwnPropertyDescriptor(xhr, key));
    Object.defineProperty(xhr, key, { configurable: true, ...descriptor });
  };
  try {
    for (const key of Object.keys(readers)) define(key, { get() {
      resolve();
      if (result === null) return readers[key]();
      if (key === 'responseText') {
        if (xhr.responseType === 'document') return readers[key](); // Native InvalidStateError.
        return result;
      }
      if (key === 'responseXML') return xhr.responseType === 'text' ? readers[key]() : xml;
      return xhr.responseType === 'document' ? xml : result;
    } });
    define('getResponseHeader', { value(name) {
      resolve();
      return result !== null && bodyHeaders.has(String(name).toLowerCase()) ? null : header(name);
    } });
    define('getAllResponseHeaders', { value() {
      resolve();
      const value = allHeaders();
      return result === null ? value : value.split(/\r?\n/).filter(line => !bodyHeaders.has(line.split(':')[0].toLowerCase())).join('\r\n');
    } });
    xhr._pqi_restoreManifestView = restore;
    return true;
  } catch {
    restore();
    return false;
  }
}
