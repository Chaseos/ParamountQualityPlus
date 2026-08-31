import { jest } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';

const read = file => readFileSync(file, 'utf8');
beforeAll(() => execFileSync(process.execPath, ['scripts/build.mjs']), 30000);
test('All packages recognize DAI program playlists without admitting ad segments', async () => {
    const safari = await import('../dist/safari/injected/manifest-parser.js');
    const state = await import('../dist/safari/injected/state.js');
    const model = await import('../dist/safari/injected/stream-model.js');
    const browser = await import('../injected/stream-model.js');
    const root = 'https://pubads.g.doubleclick.net/ondemand/hls/content/test/vid/program/CHS/streams/session/';
    const url = root + 'master.m3u8';
    safari.parseHlsManifest(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.640028"\n${root}video/low.m3u8?signature=fixture\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028"\n${root}video/high.m3u8?signature=fixture\n`, url);
    expect(state.getRepresentations().map(r => r.height)).toEqual([1080, 360]);
    expect(model.classifyMediaRequest(url).isAd).toBe(false);
    expect(browser.classifyMediaRequest(url).isAd).toBe(false);
    for (const other of [root + 'ad.ts', 'https://pubads.g.doubleclick.net/ads/master.m3u8', url.replace('https:', 'http:')]) {
        expect(model.classifyMediaRequest(other).isAd).toBe(true);
    }
});
function files(dir) { return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]); }

test('non-Apple runtime remains byte-for-byte identical, with browser-specific manifests', () => {
    for (const browser of ['chromium','firefox']) {
        for (const file of ['popup.js','popup.html','content.js','icon.png','kofi_symbol.svg','simple-video-speed-controller-icon.png','youtube-ui-cleaner-icon.png',...files('injected'),...files('_locales').filter(x=>x.endsWith('.json'))]) {
            expect(readFileSync(`dist/${browser}/${file}`)).toEqual(readFileSync(file));
        }
        const manifest=JSON.parse(read(`dist/${browser}/manifest.json`));
        expect(Boolean(manifest.browser_specific_settings)).toBe(browser==='firefox');
    }
});

test('Safari has no promotions, tracking, foreign IDs, or development resources', () => {
    const all=files('dist/safari');
    expect(all.some(f=>/node_modules|\.swift|\.storekit|README|LOCALIZATION_REVIEW|\.DS_Store|kofi_symbol|speed-controller-icon|youtube-ui-cleaner-icon/.test(f))).toBe(false);
    for (const file of all.filter(f=>/\.(js|html|json|css|md)$/.test(f))) {
        expect(read(file)).not.toMatch(/ko-fi|kofi|reviewClicked|lastPromotedExtensionAd|simpleVideoSpeedController|youtubeUiCleaner|6806633069|SimpleVideoSpeedController|chromewebstore/i);
    }
    const manifest=JSON.parse(read('dist/safari/manifest.json'));
    expect(manifest.host_permissions).toEqual(['*://*.paramountplus.com/*']);
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.background).toBeUndefined();
    expect(read('dist/safari/content.js')).toContain("area === 'local'");
    expect(read('dist/safari/content.js')).not.toContain('storage.sync');
});

test('Safari popup executes shared quality controls using local preferences without engagement writes', async () => {
    const html=read('dist/safari/popup.html');
    document.body.innerHTML=html;
    const get=jest.fn(async()=>({forceMax:true}));
    const set=jest.fn((_value,callback)=>callback?.());
    const context={document, navigator, console, setTimeout:jest.fn(), clearTimeout:jest.fn(), setInterval:jest.fn(), chrome:{storage:{local:{get,set}},i18n:{getMessage:()=>''},tabs:{query:(_query,cb)=>cb([])},runtime:{}}};
    vm.createContext(context); vm.runInContext(read('dist/safari/popup.js'),context);
    await context.init();
    context.setMode(false,null);
    expect(get.mock.calls[0][0]).not.toContain('reviewClicked');
    expect(set.mock.calls[0][0]).toMatchObject({forceMax:false,forcedId:null});
    expect(document.getElementById('apple-support').getAttribute('href')).toBe('paramountqualityplus://support');
    expect(document.getElementById('review-card')).toBeNull();
});

test('normal scheme is unbound and test scheme cannot archive', () => {
    const base='apple/Paramount Quality+/Paramount Quality+.xcodeproj/xcshareddata/xcschemes/';
    expect(read(base+'Paramount Quality+.xcscheme')).not.toContain('StoreKitConfigurationFileReference');
    expect(read(base+'Paramount Quality+.xcscheme')).toContain('ArchiveAction buildConfiguration="Release"');
    expect(read(base+'StoreKit Testing (macOS).xcscheme')).toMatch(/buildForArchiving\s*=\s*"NO"/);
    expect(read(base+'StoreKit Testing (macOS).xcscheme')).toContain('Configurations/TipProducts.storekit');
});

test('local StoreKit identifiers and amounts derive from target configuration', () => {
    const config=JSON.parse(read('apple/Configuration.json'));
    const local=JSON.parse(read('apple/Configurations/TipProducts.storekit'));
    expect(local.products.map(p=>p.productID)).toEqual(config.products.map(p=>p.id));
    expect(local.products.map(p=>p.displayPrice)).toEqual(config.products.map(p=>p.priceUSD));
    expect(local.products.every(p=>p.type==='Consumable')).toBe(true);
});

test('Safari content bootstrap reads local settings before injection and responds only to local changes', () => {
    document.documentElement.innerHTML='<head></head><body></body>';
    const events=[];
    let changed;
    const get=jest.fn((_keys,callback)=>{events.push('read-local');callback({forceMax:true,forcedHeight:1080});});
    const context={document,window,console,Date,Number,Boolean,setTimeout,clearTimeout,chrome:{
        runtime:{getURL:file=>`safari-web-extension://test/${file}`,onMessage:{addListener:jest.fn()}},
        storage:{local:{get,set:jest.fn()},onChanged:{addListener:listener=>{changed=listener;}}}
    }};
    const append=document.head.appendChild.bind(document.head);
    const spy=jest.spyOn(document.head,'appendChild').mockImplementation(node=>{
        events.push('inject');
        expect(JSON.parse(window.sessionStorage.getItem('pqiPendingQualityConfig')).forceMax).toBe(true);
        expect(node.type).toBe('module');
        return append(node);
    });
    vm.createContext(context);vm.runInContext(read('dist/safari/content.js'),context);
    expect(events).toEqual(['read-local','inject']);
    vm.runInContext(read('dist/safari/content.js'),context);
    expect(events).toEqual(['read-local','inject']);
    expect(context.chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    changed({forceMax:{newValue:false}},'sync');expect(get).toHaveBeenCalledTimes(1);
    changed({forceMax:{newValue:false}},'local');expect(get).toHaveBeenCalledTimes(2);
    spy.mockRestore();
});

