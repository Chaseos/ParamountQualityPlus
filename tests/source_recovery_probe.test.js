import { beforeEach, afterEach, expect, jest, test } from '@jest/globals';
import { TextDecoder, TextEncoder } from 'node:util';
import { createSourceRecovery } from '../injected/source-recovery.js';
import { readDashRepresentations } from '../injected/manifest-parser.js';
import { setConfig, setRepresentations, clearRepresentations } from '../injected/state.js';
import { resetDiagnostics, getDiagnosticSnapshot } from '../injected/diagnostics.js';
import { catalog, failure, indexedXml, sdKey, url } from './fixtures/source-recovery.js';

let controller,fetch,recoverOriginal,tag,video,player,oldDecoder;
function response(body=indexedXml,options={}) {
  const data=new TextEncoder().encode(body);let sent=false;
  return {ok:options.ok!==false,status:options.status||200,redirected:options.redirected||false,url:options.url||url,
    headers:{get:()=>options.length||null},body:{getReader:()=>({
      read:async()=>sent?{done:true}:(sent=true,{done:false,value:data}),
      cancel:jest.fn(async()=>{}),releaseLock:jest.fn()
    })}};
}
beforeEach(()=>{
  jest.useFakeTimers();oldDecoder=globalThis.TextDecoder;globalThis.TextDecoder=TextDecoder;
  window.history.replaceState({},'', '/shows/video/episode/');document.body.replaceChildren();resetDiagnostics();
  setConfig({forcedHeight:1080});setRepresentations(readDashRepresentations(indexedXml,url));
  video=document.createElement('video');video.getBoundingClientRect=()=>({width:640});
  Object.defineProperties(video,{readyState:{value:4},paused:{value:true}});
  player={isAd:false,resource:{ad:{ssai:{contentSourceId:'222',videoId:'episode'}},location:{mediaUrl:url}}};video.player=player;document.body.append(video);
  tag={model:{TagConstants:{ADOPS_ID:{CMSID:'111'}},apiMetadata:{streamingUrl:catalog}},
    tagEventsHandler(){},eventDispatcher:{removeEventListener(){}},params:{CONTENT:{millstone:{}}},
    API:{PLAYER:{contentTime:0},VIDEO:{load:jest.fn(async()=>{})}}};window.SmartTag={list:[tag]};
  fetch=jest.fn(async()=>response());recoverOriginal=jest.fn();
  controller=createSourceRecovery({fetch,recoverOriginal,onAttempt:jest.fn(),onFailure:jest.fn(),enabled:true,now:()=>Date.now()});
  // The player uses a new session URI unseen by the installed transport. An
  // earlier authoritative indexed ladder supplies selection only, not proof.
  controller.observeManifest({supported:true,url:url.replace('/session/','/earlier-session/'),representations:readDashRepresentations(indexedXml,url)});
});
afterEach(()=>{controller.dispose();clearRepresentations();delete window.SmartTag;globalThis.TextDecoder=oldDecoder;jest.useRealTimers();});
const advance=ms=>jest.advanceTimersByTimeAsync(ms);
test.each([
  ['HTTP rejection', () => response('', { ok:false, status:403 }), 'response-rejected', 403],
  ['oversized response', () => response('', { length:2097153 }), 'manifest-too-large', 200],
  ['malformed XML', () => response('<MPD>broken'), 'unsupported-manifest', 200],
  ['wrapper failure', () => { throw Error('https://private.test/?token=SECRET'); }, 'manifest-fetch-failed', null]
])('reports %s probe failures with a bounded reason and HTTP status', async (_label, make, reason, status) => {
  fetch.mockImplementation(async () => make());controller.handleError(failure, player);await advance(100);
  const detail = getDiagnosticSnapshot().recentEvents.find(e => e.detail.outcome === 'manifest-unavailable').detail;
  expect(detail).toMatchObject({reason, status});
  expect(JSON.stringify(getDiagnosticSnapshot())).not.toContain('SECRET');
});
test('probe re-reads the exact observed session URL once and does not publish its ladder',async()=>{
  const post=jest.spyOn(window,'postMessage').mockImplementation(()=>{});
  try {
    expect(controller.handleError(failure,player)).toBe(true);controller.handleError(failure,player);video.remove();await advance(300);
    expect(fetch).toHaveBeenCalledTimes(1);expect(fetch).toHaveBeenCalledWith(url,{credentials:'omit',redirect:'error',signal:expect.any(AbortSignal)});
    expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);expect(post).not.toHaveBeenCalled();
    expect(JSON.stringify(getDiagnosticSnapshot())).not.toContain('SECRET');
  } finally {post.mockRestore();}
});
test.each([
  ['redirect',()=>response(indexedXml,{redirected:true})],
  ['other session',()=>response(indexedXml,{url:url.replace('/session/','/other-session/')})],
  ['HTTP failure',()=>response('',{ok:false})],
  ['malformed',()=>response('<MPD>broken')],
  ['dynamic',()=>response(indexedXml.replace('type="static"','type="dynamic"'))],
  ['wrong program key',()=>response(indexedXml.replaceAll(failure.cause.data[0].missingKeys[0],sdKey))],
  ['header size',()=>response('',{length:2097153})],
  ['body size',()=>response('x'.repeat(2097153))]
])('rejects %s evidence and negatively caches that URI',async(_label,make)=>{
  fetch.mockResolvedValue(make());controller.handleError(failure,player);await advance(100);
  expect(tag.API.VIDEO.load).not.toHaveBeenCalled();expect(recoverOriginal).toHaveBeenCalledTimes(1);
  controller.handleError(failure,player);expect(fetch).toHaveBeenCalledTimes(1);
});
test('the five-second timeout is bounded even if another fetch wrapper ignores AbortSignal',async()=>{
  fetch.mockImplementation(()=>new Promise(()=>{}));controller.handleError(failure,player);await advance(5000);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);expect(controller.busy()).toBe(false);
  expect(getDiagnosticSnapshot().recentEvents.find(e=>e.detail.outcome==='manifest-unavailable').detail.reason).toBe('manifest-timeout');
  expect(recoverOriginal).toHaveBeenCalledTimes(1);expect(tag.API.VIDEO.load).not.toHaveBeenCalled();
});
test('cancellation aborts the probe and stale completion cannot load or publish evidence',async()=>{
  let release;fetch.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));controller.handleError(failure,player);
  setConfig({});window.dispatchEvent(new MessageEvent('message',{source:window,data:{type:'PQI_CONFIG',payload:{}}}));
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);release(response());await advance(100);
  expect(recoverOriginal).not.toHaveBeenCalled();expect(tag.API.VIDEO.load).not.toHaveBeenCalled();
  expect(getDiagnosticSnapshot().recentEvents.some(e=>e.detail.outcome==='manifest-proof')).toBe(false);
});
test('Auto, unknown targets, and mismatched episode IDs never request a probe',()=>{
  setConfig({});expect(controller.handleError(failure,player)).toBe(false);
  setConfig({forcedHeight:2160});expect(controller.handleError(failure,player)).toBe(false);
  setConfig({forcedHeight:1080});player.resource.ad.ssai.videoId='other';expect(controller.handleError(failure,player)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
