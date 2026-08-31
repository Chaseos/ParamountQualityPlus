import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('shared reinjection installs listeners once and can retry a failed module load', () => {
  const source = readFileSync('content.js', 'utf8');
  const scripts = [];
  const context = vm.createContext({
    window: { sessionStorage: { getItem: () => null, setItem() {} }, addEventListener: jest.fn(), postMessage: jest.fn() },
    document: { createElement: () => ({ remove() {} }), head: { appendChild: script => scripts.push(script) } },
    chrome: { runtime: { getURL: x => x, onMessage: { addListener: jest.fn() } },
      storage: { sync: { get: (_keys, cb) => cb({}) }, onChanged: { addListener: jest.fn() } } }, console
  });
  vm.runInContext(source, context);
  vm.runInContext(source, context);
  expect(scripts).toHaveLength(1);
  scripts[0].onerror();
  vm.runInContext(source, context);
  expect(scripts).toHaveLength(2);
  expect(context.chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  expect(context.chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  expect(context.window.addEventListener).toHaveBeenCalledTimes(2);
});
