import { beforeEach, afterEach, expect, jest, test } from '@jest/globals';
import { createSourceRecovery } from '../injected/source-recovery.js';
import { readDashRepresentations } from '../injected/manifest-parser.js';
import { getConfig, setConfig, setRepresentations, clearRepresentations } from '../injected/state.js';
import { getDiagnosticSnapshot, resetDiagnostics } from '../injected/diagnostics.js';
import { catalog, failure, indexedXml, url } from './fixtures/source-recovery.js';

let controller,tag,video,player,events,recoverOriginal,onAttempt,onFailure,fetch;
function makeVideo(source='222',isAd=false,height=1080,paused=true) {
  document.querySelectorAll('video').forEach(v=>v.remove());
  const v=document.createElement('video');
  Object.defineProperties(v,{videoHeight:{value:height,writable:true},videoWidth:{value:1920},readyState:{value:4,writable:true},
    paused:{value:paused,writable:true},currentTime:{value:0,writable:true}});
  v.getBoundingClientRect=()=>({width:640});v.pause=jest.fn(()=>{v.paused=true;});
  const shaka={getManifest:jest.fn(()=>{throw Error('Polling the manifest is unnecessary');})};
  const p={isAd,resource:{ad:{ssai:{contentSourceId:source,videoId:'episode'}},location:{mediaUrl:source==='222'?url:url.replace('/222/','/111/')}},
    getAdapter:type=>type==='ad'?{adBreakInProgress:p.isAd,breakPending:p.isAd}:{player:shaka}};
  v.player=p;document.body.append(v);return {video:v,player:p,shaka};
}
const observe=()=>controller.observeManifest({supported:true,url,representations:readDashRepresentations(indexedXml,url),selectedHeight:1080});
const advance=async ms=>{await jest.advanceTimersByTimeAsync(ms);};
const logOutcomes=()=>getDiagnosticSnapshot().recentEvents.filter(e=>e.detail.checkpoint==='source_recovery').map(e=>e.detail.outcome);
beforeEach(()=>{
  jest.useFakeTimers();resetDiagnostics();window.history.replaceState({},'', '/shows/video/episode/');document.body.replaceChildren();window.sessionStorage.clear();
  const initial=makeVideo();video=initial.video;player=initial.player;
  setConfig({forceMax:true});setRepresentations(readDashRepresentations(indexedXml,url));events=new Map();
  recoverOriginal=jest.fn();onAttempt=jest.fn();onFailure=jest.fn();fetch=jest.fn();
  tag={model:{TagConstants:{ADOPS_ID:{CMSID:'111'}},apiMetadata:{streamingUrl:catalog}},
    eventDispatcher:{removeEventListener:(type,handler)=>{if(events.get(type)===handler)events.delete(type);}},
    tagEventsHandler:(handler,types)=>types.forEach(type=>events.set(type,handler)),
    params:{CONTENT:{drm:{license:'PRIVATE'},millstone:{daiParams:{original:true}}},AD:{tracking:'unchanged'}},
    API:{PLAYER:{contentTime:0,pause:jest.fn(()=>document.querySelector('video')?.pause())},VIDEO:{load:jest.fn(async()=>{})}}};
  window.SmartTag={list:[tag]};
  controller=createSourceRecovery({fetch,onAttempt,onFailure,recoverOriginal,enabled:true,now:()=>Date.now()});observe();
});
afterEach(()=>{controller.dispose();delete window.SmartTag;clearRepresentations();jest.useRealTimers();});
test.each([true,false,null])('fatal zero-position startup with ad status %s waits for teardown and retries only once',async isAd=>{
  player.isAd=isAd;
  expect(controller.handleError(failure,player)).toBe(true);expect(controller.handleError(failure,player)).toBe(true);
  await advance(100);expect(tag.API.VIDEO.load).not.toHaveBeenCalled();video.remove();
  tag.API.VIDEO.load.mockImplementation(async()=>{
    const next=makeVideo('111',true,432,false);next.video.dispatchEvent(new Event('playing',{bubbles:true}));
  });
  await advance(100);expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);
  await advance(105000);expect(recoverOriginal).not.toHaveBeenCalled();expect(document.querySelector('video').paused).toBe(false);
  const next=document.querySelector('video');next.player.isAd=false;next.videoHeight=1080;await advance(150);
  expect(next.paused).toBe(true);await advance(300);expect(controller.busy()).toBe(false);
  expect(logOutcomes()).toContain('recovered');expect(fetch).not.toHaveBeenCalled();
  const content=tag.API.VIDEO.load.mock.calls[0][0].CONTENT;
  expect(content).toMatchObject({globalResumeTime:0,autoplay:true,drm:{license:'PRIVATE'},millstone:{daiParams:{original:true,daiCmsId:'111'},streamingUrl:catalog}});
  expect(tag.params.AD).toEqual({tracking:'unchanged'});
  expect(controller.handleError(failure,player)).toBe(false);expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);
});
test('SDK error dispatcher captures startup after the old video disappears',async()=>{
  player.isAd=true;video.remove();
  events.get('TagEvent.ON_PLAYER_EVENT')({type:'TagEvent.ON_PLAYER_EVENT',data:{playerEvent:{detail:{error:failure}}}});
  await advance(1);expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);expect(onFailure).toHaveBeenCalledTimes(1);
});
test('a hidden old video is not mistaken for a destroyed startup player',async()=>{
  player.isAd=true;controller.handleError(failure,player);video.getBoundingClientRect=()=>({width:0});await advance(100);
  expect(tag.API.VIDEO.load).not.toHaveBeenCalled();
  events.get('TagEvent.ON_DESTROY_PLAYER_SUCCESS')({type:'TagEvent.ON_DESTROY_PLAYER_SUCCESS'});
  await advance(100);expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);
});
test('the quality-reload handoff retains paused content position through preroll startup',async()=>{
  tag.API.PLAYER.contentTime=120;video.paused=true;controller.stagePosition();
  expect(JSON.parse(window.sessionStorage.getItem('pqiSourceResume'))).toMatchObject({time:120,paused:true,path:window.location.pathname});
  controller.dispose();tag.API.PLAYER.contentTime=0;video.paused=false;video.videoHeight=540;
  controller=createSourceRecovery({fetch,onAttempt,onFailure,recoverOriginal,enabled:true,now:()=>Date.now()});observe();
  player.isAd=true;controller.handleError(failure,player);video.remove();await advance(100);
  expect(tag.API.VIDEO.load.mock.calls[0][0].CONTENT.globalResumeTime).toBe(120);
  expect(getDiagnosticSnapshot().recentEvents.find(e=>e.detail.outcome==='started').detail.paused).toBe(true);
  expect(window.sessionStorage.getItem('pqiSourceResume')).toBeNull();
});
test.each([true,false])('an indexed reload restores program position in a successful segmented replacement, paused=%s',async paused=>{
  tag.API.PLAYER.contentTime=120;video.paused=paused;controller.stagePosition();controller.dispose();
  tag.API.PLAYER.contentTime=779;video.paused=!paused;tag.API.PLAYER.seek=jest.fn(async time=>{tag.API.PLAYER.contentTime=time;});
  tag.API.PLAYER.play=jest.fn(()=>{video.paused=false;});
  controller=createSourceRecovery({fetch,onAttempt,onFailure,recoverOriginal,enabled:true,now:()=>Date.now()});
  controller.observeManifest({supported:false,url,representations:[]});
  await advance(500);
  expect(tag.API.PLAYER.seek).toHaveBeenCalledTimes(1);expect(tag.API.PLAYER.seek).toHaveBeenCalledWith(120);
  expect(video.paused).toBe(paused);expect(tag.API.VIDEO.load).not.toHaveBeenCalled();expect(recoverOriginal).not.toHaveBeenCalled();
  expect(events.size).toBe(0); // Ordinary streams stop being sampled after the handoff.
});
test('an already restored ordinary handoff leaves no idle sampling timer',()=>{
  controller.stagePosition();controller.dispose();
  controller=createSourceRecovery({fetch,onAttempt,onFailure,recoverOriginal,enabled:true,now:()=>Date.now()});
  controller.observeManifest({supported:false,url,representations:[]});
  expect(events.size).toBe(0);expect(jest.getTimerCount()).toBe(0);
});
test('restoration to Auto waits through a long required ad before seeking or pausing program playback',async()=>{
  tag.API.PLAYER.contentTime=120;video.paused=true;controller.stagePosition();controller.dispose();setConfig({});
  tag.API.PLAYER.contentTime=0;video.paused=false;player.isAd=true;
  tag.API.PLAYER.seek=jest.fn(async time=>{tag.API.PLAYER.contentTime=time;});
  controller=createSourceRecovery({fetch,onAttempt,onFailure,recoverOriginal,enabled:true,now:()=>Date.now()});
  controller.observeManifest({supported:false,url,representations:[]});await advance(135000);
  expect(tag.API.PLAYER.seek).not.toHaveBeenCalled();expect(video.pause).not.toHaveBeenCalled();
  player.isAd=false;tag.API.PLAYER.contentTime=700;await advance(1000);
  expect(tag.API.PLAYER.seek).toHaveBeenCalledTimes(1);expect(video.paused).toBe(true);
});
test('an active position handoff stays bounded even if ad playback never finishes',async()=>{
  tag.API.PLAYER.contentTime=120;video.paused=true;controller.stagePosition();controller.dispose();
  tag.API.PLAYER.contentTime=0;video.paused=false;player.isAd=true;
  tag.API.PLAYER.seek=jest.fn();
  controller=createSourceRecovery({fetch,onAttempt,onFailure,recoverOriginal,enabled:true,now:()=>Date.now()});
  controller.observeManifest({supported:false,url,representations:[]});await advance(300000);
  expect(events.size).toBe(0);expect(jest.getTimerCount()).toBe(0);
  expect(tag.API.PLAYER.seek).not.toHaveBeenCalled();expect(video.pause).not.toHaveBeenCalled();
  expect(getDiagnosticSnapshot().recentEvents.some(e=>e.detail.checkpoint==='indexed_position_restore_failed')).toBe(true);
});
test('a failed position handoff never repeats the SDK seek or starts source recovery',async()=>{
  tag.API.PLAYER.contentTime=120;video.paused=true;controller.stagePosition();controller.dispose();
  tag.API.PLAYER.contentTime=779;video.paused=false;tag.API.PLAYER.seek=jest.fn(async()=>{throw Error('Seek unavailable');});
  controller=createSourceRecovery({fetch,onAttempt,onFailure,recoverOriginal,enabled:true,now:()=>Date.now()});
  controller.observeManifest({supported:false,url,representations:[]});await advance(5000);
  expect(tag.API.PLAYER.seek).toHaveBeenCalledTimes(1);expect(video.paused).toBe(false);
  expect(events.size).toBe(0);
  expect(getDiagnosticSnapshot().recentEvents.some(e=>e.detail.checkpoint==='indexed_position_restore_failed')).toBe(true);
  expect(tag.API.VIDEO.load).not.toHaveBeenCalled();expect(recoverOriginal).not.toHaveBeenCalled();
});
test('an initializing autoplay player retains the requested program position instead of zero and paused',async()=>{
  controller.dispose();video.readyState=1;video.paused=true;
  tag.params.CONTENT.globalResumeTime=600;tag.params.CONTENT.autoplay=true;
  controller=createSourceRecovery({fetch,onAttempt,onFailure,recoverOriginal,enabled:true,now:()=>Date.now()});observe();
  await advance(500);controller.handleError(failure,player);video.remove();
  tag.API.VIDEO.load.mockImplementation(async()=>makeVideo('111',false,1080,false));
  await advance(100);
  expect(tag.API.VIDEO.load.mock.calls[0][0].CONTENT.globalResumeTime).toBe(600);
  expect(getDiagnosticSnapshot().recentEvents.find(e=>e.detail.outcome==='started').detail.paused).toBe(false);
  const next=document.querySelector('video');await advance(250);next.currentTime=4;await advance(250);
  expect(next.pause).not.toHaveBeenCalled();expect(logOutcomes()).toContain('recovered');
});
test('a pending preroll frame cannot overwrite the requested resume state',async()=>{
  controller.dispose();video.paused=false;
  player.getAdapter=()=>({adBreakInProgress:false,breakPending:true});
  tag.params.CONTENT.globalResumeTime=600;tag.params.CONTENT.autoplay=true;
  controller=createSourceRecovery({fetch,onAttempt,onFailure,recoverOriginal,enabled:true,now:()=>Date.now()});observe();
  await advance(500);controller.handleError(failure,player);video.remove();await advance(100);
  expect(tag.API.VIDEO.load.mock.calls[0][0].CONTENT.globalResumeTime).toBe(600);
});
test('program recovery preserves position and verifies advancing 1080p',async()=>{
  tag.params.CONTENT.globalResumeTime=600;tag.params.CONTENT.autoplay=false;
  tag.API.PLAYER.contentTime=1250;video.paused=false;await advance(500);
  tag.API.VIDEO.load.mockImplementation(async()=>makeVideo('111',false,1080,false));
  expect(controller.handleError(failure,player)).toBe(true);await advance(1);
  const next=document.querySelector('video');await advance(250);next.currentTime=4;await advance(250);
  expect(controller.busy()).toBe(false);expect(logOutcomes()).toContain('recovered');
  expect(tag.API.VIDEO.load.mock.calls[0][0].CONTENT.globalResumeTime).toBe(1250);
});
test('a failed SDK retry forwards original recovery once and never changes preferences',async()=>{
  setConfig({forcedHeight:1080});const config={...getConfig()};
  tag.API.PLAYER.contentTime=10;await advance(500);tag.API.VIDEO.load.mockRejectedValue(new Error('PRIVATE signed URL'));
  controller.handleError(failure,player);await advance(300);
  expect(recoverOriginal).toHaveBeenCalledTimes(1);expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);
  expect(controller.handleError(failure,player)).toBe(false);
  expect(getConfig()).toEqual(config);
  expect(JSON.stringify(getDiagnosticSnapshot())).not.toContain('PRIVATE');
});
test('a fatal error from the replacement source returns to original recovery without another SDK load',async()=>{
  tag.API.PLAYER.contentTime=10;await advance(500);
  tag.API.VIDEO.load.mockImplementation(async()=>makeVideo('111',false,1080,false));
  controller.handleError(failure,player);await advance(250);
  events.get('TagEvent.ON_FATAL_ERROR')({type:'TagEvent.ON_FATAL_ERROR',data:{error:{code:'3005',fatal:true}}});
  await advance(250);expect(recoverOriginal).toHaveBeenCalledTimes(1);expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);
});
test('Auto or a new episode cancels pending validation without recovering the old episode',async()=>{
  controller.handleError(failure,player);await advance(10);
  setConfig({});window.dispatchEvent(new MessageEvent('message',{source:window,data:{type:'PQI_CONFIG',payload:{}}}));
  video.remove();await advance(100);
  expect(tag.API.VIDEO.load).not.toHaveBeenCalled();expect(recoverOriginal).not.toHaveBeenCalled();
  setConfig({forceMax:true});observe();controller.handleError(failure,player);window.history.replaceState({},'', '/shows/video/other/');
  await advance(5000);expect(tag.API.VIDEO.load).not.toHaveBeenCalled();expect(recoverOriginal).not.toHaveBeenCalled();
});
test('video identity changes cancel recovery even before a SPA updates its page URL',async()=>{
  controller.handleError(failure,player);await advance(10);player.resource.ad.ssai.videoId='new-episode';await advance(100);
  expect(tag.API.VIDEO.load).not.toHaveBeenCalled();expect(recoverOriginal).not.toHaveBeenCalled();expect(controller.busy()).toBe(false);
});
test('a prior episode video cannot seed the next episode playback position',async()=>{
  tag.API.PLAYER.contentTime=150;await advance(500);
  const nextUrl=url.replace('/episode/','/next-episode/');
  controller.observeManifest({supported:true,url:nextUrl,representations:readDashRepresentations(indexedXml,nextUrl)});
  await advance(500); // The old video is still attached during the transition.
  player.resource.ad.ssai.videoId='next-episode';player.resource.location.mediaUrl=nextUrl;tag.API.PLAYER.contentTime=0;
  controller.handleError(failure,player);video.remove();await advance(100);
  expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);expect(tag.API.VIDEO.load.mock.calls[0][0].CONTENT.globalResumeTime).toBe(0);
});
test('duplicate effective selection and representation-ID reconciliation do not cancel a retry',async()=>{
  controller.handleError(failure,player);await advance(10);
  setConfig({forcedHeight:1080,forcedId:'reconciled'});window.dispatchEvent(new MessageEvent('message',{source:window,data:{type:'PQI_CONFIG',payload:{forcedHeight:1080}}}));
  video.remove();await advance(100);expect(tag.API.VIDEO.load).toHaveBeenCalledTimes(1);
});
test('ordinary successful playback samples do not read Shaka manifests or generate reports',async()=>{
  const shaka=player.getAdapter('playback').player;await advance(60000);
  expect(shaka.getManifest).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(onFailure).not.toHaveBeenCalled();
  expect(tag.API.VIDEO.load).not.toHaveBeenCalled();
});
test('a later program ad failure is diagnostic-only and unrelated errors stay with existing recovery',async()=>{
  tag.API.PLAYER.contentTime=100;await advance(500);player.isAd=true;
  expect(controller.handleError(failure,player)).toBe(false);
  expect(controller.handleError({...failure,cause:{...failure.cause,code:3005}},player)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();expect(tag.API.VIDEO.load).not.toHaveBeenCalled();
});
test('disabled Safari/native controller observes nothing and leaves playback untouched',()=>{
  controller.dispose();controller=createSourceRecovery({fetch,onAttempt,onFailure,recoverOriginal,enabled:false});observe();
  expect(events.size).toBe(0);expect(controller.handleError(failure,player)).toBe(false);expect(tag.API.VIDEO.load).not.toHaveBeenCalled();
});
