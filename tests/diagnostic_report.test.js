import { jest } from '@jest/globals';
import { createDiagnosticReport, exportDiagnosticReport, initReportMetadata, persistDiagnosticReport, recordManifestReport, recordMediaReport, resetReportContext } from '../injected/diagnostic-report.js';
import { setConfig } from '../injected/state.js';

beforeEach(() => {
  document.body.replaceChildren(); sessionStorage.clear(); resetReportContext(); setConfig({ forcedHeight: 1080 });
  const script = document.createElement('script'); script.dataset.pqiVersion = '1.32'; document.body.append(script); initReportMetadata();
});
function fixture() {
  return { url: 'https://cdn.test/stream.mpd?token=SECRET', reason: 'selected', selectedHeight: 1080,
    representations: [540,1080].map((height,i) => ({ height, width: height*16/9, codecs: 'avc1.640028', manifestNodeIndex: i,
      addressing: { type: 'single-file-indexed', mediaUrl: `https://user:SECRET@cdn.test/${height}.mp4?auth=SECRET`,
        initializationRange: '0-100', indexRange: '101-200', protection: [{ defaultKID: 'SECRET' }] } })) };
}
test('exports retained representations, ranges, build and selection without raw DRM or credentials', () => {
  recordManifestReport(fixture());
  recordMediaReport('https://cdn.test/1080.mp4?token=SECRET',206,{transport:'fetch',range:'bytes=0-100',contentRange:'bytes 0-100/900',finalUrl:'https://cdn.test/final.mp4?token=SECRET'});
  const report = createDiagnosticReport({recentEvents:[{type:'network_attempt',timestamp:1,detail:{url:'https://cdn.test/a?token=SECRET',headers:{Authorization:'SECRET'},body:'SECRET'}}]});
  expect(report.extensionVersion).toBe('1.32');
  expect(report.selection.mode).toBe('manual');
  expect(report.manifest.representations.map(r=>r.retained)).toEqual([false,true]);
  expect(report.mediaRequests[0]).toMatchObject({status:206,range:'bytes=0-100',contentRange:'bytes 0-100/900',finalPath:'https://cdn.test/final.mp4'});
  expect(JSON.stringify(report)).not.toContain('SECRET');
});
test('captures real player restrictions, variants and key status counts without key IDs or license configuration', () => {
  const video=document.createElement('video'); document.body.append(video);
  video.player={isAd:false,resource:{location:{mediaUrl:'https://cdn.test/m.mpd?token=SECRET'}},getAdapter:()=>({player:{
    getConfiguration:()=>({restrictions:{maxHeight:540},abr:{restrictions:{maxHeight:719}},drm:{servers:{widevine:'SECRET'}}}),
    getKeyStatuses:()=>({SECRET:'output-restricted',OTHER:'usable'}),
    getVariantTracks:()=>[{height:1080,videoCodec:'avc1.640028',active:false,license:'SECRET'}],
    getManifest:()=>({variants:[{video:{height:1080},allowedByApplication:true,allowedByKeySystem:false}]})
  }})};
  const report=createDiagnosticReport();
  expect(report.players[0]).toMatchObject({restrictions:{maxHeight:540},abrRestrictions:{maxHeight:719},keyStatuses:{'output-restricted':1,usable:1},variants:[{height:1080,allowedByApplication:true,allowedByKeySystem:false}]});
  expect(JSON.stringify(report)).not.toContain('SECRET');
});
test('preserves pre-recovery report after reset while distinguishing current report', () => {
  recordManifestReport(fixture());
  expect(persistDiagnosticReport({}, {playerCode:'2103',shakaCode:4012,missingKeyCount:2,license:'SECRET'})).toBe(true);
  resetReportContext();
  const report=exportDiagnosticReport({});
  expect(report.current.manifest).toBeNull();
  expect(report.previousFailure.manifest.selectedHeight).toBe(1080);
  expect(report.previousFailure.failure.shakaCode).toBe(4012);
  expect(report.previousFailureMatchesPage).toBe(true);
  expect(JSON.stringify(report)).not.toContain('SECRET');
});
test('bounds requests, manifests, events and storage; handles corrupt or unavailable storage', () => {
  const result=fixture(); result.representations=Array(500).fill(result.representations[0]);recordManifestReport(result);
  for(let i=0;i<100;i++)recordMediaReport('https://cdn.test/a',206,{range:'bytes=0-10'});
  const snapshot={recentEvents:Array(1000).fill({type:'event',detail:{}})};
  const current=createDiagnosticReport(snapshot);
  expect(current.manifest.representations).toHaveLength(80);expect(current.manifest.truncated).toBe(true);
  expect(current.mediaRequests).toHaveLength(40);expect(current.events).toHaveLength(60);
  expect(persistDiagnosticReport(snapshot)).toBe(true);expect(sessionStorage.getItem('pqiFailureReport').length).toBeLessThan(128*1024);
  sessionStorage.setItem('pqiFailureReport','bad json');expect(exportDiagnosticReport({}).previousFailure).toBeNull();
  const spy=jest.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('disabled');});
  try{expect(()=>persistDiagnosticReport(snapshot)).not.toThrow();}finally{spy.mockRestore();}
});
test('missing and throwing player APIs leave a usable report', () => {
  const video=document.createElement('video');document.body.append(video); video.player={getAdapter(){throw Error('disposed');}};
  expect(createDiagnosticReport().players[0].playerAvailable).toBe(false);
});