test('Safari rating explains unavailable development listings without initiating a purchase', () => {
    document.body.innerHTML='<a id="apple-rate" tabindex="0"></a>';
    let ready;
    const showToast=jest.fn();
    const listener=jest.spyOn(document,'addEventListener').mockImplementation((name,callback)=>{if(name==='DOMContentLoaded')ready=callback;});
    const context={document,showToast,chrome:{i18n:{getMessage:key=>key}}};
    vm.createContext(context);vm.runInContext(read('platforms/safari/actions.js'),context);ready();
    document.getElementById('apple-rate').click();
    expect(showToast).toHaveBeenCalledWith('ratingUnavailable');
    listener.mockRestore();
});

test('Safari keeps advanced settings editable, persisted, and restored when reopened', async () => {
    document.body.innerHTML=read('dist/safari/popup.html');
    const saved={};
    const set=jest.fn((value,callback)=>{Object.assign(saved,value);callback?.();});
    const context=vm.createContext({document,navigator,console,setTimeout:jest.fn(),clearTimeout:jest.fn(),setInterval:jest.fn(),chrome:{
        storage:{local:{get:async()=>({...saved}),set}},i18n:{getMessage:()=>''},tabs:{query:(_q,cb)=>cb([])},runtime:{}}});
    vm.runInContext(read('dist/safari/popup.js'),context);
    await context.init();
    document.getElementById('advanced-toggle').click();
    expect(document.getElementById('advanced-content').hidden).toBe(false);
    for (const [id,value] of [['num-retries','7'],['num-prefetch','12']]) {
        const input=document.getElementById(id); input.value=value; input.dispatchEvent(new Event('change'));
    }
    document.getElementById('cb-retries').click();
    document.getElementById('cb-prefetch').click();
    expect(saved).toMatchObject({maxRetries:7,prefetchCount:12,enableRetries:false,enablePrefetch:false});
    document.body.innerHTML=read('dist/safari/popup.html');
    await context.init();
    expect(document.getElementById('num-retries').value).toBe('7');
    expect(document.getElementById('num-prefetch').value).toBe('12');
    expect(document.getElementById('num-retries').disabled).toBe(true);
    expect(document.getElementById('num-prefetch').disabled).toBe(true);
});

test('Safari drops automatic footer focus but preserves deliberate keyboard focus', () => {
    document.body.innerHTML='<a id="apple-rate" class="safari-action" href="#">Rate</a>';
    const handlers={};
    const facade={getElementById:id=>document.getElementById(id),get activeElement(){return document.activeElement;},
        addEventListener:(name,fn)=>{handlers[name]=fn;}};
    vm.runInNewContext(read('platforms/safari/actions.js'),{document:facade,showToast:jest.fn(),chrome:{i18n:{getMessage:()=>''}}});
    const rate=document.getElementById('apple-rate');
    rate.focus(); handlers.focusin();
    expect(document.activeElement).not.toBe(rate);
    handlers.keydown({key:'Tab'}); rate.focus(); handlers.focusin();
    expect(document.activeElement).toBe(rate);
});
