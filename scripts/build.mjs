import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const read = file => readFile(path.join(root, file), 'utf8');
const manifest = JSON.parse(await read('manifest.json'));
const requested = process.argv.find(arg => arg.startsWith('--target='))?.split('=')[1];
if (requested && !['safari', 'chromium', 'firefox'].includes(requested)) throw Error('Unknown build target');
const targets = requested ? [requested] : ['chromium', 'firefox', 'safari'];
const runtimeFiles = ['content.js', 'popup.html', 'popup.js', 'icon.png', ...manifest.web_accessible_resources.flatMap(entry => entry.resources), ...['de', 'en', 'es', 'es_419', 'fr', 'it', 'ko', 'pt_BR'].map(locale => `_locales/${locale}/messages.json`)];
const browserFiles = [...new Set(runtimeFiles), 'kofi_symbol.svg', 'simple-video-speed-controller-icon.png', 'youtube-ui-cleaner-icon.png', 'README.md', 'PRIVACYPOLICY.md', 'LOCALIZATION_REVIEW.md'];
const safariFiles = [...new Set(runtimeFiles), 'PRIVACYPOLICY.md'];
const safariNativeModules = ['native-master.js', 'native-captions.js', 'native-session.js', 'native-playback.js'];
const removedKeys = ['leaveReview', 'supportMyWork', 'supportMyWorkCta', 'simpleVideoSpeedControllerAdLineOne', 'simpleVideoSpeedControllerAdLineTwo', 'youtubeUiCleanerAdLineOne', 'youtubeUiCleanerAdLineTwo'];
const forbidden = /ko-fi|kofi|chromewebstore|microsoftedge\.microsoft\.com\/addons|addons\.mozilla|addons\.opera|store\.whale|reviewClicked|leaveReview|PROMOTED_EXTENSION|simpleVideoSpeedController|youtubeUiCleaner|SimpleVideoSpeedController|6806633069|simplevideospeedcontroller/i;

function replaceRequired(source, search, replacement, label) {
  const matches = typeof search === 'string' ? source.split(search).length - 1 : [...source.matchAll(new RegExp(search.source, 'g'))].length;
  if (matches !== 1) throw Error(`Safari transformation ${label}: expected one match, found ${matches}`);
  return source.replace(search, () => replacement);
}
function removeRange(source, start, end, label) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || source.indexOf(start, a + 1) !== -1) throw Error(`Safari transformation missing/ambiguous: ${label}`);
  return source.slice(0, a) + source.slice(b);
}
async function moduleGraph(file, found = new Set(), directory = root) {
  if (found.has(file)) return found;
  found.add(file);
  for (const match of (await readFile(path.join(directory, file), 'utf8')).matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) {
    await moduleGraph(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])), found, directory);
  }
  return found;
}
const resources = new Set(manifest.web_accessible_resources.flatMap(e => e.resources));
for (const file of await moduleGraph('injected/index.js')) if (!resources.has(file)) throw Error(`Undeclared injected module: ${file}`);

