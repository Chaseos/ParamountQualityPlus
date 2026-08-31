import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'apple/Configuration.json'), 'utf8'));
export function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.error || r.status !== 0) throw Error(`${cmd} failed: ${r.error?.message || r.status}`);
}
const configs = path.join(root, 'apple/Configurations');
await mkdir(configs, { recursive: true });
for (const [key, value] of Object.entries(config)) {
  if (typeof value === 'string' && /[\r\n]/.test(value)) throw Error(`Invalid newline in ${key}`);
}
if (!/^([a-zA-Z0-9-]+\.)+[a-zA-Z0-9-]+$/.test(config.appBundleID) || config.extensionBundleID !== config.appBundleID + '.Extension') throw Error('Invalid Apple identifiers');
if (!/^[a-z][a-z0-9]*$/.test(config.urlScheme)) throw Error('Invalid support scheme');
if ([...config.name].length > 30) throw Error('App Store listing name exceeds 30 characters');
if (new Set(config.products.map(p => p.id)).size !== config.products.length) throw Error('Duplicate product ID');
if (config.products.some(p => p.name.length > 35 || p.description.length > 55 || !/^\d+\.\d{2}$/.test(p.priceUSD))) throw Error('Invalid consumable metadata');
if (config.products.some(p => !p.id.startsWith(config.appBundleID + '.tip.'))) throw Error('Foreign product ID');
const settings = {
  PQP_APP_BUNDLE_ID: config.appBundleID,
  PQP_EXTENSION_BUNDLE_ID: config.extensionBundleID,
  PQP_URL_SCHEME: config.urlScheme,
  DEVELOPMENT_TEAM: config.teamID,
  MARKETING_VERSION: config.version,
  CURRENT_PROJECT_VERSION: config.build,
  MACOSX_DEPLOYMENT_TARGET: config.minimumMacOS,
  ARCHS: config.architectures.join(' '),
  ONLY_ACTIVE_ARCH: 'NO',
  INFOPLIST_KEY_LSApplicationCategoryType: config.category,
  INFOPLIST_KEY_NSHumanReadableCopyright: config.copyright,
};
await writeFile(path.join(configs, 'Shared.xcconfig'), '// Generated from apple/Configuration.json. Run npm run prepare:apple.\n' + Object.entries(settings).map(([k,v])=>`${k} = ${v}`).join('\n') + '\n');
const uuid = value => {
  const h = createHash('sha256').update(value).digest('hex').slice(0,32);
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`.toUpperCase();
};
const storekit = { identifier: uuid(config.appBundleID), nonRenewingSubscriptions: [], products: config.products.map(p => ({
  displayPrice:p.priceUSD, familyShareable:false, internalID:uuid(p.id), localizations:[{description:p.description,displayName:p.name,locale:'en_US'}], productID:p.id, referenceName:p.name,type:'Consumable'
})), settings:{_failTransactionsEnabled:false,_locale:'en_US',_storefront:'USA',_storeKitErrors:[]},subscriptionGroups:[],version:{major:3,minor:0}};
await writeFile(path.join(configs, 'TipProducts.storekit'), JSON.stringify(storekit,null,2)+'\n');
run(process.execPath, ['scripts/build.mjs', '--target=safari']);
run('swift', ['scripts/generate-apple-icons.swift', 'icon.png', 'apple/Paramount Quality+/Paramount Quality+/Assets.xcassets/AppIcon.appiconset']);
