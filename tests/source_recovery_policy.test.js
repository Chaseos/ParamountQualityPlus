import { test, expect } from '@jest/globals';
import { readDashRepresentations } from '../injected/manifest-parser.js';
import { canRestoreProgramPause, chooseRecoverySource, createSourceRecoveryClock,
  indexedProgramEvidence, missingKeyFailure, programSession } from '../injected/source-recovery-policy.js';
import { sourceRecoverySupported } from '../injected/source-recovery.js';
import { catalog, failure, hdKey, indexedXml, sdKey, url } from './fixtures/source-recovery.js';

const context = () => ({ session:programSession(url),sourceId:'222',videoId:'episode',declaredSourceId:'111',catalogUrl:catalog,
  selection:{height:1080}, failure:missingKeyFailure(failure), contentTime:0,hasProgramPlayback:false,isAd:false,
  evidence:indexedProgramEvidence(readDashRepresentations(indexedXml,url),1080,[hdKey]) });
test('only a selected program HD key and a same-asset declared source qualify', () => {
  expect(chooseRecoverySource(context())).toMatchObject({sourceId:'111',targetHeight:1080,startup:true,catalogUrl:catalog});
  for (const change of [{evidence:{matched:false,paths:[]}}, {selection:{height:540}}, {sourceId:'333'}, {videoId:'other'},
    {declaredSourceId:'222'}, {catalogUrl:catalog.replace('/asset/','/other/')}, {catalogUrl:catalog.replace('vod.pplus.paramount.tech','elsewhere.test')}])
    expect(chooseRecoverySource({...context(),...change})).toBeNull();
});
test('ad or unknown status qualifies only for zero-position startup; later ad failures do not qualify', () => {
  for (const isAd of [true,null]) {
    expect(chooseRecoverySource({...context(),isAd})).not.toBeNull();
    expect(chooseRecoverySource({...context(),isAd,contentTime:4})).toBeNull();
    expect(chooseRecoverySource({...context(),isAd,hasProgramPlayback:true})).toBeNull();
  }
});
test('application, output, non-key and malformed-key failures remain with existing recovery', () => {
  for (const restrictions of [{hasAppRestrictions:true}, {restrictedKeyStatuses:['output-restricted']},
    {restrictedKeyStatuses:['internal-error']}, {missingKeys:[]}, {missingKeys:['invalid']}])
    expect(missingKeyFailure({...failure,cause:{...failure.cause,data:[{...failure.cause.data[0],...restrictions}]}})).toBeNull();
  expect(missingKeyFailure({...failure,fatal:false})).toBeNull();
  expect(missingKeyFailure({...failure,cause:{...failure.cause,code:3005}})).toBeNull();
});
test('SD, audio, ad, and inherited overridden keys cannot prove the selected HD program key', () => {
  const reps=readDashRepresentations(indexedXml,url);
  expect(indexedProgramEvidence(reps,1080,[sdKey]).matched).toBe(false);
  expect(indexedProgramEvidence(reps,720,[hdKey]).matched).toBe(false);
  const audioOrAd=indexedXml.replace('contentType="video"','contentType="audio"');
  expect(indexedProgramEvidence(readDashRepresentations(audioOrAd,url),1080,[hdKey]).matched).toBe(false);
  expect(indexedProgramEvidence(readDashRepresentations(indexedXml.replace('id="0"','id="pre-roll-1-ad-1"'),url),1080,[hdKey]).matched).toBe(false);
  const inherited=indexedXml.replace('<AdaptationSet contentType="video">',`<AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="${sdKey}"/>`);
  expect(indexedProgramEvidence(readDashRepresentations(inherited,url),1080,[sdKey]).matched).toBe(false);
});
test('long confirmed ads are excluded from the program allowance, with a bounded total deadline', () => {
  const clock=createSourceRecoveryClock(0);
  clock(4000,true); expect(clock(109000,false)).toMatchObject({programMs:4000,adMs:105000,expired:false});
  expect(clock(145000,false).expired).toBe(true);
  const cap=createSourceRecoveryClock(0);cap(0,true);expect(cap(300000,true).expired).toBe(true);
});
test('pause restoration requires the selected decoded program frame and completed ads', () => {
  const sample={isAd:false,adBreakInProgress:false,breakPending:false,readyState:4,sourceId:'111',height:1080};
  const candidate={sourceId:'111',targetHeight:1080};
  expect(canRestoreProgramPause(sample,candidate)).toBe(true);
  for(const change of [{isAd:true},{isAd:null},{adBreakInProgress:true},{breakPending:true},{height:540},{sourceId:'222'},{readyState:3}])
    expect(canRestoreProgramPause({...sample,...change},candidate)).toBe(false);
});
test('only desktop SDK browsers and HTTPS DASH program sessions are eligible', () => {
  expect(sourceRecoverySupported('Chrome/130')).toBe(true);expect(sourceRecoverySupported('Firefox/130')).toBe(true);
  for(const ua of ['Safari/605','iPhone Chrome/130','Android Chrome/130'])expect(sourceRecoverySupported(ua)).toBe(false);
  for(const value of [url.replace('https:','http:'),url.replace('/dash/','/hls/'),url.replace('pubads.g.doubleclick.net','ad.test'),url.replace('manifest.mpd','video.mp4')])
    expect(programSession(value)).toBeNull();
});
