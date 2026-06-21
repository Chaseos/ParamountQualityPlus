import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

function createClassList() {
    return {
        add: jest.fn(),
        remove: jest.fn(),
        toggle: jest.fn()
    };
}

function loadPopupContext({ sendMessageResponse = { outcome: 'granted' }, lastError = null } = {}) {
    const elements = {
        toast: {
            textContent: '',
            classList: createClassList(),
            timeout: null
        },
        'geo-notice': {
            classList: createClassList()
        }
    };

    const context = {
        chrome: {
            i18n: {
                getMessage: jest.fn((key) => ({
                    locationAccessGranted: 'Location allowed. Refresh playback if quality options do not appear.',
                    locationPromptUnavailable: 'Open Paramount+ site settings and allow location, then refresh playback.'
                })[key] || '')
            },
            runtime: {
                id: '',
                getURL: jest.fn(() => ''),
                lastError
            },
            tabs: {
                query: jest.fn((query, callback) => callback([{ id: 7 }])),
                sendMessage: jest.fn((tabId, message, callback) => callback(sendMessageResponse))
            }
        },
        document: {
            addEventListener: jest.fn(),
            getElementById: jest.fn((id) => elements[id] || null)
        },
        navigator: {
            userAgent: '',
            userAgentData: { brands: [] }
        },
        console,
        setInterval: jest.fn(),
        setTimeout: jest.fn((callback) => {
            callback();
            return 1;
        }),
        clearTimeout: jest.fn()
    };

    vm.createContext(context);
    vm.runInContext(popupSource, context);
    return { context, elements };
}

describe('Geolocation notice', () => {
    test('shows when playback is detected but quality options never appear and location may be blocked', () => {
        const { context } = loadPopupContext();

        expect(context.shouldShowGeolocationNotice({
            playbackDetected: true,
            hasActiveStream: true,
            resolution: '720p',
            bitrate: 2800,
            manifestQualities: [],
            initializedAt: 1_000,
            geolocationPermission: 'denied'
        }, 10_000)).toBe(true);
    });

    test('hides when quality options are available', () => {
        const { context } = loadPopupContext();

        expect(context.shouldShowGeolocationNotice({
            playbackDetected: true,
            manifestQualities: [{ id: '1080', height: 1080 }],
            initializedAt: 1_000,
            geolocationPermission: 'denied'
        }, 10_000)).toBe(false);
    });

    test('hides when location is already granted', () => {
        const { context } = loadPopupContext();

        expect(context.shouldShowGeolocationNotice({
            playbackDetected: true,
            manifestQualities: [],
            initializedAt: 1_000,
            geolocationPermission: 'granted'
        }, 10_000)).toBe(false);
    });

    test('request button asks the active Paramount+ tab to trigger the site location prompt', () => {
        const { context, elements } = loadPopupContext({ sendMessageResponse: { outcome: 'granted' } });

        context.requestLocationAccess();

        expect(context.chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true }, expect.any(Function));
        expect(context.chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            { type: 'REQUEST_GEOLOCATION_PERMISSION' },
            expect.any(Function)
        );
        expect(elements.toast.textContent).toBe('Location allowed. Refresh playback if quality options do not appear.');
    });

    test('request button falls back to site settings copy when the prompt cannot be shown', () => {
        const { context, elements } = loadPopupContext({ sendMessageResponse: { outcome: 'denied' } });

        context.requestLocationAccess();

        expect(elements.toast.textContent).toBe('Open Paramount+ site settings and allow location, then refresh playback.');
    });
});
