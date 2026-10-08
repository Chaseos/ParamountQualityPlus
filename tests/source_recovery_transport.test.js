/** @jest-environment node */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { parseManifest } from '../injected/manifest-parser.js';
import { clearRepresentations, getConfig, getRepresentations, setConfig } from '../injected/state.js';
import { createDiagnosticReport } from '../injected/diagnostic-report.js';
import { resetDiagnostics } from '../injected/diagnostics.js';
import { catalog, failure, indexedXml, url } from './fixtures/source-recovery.js';
let dom,tag,video,events,originalFetch,navigatorDescriptor;
function makeVideo(source='222',ad=false,height=1080,paused=true) {
  document.querySelectorAll('video').forEach(v=>v.remove());
  const v=document.createElement('video');v.getBoundingClientRect=()=>({width:640});
  Object.defineProperties(v,{videoHeight:{value:height,writable:true},videoWidth:{value:1920},readyState:{value:4},paused:{value:paused,writable:true},currentTime:{value:0,writable:true}});
  v.pause=()=>{v.paused=true;};
  v.player={isAd:ad,resource:{ad:{ssai:{contentSourceId:source,videoId:'episode'}},location:{mediaUrl:source==='222'?url:url.replace('/222/','/111/')}},
    on(){},off(){},getAdapter:()=>({adBreakInProgress:v.player.isAd,breakPending:v.player.isAd})};
  document.body.append(v);return v;
}
function response(body,responseUrl,status=200) {
  const result=new Response(body,{status,headers:{'Content-Type':responseUrl.includes('.mpd')?'application/dash+xml':'video/mp4'}});
  Object.defineProperty(result,'url',{value:responseUrl});return result;
}
beforeEach(()=>{
  jest.useFakeTimers();dom=new JSDOM('',{url:'https://www.paramountplus.com/shows/video/episode/'});
  for(const key of ['window','document','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?dom.window:dom.window[key];
  navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(dom.window.navigator,'userAgent',{value:'Chrome/140'});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
  class XHR extends dom.window.EventTarget {
    constructor(){super();this.readyState=0;this.status=0;this.responseType='';this.headers=[];this.openCalls=[];}
    get responseText(){return this._body||'';}get response(){return this.responseText;}
    get responseXML(){return new DOMParser().parseFromString(this._body||'','application/xml');}
    open(method,value){this.openCalls.push([method,value]);this.readyState=1;this._url=value;}
    setRequestHeader(...args){this.headers.push(args);}
    getResponseHeader(name){return name.toLowerCase()==='content-type'?'application/dash+xml':null;}
    getAllResponseHeaders(){return 'Content-Type: application/dash+xml';}
    send(){this._body=indexedXml;this.status=200;this.responseURL=this._url;this.readyState=4;this.dispatchEvent(new dom.window.Event('readystatechange'));this.dispatchEvent(new dom.window.Event('load'));}
  }
  globalThis.XMLHttpRequest=window.XMLHttpRequest=XHR;
  clearRepresentations();setConfig({forcedHeight:1080,enableRetries:false,enablePrefetch:false});resetDiagnostics();
  originalFetch=jest.fn(async value=>{const requestUrl=typeof value==='string'?value:value.url;return response(requestUrl.includes('.mpd')?indexedXml:'bytes',requestUrl,requestUrl.includes('.mpd')?200:206);});
  window.fetch=originalFetch;window.postMessage=jest.fn();events=new Map();video=makeVideo();
  tag={model:{TagConstants:{ADOPS_ID:{CMSID:'111'}},apiMetadata:{streamingUrl:catalog}},params:{CONTENT:{drm:{preserved:true},millstone:{daiParams:{unchanged:true}}},AD:{unchanged:true}},
    eventDispatcher:{removeEventListener:type=>events.delete(type)},tagEventsHandler:(handler,types)=>types.forEach(type=>events.set(type,handler)),
    API:{PLAYER:{contentTime:0,pause:()=>document.querySelector('video')?.pause()},VIDEO:{load:jest.fn(async()=>{
      const next=makeVideo('111',true,432,false);next.dispatchEvent(new dom.window.Event('playing',{bubbles:true}));
    })}}};window.SmartTag={list:[tag]};
  initNetworkHooks({parseManifest,analyzeUrl:jest.fn()});
});
afterEach(()=>{
  window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close();
  if(navigatorDescriptor)Object.defineProperty(globalThis,'navigator',navigatorDescriptor);else delete globalThis.navigator;
  jest.useRealTimers();
});
const messages=type=>window.postMessage.mock.calls.filter(([value])=>value.type===type);
async function loadManifest(transport) {
  if(transport==='fetch')return(await window.fetch(url)).text();
  const xhr=new XMLHttpRequest();xhr.open('GET',url);xhr.send();return xhr.responseText;
}
test.each(['fetch','xhr'])('%s manifest supplies original program-key proof; SDK retry clears obsolete indexed state',async transport=>{
  const text=await loadManifest(transport);
  expect(text).toContain('id="1080"');expect(text).not.toContain('id="540"');expect(getRepresentations().map(r=>r.height)).toEqual([1080,540]);
  video.player.isAd=true;video.remove();
  events.get('TagEvent.ON_PLAYER_EVENT')({type:'TagEvent.ON_PLAYER_EVENT',data:{playerEvent:{detail:{error:failure}}}});
  await jest.advanceTimersByTimeAsync(100);
  expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);expect(messages('PQI_ORIGINAL_STREAM_RECOVERY')).toHaveLength(0);
  expect(messages('PQI_QUALITY_STRATEGY').at(-1)[0].payload.strategy).toBeNull();
  // The old indexed controller must no longer reload when the replacement uses
  // ordinary segmented switching, including a same-height ID reconciliation.
  setConfig({forcedHeight:1080,forcedId:'new-id',enablePrefetch:false});
  window.dispatchEvent(new dom.window.MessageEvent('message',{source:window,data:{type:'PQI_CONFIG',payload:getConfig()}}));
  expect(messages('PQI_INDEXED_RELOAD')).toHaveLength(0);
  await jest.advanceTimersByTimeAsync(45000);expect(messages('PQI_ORIGINAL_STREAM_RECOVERY')).toHaveLength(0);
  const next=document.querySelector('video');next.player.isAd=false;next.videoHeight=1080;await jest.advanceTimersByTimeAsync(500);
  expect(next.paused).toBe(true);expect(createDiagnosticReport().sourceRecovery.outcome).toBe('recovered');
  expect(tag.API.VIDEO.load.mock.calls[0][0].CONTENT).toMatchObject({drm:{preserved:true},millstone:{daiParams:{unchanged:true,daiCmsId:'111'}}});
  expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);
  expect(originalFetch.mock.calls.filter(([value])=>String(value).includes('.mpd'))).toHaveLength(transport==='fetch'?1:0);
});
test('HTTP-successful single-file Range requests retain their exact URL, headers and AbortSignal',async()=>{
  await loadManifest('fetch');const media=getRepresentations()[0].addressing.mediaUrl;
  const signal=new AbortController().signal;const request=new Request(media,{headers:{Range:'bytes=200-400'},signal});
  await window.fetch(request);expect(originalFetch.mock.calls.at(-1)[0]).toBe(request);
  expect(request.headers.get('Range')).toBe('bytes=200-400');expect(request.signal.aborted).toBe(false);
  expect(tag.API.VIDEO.load).not.toHaveBeenCalled();expect(messages('PQI_ORIGINAL_STREAM_RECOVERY')).toHaveLength(0);
});
test('a failed validated alternative preserves the original failure report and falls back once',async()=>{
  await loadManifest('fetch');tag.API.PLAYER.contentTime=25;await jest.advanceTimersByTimeAsync(500);
  tag.API.VIDEO.load.mockRejectedValue(new Error('SDK failed'));video.player.isAd=false;
  events.get('TagEvent.ON_PLAYER_EVENT')({type:'TagEvent.ON_PLAYER_EVENT',data:{playerEvent:{detail:{error:failure}}}});
  await jest.advanceTimersByTimeAsync(500);
  expect(messages('PQI_ORIGINAL_STREAM_RECOVERY')).toHaveLength(1);expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);
  const previous=JSON.parse(window.sessionStorage.getItem('pqiFailureReport'));
  expect(previous.manifest).toMatchObject({strategy:'indexed-manifest',selectedHeight:1080});
  expect(previous.failure).toMatchObject({shakaCode:4012,missingKeyCount:1});
  expect(JSON.stringify(previous)).not.toContain('SECRET');
});
