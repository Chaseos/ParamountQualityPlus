import { readFile, readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const config=JSON.parse(await readFile('apple/Configuration.json','utf8'));
const manifest=JSON.parse(await readFile('dist/safari/manifest.json','utf8'));
assert.equal(manifest.version,config.version,'Apple and extension versions must match');
assert.deepEqual(manifest.host_permissions,['*://*.paramountplus.com/*']);
assert.deepEqual(manifest.permissions,['storage']);
assert(!manifest.browser_specific_settings);
for(const file of ['popup.html','popup.js','content.js','safari-actions.js','safari-popup.css',...Object.values(manifest.icons),...manifest.web_accessible_resources.flatMap(x=>x.resources)]) await access(path.join('dist/safari',file));
for(const e of await readdir('dist/safari/_locales',{withFileTypes:true})) {
 if(!e.isDirectory())continue;
 const messages=JSON.parse(await readFile(`dist/safari/_locales/${e.name}/messages.json`,'utf8'));
 assert([...messages.appName.message].length<=40);
 const html=await readFile('dist/safari/popup.html','utf8');
 for(const m of html.matchAll(/data-i18n(?:-title|-aria-label)?="([^"]+)"/g))assert(messages[m[1]],`${e.name}: missing ${m[1]}`);
}
const normal=await readFile('apple/Paramount Quality+/Paramount Quality+.xcodeproj/xcshareddata/xcschemes/Paramount Quality+.xcscheme','utf8');
assert(!normal.includes('StoreKitConfigurationFileReference'));
assert(/ArchiveAction\s+buildConfiguration\s*=\s*"Release"/.test(normal));
function run(cmd,args){const r=spawnSync(cmd,args,{encoding:'utf8'});if(r.error||r.status!==0)throw Error(`${cmd}: ${r.error?.message||r.stderr}`);return r.stdout;}
function plist(file){return JSON.parse(run('plutil',['-convert','json','-o','-',file]));}
async function files(dir) {
 const result=[];
 for(const entry of await readdir(dir,{withFileTypes:true})) {
  const file=path.join(dir,entry.name);
  if(entry.isDirectory()) result.push(...await files(file)); else result.push(file);
 }
 return result.sort();
}
let artifactSHA256;
const app=process.argv.find(x=>x.startsWith('--app='))?.slice(6);
if(app){
 const extension=path.join(app,'Contents/PlugIns/Paramount Quality+ Extension.appex');
 for(const [bundle,id] of [[app,config.appBundleID],[extension,config.extensionBundleID]]){
  const info=plist(path.join(bundle,'Contents/Info.plist'));
  assert.equal(info.CFBundleIdentifier,id);assert.equal(info.CFBundleShortVersionString,config.version);assert.equal(info.CFBundleVersion,config.build);assert.equal(info.LSMinimumSystemVersion,config.minimumMacOS);
  const executable=path.join(bundle,'Contents/MacOS',info.CFBundleExecutable);
  const architectures=run('lipo',['-archs',executable]).trim().split(/\s+/);assert.deepEqual(architectures.sort(),[...config.architectures].sort());
  if(process.argv.includes('--signed')){
   run('codesign',['--verify','--strict',bundle]);
   const r=spawnSync('codesign',['-d','--entitlements',':-',bundle],{encoding:'utf8'});
   assert(r.stdout.includes('com.apple.security.app-sandbox'));
   const parsed=spawnSync('plutil',['-convert','json','-o','-','--','-'],{encoding:'utf8',input:r.stdout});
   assert.equal(parsed.status,0);const entitlements=JSON.parse(parsed.stdout);assert.equal(entitlements['com.apple.security.app-sandbox'],true);
   const signature=spawnSync('codesign',['-d','--verbose=4',bundle],{encoding:'utf8'}).stderr;
   assert(signature.includes(`TeamIdentifier=${config.teamID}`),'Unexpected signing team');
   if(process.argv.includes('--release')) {
    assert(/Authority=(Apple Distribution:|3rd Party Mac Developer Application:)/.test(signature),'App Store distribution signing required');
    assert(!entitlements['com.apple.security.get-task-allow'],'Release must not allow debugging');
   }
  }
 }
 const appInfo=plist(path.join(app,'Contents/Info.plist'));
 assert.equal(appInfo.LSApplicationCategoryType,config.category);
 assert.deepEqual(appInfo.CFBundleURLTypes.flatMap(x=>x.CFBundleURLSchemes),[config.urlScheme]);
 assert.deepEqual(JSON.parse(await readFile(path.join(app,'Contents/Resources/Configuration.json'),'utf8')),config);
 for(const locale of ['en','de','es','es-419','fr','it','ko','pt-BR'])await access(path.join(app,`Contents/Resources/${locale}.lproj/Localizable.strings`));
 for(const file of await files('dist/safari')) {
  const bundled=path.join(extension,'Contents/Resources',path.relative('dist/safari',file));
  assert.deepEqual(await readFile(bundled),await readFile(file),`Stale bundled resource: ${file}`);
 }
 await access(path.join(extension,'Contents/Resources/manifest.json'));
 assert.deepEqual(JSON.parse(await readFile(path.join(extension,'Contents/Resources/manifest.json'),'utf8')),manifest);
 const digest=createHash('sha256');
 for(const file of await files(app))digest.update(path.relative(app,file)).update(await readFile(file));
 artifactSHA256=digest.digest('hex');
 console.log(`Inspected app bundle SHA-256: ${artifactSHA256}`);
}
if(process.argv.includes('--release')){
 const gates=[];
 if(!/^\d+$/.test(config.appStoreID))gates.push('App Store ID is unresolved');
 if(!app)gates.push('Pass --app=<fresh app/archive app> --signed for artifact inspection');
 if(!process.argv.includes('--signed'))gates.push('Distribution signature has not been inspected');
 let evidence;
 try{evidence=JSON.parse(await readFile('build/release-check/release-gates.json','utf8'));}catch{}
 if(!artifactSHA256 || evidence?.artifactSHA256!==artifactSHA256)gates.push('Evidence does not identify this exact app binary');
 for(const key of ['safariPlayback','interactivePurchases','pendingRecovery','privacyPublished','attestationsConfirmed','reviewAccess','storefrontCompliance','sandboxPurchases','minimumMacOSRuntime','intelRuntime','accessibility','listingAssets'])if(evidence?.[key]!==true)gates.push(`${key} has not passed`);
 if(gates.length)throw Error('Release blocked:\n'+gates.join('\n'));
}
console.log('Apple resource/configuration validation passed'+(app?' with built bundle inspection.':'.'));
