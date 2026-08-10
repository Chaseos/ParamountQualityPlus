import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

function loadPopup() {
  const storageSet = jest.fn((value, callback) => callback());
  const sendMessage = jest.fn();
  const context = {
    chrome: {
      i18n: { getMessage: jest.fn(() => '') },
      runtime: { id: '', getURL: jest.fn(() => '') },
      storage: { sync: { set: storageSet } },
      tabs: {
        query: jest.fn((query, callback) => callback([{
          id: 42,
          url: 'https://www.paramountplus.com/live-tv/stream/big_brother/id/'
        }])),
        sendMessage
      }
    },
    document: {
      addEventListener: jest.fn(),
      getElementById: jest.fn(() => null)
    },
    navigator: { userAgent: '', userAgentData: { brands: [] } },
    console,
    setInterval: jest.fn(),
    setTimeout: jest.fn(),
    clearTimeout: jest.fn(),
    URL
  };

  vm.createContext(context);
  vm.runInContext(popupSource, context);
  return { context, storageSet, sendMessage };
}

describe('Live quality switching', () => {
  test('persists the target height and requests a controlled live-page reload', () => {
    const { context, storageSet, sendMessage } = loadPopup();

    context.setMode(false, 's0-7', 1080);

    expect(storageSet).toHaveBeenCalledWith(
      { forceMax: false, forcedId: 's0-7', forcedHeight: 1080 },
      expect.any(Function)
    );
    expect(sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({
      type: 'APPLY_QUALITY_CHANGE',
      reloadLivePlayback: true,
      payload: expect.objectContaining({ forcedId: 's0-7', forcedHeight: 1080 })
    }));
  });

  test('does not reload when the selected live quality is unchanged', () => {
    const { context, sendMessage } = loadPopup();

    context.setMode(false, 's0-7', 1080);
    sendMessage.mockClear();
    context.setMode(false, 's0-7', 1080);

    expect(sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({
      reloadLivePlayback: false
    }));
  });
});
