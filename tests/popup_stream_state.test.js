import { expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

function loadPopup() {
  document.body.innerHTML = `
    <button id="btn-auto"></button><button id="btn-max"></button>
    <span id="res-val">1080p</span><span id="bitrate-val">5.8 Mbps</span>
    <div id="quality-list-container"><div id="quality-list"></div></div>`;
  const context = {
    chrome: { i18n: { getMessage: jest.fn(() => '') }, runtime: {}, storage: { sync: { set: jest.fn() } } },
    document, navigator, console, Date, setTimeout, clearTimeout, setInterval
  };
  vm.createContext(context);
  vm.runInContext(popupSource, context);
  return context;
}

test('clears stale statistics and quality controls while a new title loads', () => {
  const popup = loadPopup();
  popup.renderQualityList([{ id: '1080', height: 1080, bandwidth: 5800000 }]);
  popup.updateStats({ resolution: null, bitrate: null });
  popup.renderQualityList([]);

  expect(document.getElementById('res-val').textContent).toBe('--');
  expect(document.getElementById('bitrate-val').textContent).toBe('--');
  expect(document.getElementById('quality-list').children).toHaveLength(0);
  expect(document.getElementById('quality-list-container').classList.contains('hidden')).toBe(true);
});

test('renders ladder labels as text rather than manifest-provided HTML', () => {
  const popup = loadPopup();
  popup.renderQualityList([{ id: 'unsafe', height: '<img src=x>', bandwidth: 5800000 }]);

  const button = document.querySelector('#quality-list button');
  expect(button.querySelector('img')).toBeNull();
  expect(button.textContent).toContain('<img src=x>p');
});
