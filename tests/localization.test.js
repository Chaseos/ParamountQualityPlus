import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesRoot = path.join(projectRoot, '_locales');

async function readMessages(locale) {
  return JSON.parse(await readFile(path.join(localesRoot, locale, 'messages.json'), 'utf8'));
}

test('every locale has the same complete message catalog as English', async () => {
  const localeEntries = await readdir(localesRoot, { withFileTypes: true });
  const locales = localeEntries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const englishMessages = await readMessages('en');
  const englishKeys = Object.keys(englishMessages).sort();

  for (const locale of locales) {
    const messages = await readMessages(locale);
    expect(Object.keys(messages).sort()).toEqual(englishKeys);

    for (const [key, entry] of Object.entries(messages)) {
      expect(typeof entry.message).toBe('string');
      expect(entry.message.trim()).not.toBe('');
      expect(typeof entry.description).toBe('string');
      expect(entry.description.trim()).not.toBe('');
    }
  }
});

test('manifest and popup localization references exist in the English catalog', async () => {
  const englishMessages = await readMessages('en');
  const manifestSource = await readFile(path.join(projectRoot, 'manifest.json'), 'utf8');
  const popupHtml = await readFile(path.join(projectRoot, 'popup.html'), 'utf8');
  const popupScript = await readFile(path.join(projectRoot, 'popup.js'), 'utf8');
  const referencedKeys = new Set();

  for (const match of manifestSource.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    referencedKeys.add(match[1]);
  }
  for (const match of popupHtml.matchAll(/data-i18n(?:-title|-aria-label)?="([A-Za-z0-9_]+)"/g)) {
    referencedKeys.add(match[1]);
  }
  for (const match of popupScript.matchAll(/chrome\.i18n\.getMessage\(["']([A-Za-z0-9_]+)["']\)/g)) {
    referencedKeys.add(match[1]);
  }

  expect([...referencedKeys].filter(key => !englishMessages[key])).toEqual([]);
});

test('localized manifest metadata stays within Chrome length limits', async () => {
  const localeEntries = await readdir(localesRoot, { withFileTypes: true });
  const locales = localeEntries.filter(entry => entry.isDirectory()).map(entry => entry.name);

  for (const locale of locales) {
    const messages = await readMessages(locale);
    expect([...messages.appName.message].length).toBeLessThanOrEqual(75);
    expect([...messages.appDesc.message].length).toBeLessThanOrEqual(132);
  }
});

test('Spain and Latin American Spanish preserve regional terminology', async () => {
  const spain = await readMessages('es');
  const latinAmerica = await readMessages('es_419');
  const regionSensitiveKeys = [
    'appDesc',
    'qualityControl',
    'settingsSaved',
    'advancedPrefetchDesc',
    'locationNoticeBody'
  ];

  for (const key of regionSensitiveKeys) {
    expect(spain[key].message).not.toBe(latinAmerica[key].message);
  }

  expect(spain.appDesc.message).toContain('vídeos');
  expect(spain.locationNoticeBody.message).toContain('en directo');
  expect(latinAmerica.appDesc.message).toContain('videos');
  expect(latinAmerica.locationNoticeBody.message).toContain('en vivo');
});

test('README documents every packaged locale', async () => {
  const localeEntries = await readdir(localesRoot, { withFileTypes: true });
  const locales = localeEntries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');

  for (const locale of locales) {
    expect(readme).toContain(`\`${locale}\``);
  }
});

test('popup HTML fallbacks match the English catalog', async () => {
  const englishMessages = await readMessages('en');
  const popupHtml = await readFile(path.join(projectRoot, 'popup.html'), 'utf8');
  const textFallbacks = [...popupHtml.matchAll(/<[^>]*\bdata-i18n="([A-Za-z0-9_]+)"[^>]*>([^<]*)<\//g)];
  const attributeFallbacks = [
    ...popupHtml.matchAll(/<[^>]*\bdata-i18n-(title|aria-label)="([A-Za-z0-9_]+)"[^>]*>/g)
  ];

  expect(textFallbacks.length).toBeGreaterThan(0);
  for (const [, key, fallback] of textFallbacks) {
    expect(fallback.trim()).toBe(englishMessages[key].message);
  }
  for (const [tag, attribute, key] of attributeFallbacks) {
    const fallback = tag.match(new RegExp(`\\s${attribute}="([^"]*)"`));
    expect(fallback?.[1]).toBe(englishMessages[key].message);
  }
});

test('popup script fallbacks match the English catalog', async () => {
  const englishMessages = await readMessages('en');
  const popupScript = await readFile(path.join(projectRoot, 'popup.js'), 'utf8');
  const fallbackPattern = /chrome\.i18n\.getMessage\("([A-Za-z0-9_]+)"\)\s*\|\|\s*"([^"]*)"/g;
  const fallbacks = [...popupScript.matchAll(fallbackPattern)];

  expect(fallbacks.length).toBeGreaterThan(0);
  for (const [, key, fallback] of fallbacks) {
    expect(fallback).toBe(englishMessages[key].message);
  }
});

test('advanced settings disclosure exposes accessible state and keyboard semantics', async () => {
  const popupHtml = await readFile(path.join(projectRoot, 'popup.html'), 'utf8');
  const popupScript = await readFile(path.join(projectRoot, 'popup.js'), 'utf8');
  const toggle = popupHtml.match(/<button\b[^>]*\bid="advanced-toggle"[^>]*>/)?.[0];
  const content = popupHtml.match(/<div\b[^>]*\bid="advanced-content"[^>]*>/)?.[0];

  expect(toggle).toBeDefined();
  expect(toggle).toContain('type="button"');
  expect(toggle).toContain('aria-expanded="false"');
  expect(toggle).toContain('aria-controls="advanced-content"');
  expect(content).toContain('hidden');
  expect(popupScript).toContain("setAttribute('aria-expanded', String(!expanded))");
  expect(popupScript).toContain('advancedContent.hidden = expanded');

  const status = popupHtml.match(/<div\b[^>]*\bid="connection-dot"[^>]*>/)?.[0];
  expect(status).toContain('role="status"');
  expect(status).toContain('aria-live="polite"');
  expect(status).toContain('data-i18n-aria-label="notConnected"');
  expect(popupScript).toContain("const statusKey = connected ? 'connected' : 'notConnected'");
});
