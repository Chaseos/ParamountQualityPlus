import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

function loadPopupContext({ extensionId = "", extensionUrl = "", userAgent = "", brands = [] } = {}) {
    const context = {
        chrome: {
            runtime: {
                id: extensionId,
                getURL: jest.fn(() => extensionUrl)
            }
        },
        document: {
            addEventListener: jest.fn()
        },
        navigator: {
            userAgent,
            userAgentData: { brands }
        },
        console,
        setInterval: jest.fn(),
        setTimeout: jest.fn(),
        clearTimeout: jest.fn()
    };

    vm.createContext(context);
    vm.runInContext(popupSource, context);
    return context;
}

describe('Review routing', () => {
    test('routes known Chrome installs to the Chrome Web Store reviews page', () => {
        const context = loadPopupContext({
            extensionId: 'jdhjjddhdmhphkfgcfclekdngihnoann',
            userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36'
        });

        expect(context.determineStoreUrl()).toBe('https://chromewebstore.google.com/detail/paramount-quality+/jdhjjddhdmhphkfgcfclekdngihnoann/reviews');
    });

    test('routes known Edge installs to the Microsoft Edge Add-ons listing', () => {
        const context = loadPopupContext({
            extensionId: 'cpaekgjghoegidknadojliokbcldohjb',
            userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36'
        });

        expect(context.determineStoreUrl()).toBe('https://microsoftedge.microsoft.com/addons/detail/paramount-quality/cpaekgjghoegidknadojliokbcldohjb');
    });

    test('routes Firefox by extension URL even when the user agent is generic', () => {
        const context = loadPopupContext({
            extensionUrl: 'moz-extension://75d8bb6c-2e0f-4f70-84df-4ac8e8b82d10/',
            userAgent: 'Mozilla/5.0'
        });

        expect(context.determineStoreUrl()).toBe('https://addons.mozilla.org/en-US/firefox/addon/paramount-quality/reviews/');
    });

    test('routes Edge from user-agent client hints when available', () => {
        const context = loadPopupContext({
            userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36',
            brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }]
        });

        expect(context.determineStoreUrl()).toBe('https://microsoftedge.microsoft.com/addons/detail/paramount-quality/cpaekgjghoegidknadojliokbcldohjb');
    });

    test('routes Opera from its Chromium user agent token', () => {
        const context = loadPopupContext({
            userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0'
        });

        expect(context.determineStoreUrl()).toBe('https://addons.opera.com/en/extensions/details/paramount-quality/#feedback-container');
    });
});

describe('Simple Video Speed Controller promotion', () => {
    test('routes promoted extension links to the Chrome Web Store listing by default', () => {
        const context = loadPopupContext({
            userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36'
        });

        expect(context.determineSimpleVideoSpeedControllerStoreUrl()).toBe('https://chromewebstore.google.com/detail/simple-video-speed-contro/kcjfpmjkbkhgojilpihplkedadndnked');
    });

    test('routes promoted extension links to the Firefox listing for Firefox users', () => {
        const context = loadPopupContext({
            extensionUrl: 'moz-extension://75d8bb6c-2e0f-4f70-84df-4ac8e8b82d10/',
            userAgent: 'Mozilla/5.0'
        });

        expect(context.determineSimpleVideoSpeedControllerStoreUrl()).toBe('https://addons.mozilla.org/en-US/firefox/addon/simple-video-speed-controller/');
    });
});

describe('YouTube UI Cleaner promotion', () => {
    test('routes promoted extension links to the Chrome Web Store listing by default', () => {
        const context = loadPopupContext({
            userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36'
        });

        expect(context.determineYouTubeUiCleanerStoreUrl()).toBe('https://chromewebstore.google.com/detail/youtube-ui-cleaner/blnbifjnjgpgfigcpkhcfkiiepokhkdf');
    });

    test('routes promoted extension links to the Firefox listing for Firefox users', () => {
        const context = loadPopupContext({
            extensionUrl: 'moz-extension://75d8bb6c-2e0f-4f70-84df-4ac8e8b82d10/',
            userAgent: 'Mozilla/5.0'
        });

        expect(context.determineYouTubeUiCleanerStoreUrl()).toBe('https://addons.mozilla.org/en-US/firefox/addon/youtube-ui-cleaner/');
    });
});

describe('Promoted extension ad rotation', () => {
    test('does not choose a promoted extension before the review prompt is clicked', () => {
        const context = loadPopupContext();

        expect(context.choosePromotedExtensionAd({
            reviewClicked: false,
            simpleVideoSpeedControllerAdShown: false,
            youtubeUiCleanerAdShown: false
        })).toBeNull();
    });

    test('alternates from the last shown promoted extension when both are available', () => {
        const context = loadPopupContext();

        expect(context.choosePromotedExtensionAd({
            reviewClicked: true,
            simpleVideoSpeedControllerAdShown: false,
            youtubeUiCleanerAdShown: false,
            lastPromotedExtensionAd: 'simpleVideoSpeedController'
        }).id).toBe('youtubeUiCleaner');
        expect(context.choosePromotedExtensionAd({
            reviewClicked: true,
            simpleVideoSpeedControllerAdShown: false,
            youtubeUiCleanerAdShown: false,
            lastPromotedExtensionAd: 'youtubeUiCleaner'
        }).id).toBe('simpleVideoSpeedController');
    });

    test('falls back to the unclicked ad when the rotated choice was already clicked', () => {
        const context = loadPopupContext();

        expect(context.choosePromotedExtensionAd({
            reviewClicked: true,
            simpleVideoSpeedControllerAdShown: true,
            youtubeUiCleanerAdShown: false,
            lastPromotedExtensionAd: 'youtubeUiCleaner'
        }).id).toBe('youtubeUiCleaner');
        expect(context.choosePromotedExtensionAd({
            reviewClicked: true,
            simpleVideoSpeedControllerAdShown: false,
            youtubeUiCleanerAdShown: true,
            lastPromotedExtensionAd: 'simpleVideoSpeedController'
        }).id).toBe('simpleVideoSpeedController');
    });

    test('does not choose a promoted extension after both ads were clicked', () => {
        const context = loadPopupContext();

        expect(context.choosePromotedExtensionAd({
            reviewClicked: true,
            simpleVideoSpeedControllerAdShown: true,
            youtubeUiCleanerAdShown: true,
            lastPromotedExtensionAd: 'simpleVideoSpeedController'
        })).toBeNull();
    });
});
