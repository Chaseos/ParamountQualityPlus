// Safari's native HLS loader bypasses fetch/XHR. Keep the publisher's master
// metadata and alternate tracks when limiting it to manifest-selected URLs.
export function createNativeMaster(master, masterURL, representation) {
    if (!master.trimStart().startsWith('#EXTM3U') || master.length > 1024 * 1024 ||
        /#EXT-X-(?:DEFINE|CONTENT-STEERING):/.test(master)) {
        throw new Error('Unsupported native master');
    }
    const variants = representation.variants?.length ? representation.variants : [representation];
    const selected = new Set(variants.map(variant => variant.request?.variantUrl || variant.variantUrl));
    const absolute = uri => {
        const url = new URL(uri, masterURL);
        if (!['https:', 'skd:', 'data:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('Unsupported master URI');
        }
        return url.href;
    };
    const output = [];
    let pending = null;
    let retained = 0;
    for (const raw of master.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            if (pending !== null) throw new Error('Missing variant URI');
            pending = line;
        } else if (line && !line.startsWith('#')) {
            if (pending === null) throw new Error('Expected a multivariant playlist');
            const uri = absolute(line);
            if (selected.has(uri)) {
                output.push(pending, uri);
                retained++;
            }
            pending = null;
        } else {
            output.push(line.replace(/([:,])URI="([^"]+)"/g,
                (_match, separator, uri) => `${separator}URI="${absolute(uri)}"`));
        }
    }
    if (pending !== null || !retained) throw new Error('Selected rendition is absent');
    const bytes = new TextEncoder().encode(output.join('\n'));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    // A Blob master failed in native Safari; a data master retained FairPlay,
    // audio and subtitles in real full-episode testing. Never log this URL.
    return 'data:application/vnd.apple.mpegurl;base64,' + btoa(binary);
}
