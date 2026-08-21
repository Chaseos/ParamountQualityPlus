import { expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

function makeElement() {
  const classes = new Set();
  const attributes = new Map();
  return {
    children: [],
    dataset: {},
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
      contains: value => classes.has(value)
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name)
  };
}

test('popup renders the recovery Auto mode instead of the saved Force Max preference', () => {
  const elements = {
    'btn-auto': makeElement(),
    'btn-max': makeElement(),
    'quality-list': makeElement(),
    'connection-dot': makeElement()
  };
  const response = {
    appliedConfig: { forceMax: false, forcedId: null, forcedHeight: null },
    recoveryActive: true
  };
  const context = {
    chrome: {
      i18n: { getMessage: jest.fn(() => '') },
      runtime: { id: '', getURL: jest.fn(() => '') },
      storage: { sync: { set: jest.fn((value, callback) => callback?.()) } },
      tabs: {
        query: jest.fn((query, callback) => callback([{ id: 42, url: 'https://www.paramountplus.com/' }])),
        sendMessage: jest.fn((tabId, message, callback) => callback?.(response))
      }
    },
    document: {
      addEventListener: jest.fn(),
      getElementById: jest.fn(id => elements[id] || null)
    },
    navigator: { userAgent: '', userAgentData: { brands: [] } },
    console,
    setInterval: jest.fn(),
    setTimeout: jest.fn(),
    clearTimeout: jest.fn(),
    URL,
    Date
  };

  vm.createContext(context);
  vm.runInContext(popupSource, context);
  context.setMode(true, null);
  expect(elements['btn-max'].classList.contains('active')).toBe(true);

  context.startPolling();

  expect(elements['btn-auto'].classList.contains('active')).toBe(true);
  expect(elements['btn-max'].classList.contains('active')).toBe(false);
  expect(elements['connection-dot'].classList.contains('active')).toBe(true);
  expect(elements['connection-dot'].title).toBe('Connected');
  expect(elements['connection-dot'].getAttribute('aria-label')).toBe('Connected');
});
