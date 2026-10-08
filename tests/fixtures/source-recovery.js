// Synthetic SDK/source-profile fixture, not a reporter-session capture.
export const hdKey = '12345678123412341234123456789abc';
export const sdKey = 'abcdefabcdefabcdefabcdefabcdefab';
export const url = 'https://pubads.g.doubleclick.net/ondemand/dash/content/222/vid/episode/CHS/streams/session/manifest.mpd?token=SECRET';
export const catalog = 'https://vod.pplus.paramount.tech/intl_vms/example/asset/normal_cenc_dash/stream.mpd?catalog=SECRET';
export const indexedXml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="static"><Period id="0"><AdaptationSet contentType="video">
${[540,1080].map(height => `<Representation id="${height}" height="${height}" width="1920" bandwidth="${height*5000}" codecs="avc1.640028">
<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="${height===1080?hdKey:sdKey}"/>
<BaseURL>https://vod.pplus.paramount.tech/intl_vms/example/asset/indexed_cenc_fmp4_dash/program_${height}p.mp4</BaseURL>
<SegmentBase indexRange="100-199"><Initialization range="0-99"/></SegmentBase></Representation>`).join('')}
</AdaptationSet></Period></MPD>`;
export const failure = { code:'2103', fatal:true, cause:{ code:4012, category:4,
  data:[{ missingKeys:[hdKey], hasAppRestrictions:false, restrictedKeyStatuses:[] }] } };
