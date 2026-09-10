// Synthetic indexed-DASH fixture. Not captured from the reporter's session.
export const root = 'https://vod.pplus.paramount.tech/intl_vms/example/asset_cenc_fmp4_dash/';
export const manifestUrl = 'https://www.paramountplus.com/example/manifest.mpd';
export function rendition(height, { name = 'EXAMPLE_SHOW', codec = 'avc1.640028', extra = '', base = root, id = String(height) } = {}) {
  return `<Representation id="${id}" height="${height}" width="1920" bandwidth="${height * 5000}" codecs="${codec}">
    <BaseURL>${base}${name}_c24_${height}p_asset_${height === 540 ? 2000 : 5400}.mp4</BaseURL>
    <SegmentBase indexRange="1000-1499"><Initialization range="0-999" /></SegmentBase>${extra}
  </Representation>`;
}
export function manifest({ representations = rendition(540) + rendition(1080), extra = '', type = 'static' } = {}) {
  return `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="${type}">
    <Period id="0"><AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="original-key"/>${representations}</AdaptationSet>
      <AdaptationSet contentType="audio"><Representation id="audio"><BaseURL>audio.mp4</BaseURL></Representation></AdaptationSet>
      <AdaptationSet contentType="text"><Representation id="captions"><BaseURL>captions.vtt</BaseURL></Representation></AdaptationSet>
    </Period>${extra}</MPD>`;
}
