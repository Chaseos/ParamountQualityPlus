import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuration = process.argv.includes('--release') ? 'Release' : 'Debug';
const signed = process.argv.includes('--development-signed');
function run(cmd,args) { const r=spawnSync(cmd,args,{cwd:root,stdio:'inherit'}); if(r.error || r.status!==0) throw Error(`${cmd} failed: ${r.error?.message || r.status}`); }
run(process.execPath,['scripts/prepare-apple.mjs']);
const output = `build/apple-${configuration.toLowerCase()}-${signed ? 'development' : 'unsigned'}`;
run('xcodebuild',['-quiet','-jobs','2','-project','apple/Paramount Quality+/Paramount Quality+.xcodeproj','-scheme','Paramount Quality+','-configuration',configuration,'-destination','generic/platform=macOS','-derivedDataPath',output,...(signed ? ['CODE_SIGN_IDENTITY=Apple Development'] : ['CODE_SIGNING_ALLOWED=NO']),'build']);
run(process.execPath,['scripts/validate-apple.mjs',`--app=${output}/Build/Products/${configuration}/Paramount Quality+.app`,...(signed ? ['--signed'] : [])]);
console.log(`Built ${signed ? 'development-signed' : 'unsigned'} macOS ${configuration}; no archive or upload performed.`);