async function safari(destination) {
  const config = JSON.parse(await read('apple/Configuration.json'));
  const translations = JSON.parse(await read('platforms/safari/messages.json'));
  let html = await read('popup.html');
  html = removeRange(html, '    .kofi-link {', '    .status-dot {', 'support styles');
  html = removeRange(html, '    .review-card,', '    .advanced-header {', 'promotion styles');
  html = replaceRequired(html, /\s*<a id="kofi-link"[\s\S]*?<\/a>/, '', 'support markup');
  html = replaceRequired(html, /\s*<div id="review-card"[\s\S]*?(?=\n  <\/div>\n\n  <script)/, '', 'promotion markup');
  const rateHref = /^\d+$/.test(config.appStoreID) ? ` href="https://apps.apple.com/app/id${config.appStoreID}?action=write-review" data-unpublished="${!config.appStorePublished}"` : '';
  const action = (id, label, svg, href, cls) => `<a id="apple-${id}" class="safari-action safari-${cls}"${href} role="link" tabindex="0" target="_blank" rel="noopener noreferrer" data-i18n-title="${label}" data-i18n-aria-label="${label}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${svg}"/></svg><span class="safari-action-label"><span data-i18n="${label}"></span></span></a>`;
  const actions = `<nav class="safari-actions" aria-label="App actions">${action('rate','rateThisApp','M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',rateHref,'rate')}${action('support','supportOptions','M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.59 3.81 15.26 3 17 3c3.08 0 5.5 2.42 5.5 5.5 0 3.78-3.4 6.86-8.55 11.54z',` href="${config.urlScheme}://support"`,'support')}</nav>`;
  html = replaceRequired(html, '  <script src="popup.js"></script>', `  ${actions}\n  <script src="popup.js"></script>\n  <script src="safari-actions.js"></script>`, 'action insertion');
  html = replaceRequired(html, '</head>', '<link rel="stylesheet" href="safari-popup.css">\n</head>', 'stylesheet');
  let js = await read('popup.js');
  js = removeRange(js, 'const KOFI_URL', "document.addEventListener('DOMContentLoaded'", 'browser constants');
  js = removeRange(js, "    const kofiLink", '    // 1. Load Config', 'support binding');
  js = replaceRequired(js, "'reviewClicked', 'simpleVideoSpeedControllerAdShown', 'youtubeUiCleanerAdShown', 'lastPromotedExtensionAd', ", '', 'tracking storage');
  js = replaceRequired(js, /\n        if \(!result.reviewClicked[\s\S]*?\n        }(?=\n    } catch)/, '', 'engagement initialization');
  js = removeRange(js, '    // 3. Bind Review Link', '    // 4. Start Polling', 'engagement bindings');
  js = removeRange(js, 'function determineStoreUrl()', 'function setMode(', 'browser routing');
  // Safari preferences are explicitly device-local. Keep the shared key names and bootstrap ordering.
  js = js.replaceAll('chrome.storage.sync', 'chrome.storage.local');
  js = replaceRequired(js, 'updateStats(response);', 'updateStats(response);\n                    updateSafariPlaybackState(response);', 'native playback status');
  js = replaceRequired(js, 'function shouldShowGeolocationNotice(data, now = Date.now()) {', 'function shouldShowGeolocationNotice(data, now = Date.now()) {\n    if (data.nativePlayback) return false;', 'native location guidance');
  let content = (await read('content.js')).replaceAll('chrome.storage.sync', 'chrome.storage.local').replace("area === 'sync'", "area === 'local'");
  content = replaceRequired(content, '/* PLATFORM_CONTENT */', await read('platforms/safari/native-content.js'), 'native content bridge');
  await writeFile(path.join(destination, 'content.js'), content);
  await writeFile(path.join(destination, 'popup.js'), js);
  await writeFile(path.join(destination, 'popup.html'), html);
  await writeFile(path.join(destination, 'safari-actions.js'), (await read('platforms/safari/actions.js')) + '\n' + await read('platforms/safari/native-popup.js'));
  await cp(path.join(root, 'platforms/safari/popup.css'), path.join(destination, 'safari-popup.css'));
  await mkdir(path.join(destination, 'injected/safari'), { recursive: true });
  for (const file of safariNativeModules) await cp(path.join(root, 'platforms/safari', file), path.join(destination, 'injected/safari', file));
  let entry = await read('injected/index.js');
  entry = "import { initNativeHls } from './safari/native-playback.js';\nimport { selectRepresentation } from './stream-model.js';\n" + entry;
  entry = replaceRequired(entry, 'initNetworkHooks({ analyzeUrl, parseManifest });', 'initNetworkHooks({ analyzeUrl, parseManifest });\ninitNativeHls({ parseHlsManifest, getRepresentations, getConfig, selectRepresentation });', 'native HLS initialization');
  await writeFile(path.join(destination, 'injected/index.js'), entry);
  for (const entry of await readdir(path.join(destination, '_locales'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(destination, '_locales', entry.name, 'messages.json');
    const messages = JSON.parse(await readFile(file, 'utf8'));
    removedKeys.forEach(key => delete messages[key]);
    const translated = translations[entry.name];
    if (!translated) throw Error(`Missing Apple action translations for ${entry.name}`);
    ['rateThisApp', 'supportOptions', 'ratingUnavailable'].forEach((key, i) => { messages[key] = { message: translated[i] }; });
    if ([...messages.appName.message].length > 40) throw Error(`Safari extension name exceeds 40 characters: ${entry.name}`);
    await writeFile(file, JSON.stringify(messages, null, 2) + '\n');
  }
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (/\.(js|html|css|json|md|svg|txt)$/.test(file) && forbidden.test(await readFile(file, 'utf8'))) throw Error(`Forbidden Safari content: ${file}`);
    }
  }
  await scan(destination);
}

for (const target of targets) {
  const destination = path.join(dist, target);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of target === 'safari' ? safariFiles : browserFiles) {
    if (file.includes('..') || path.isAbsolute(file) || file.includes('*')) throw Error(`Unsafe runtime resource: ${file}`);
    await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await cp(path.join(root, file), path.join(destination, file), { recursive: true, filter: p => path.basename(p) !== '.DS_Store' });
  }
  const outputManifest = structuredClone(manifest);
  if (target !== 'firefox') delete outputManifest.browser_specific_settings;
  if (target === 'safari') outputManifest.web_accessible_resources[0].resources.push(...safariNativeModules.map(file => `injected/safari/${file}`));
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(outputManifest, null, 4) + '\n');
  if (target === 'safari') {
    await safari(destination);
    const declared = new Set(outputManifest.web_accessible_resources.flatMap(entry => entry.resources));
    for (const file of await moduleGraph('injected/index.js', new Set(), destination)) {
      if (!declared.has(file)) throw Error(`Undeclared Safari module: ${file}`);
    }
  }
  const archive = path.join(dist, `paramount-quality-plus-${target}.zip`);
  await rm(archive, { force: true });
  const result = spawnSync('zip', ['-q', '-r', archive, '.'], { cwd: destination, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr);
  console.log(`Built dist/${target} and ${path.basename(archive)}`);
}
