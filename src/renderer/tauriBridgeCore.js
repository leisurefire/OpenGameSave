const { ROLE_FILES, getRoleCapabilities } = require('../shared/ipcPolicy');
const ENGLISH = require('../locale/en_US.json');
const CHINESE = require('../locale/zh_CN.json');

const EVENT_NAME = 'ogs:event';
const DEFAULT_ACCENT_COLOR = '#16c60c';
const MAX_BOOT_EVENTS = 256;
const MAX_TRANSLATIONS = 1024;

function catalogTranslation(language, key, options) {
    const find = catalog => {
        let value = catalog;
        for (const part of key.split('.')) {
            if (!value || !Object.prototype.hasOwnProperty.call(value, part)) return null;
            value = value[part];
        }
        return typeof value === 'string' ? value : null;
    };
    let translated = find(language === 'zh_CN' ? CHINESE : ENGLISH) ?? find(ENGLISH) ?? key;
    if (options && typeof options === 'object' && !Array.isArray(options)) {
        for (const name of Object.keys(options).sort()) {
            const value = options[name];
            if (value === undefined) continue;
            const replacement = typeof value === 'string' ? value : JSON.stringify(value);
            translated = translated.replaceAll(`{{${name}}}`, () => replacement);
        }
    }
    return translated;
}

// This adapter preserves the UI's channel API. Rust independently authorizes
// every command using its registered window; these checks are only UI guards.
function createTauriBridge({ invoke, listen, targetWindow, targetDocument, reportError = console.error }) {
    let disposed = false;
    let active = false;
    let unlisten = null;
    let role = null;
    let capabilities = null;
    let readyNotification = null;
    let language = null;
    let translationGeneration = 0;
    const translations = new Map();
    const listeners = new Map();
    const pendingEvents = [];

    function setAccentColor(color) {
        if (!disposed && /^#[0-9a-f]{6}$/i.test(color)) {
            targetDocument.documentElement?.style.setProperty('--system-accent', color);
        }
    }

    function assertAllowed(direction, channel) {
        if (disposed) throw new Error('The window bridge has been disposed');
        if (!capabilities?.[direction]?.has(channel)) {
            throw new Error(`Blocked IPC ${direction} channel for renderer role "${role || 'unknown'}": ${channel}`);
        }
    }

    function report(error) {
        reportError('Tauri window bridge:', error);
    }

    function setLanguage(nextLanguage) {
        language = typeof nextLanguage === 'string' ? nextLanguage : null;
        translationGeneration++;
        translations.clear();
    }

    function translate(key, options) {
        assertAllowed('invoke', 'translate');
        if (typeof key !== 'string') return api.invoke('translate', key, options);
        const cacheKey = JSON.stringify([key, options]);
        if (translations.has(cacheKey)) return translations.get(cacheKey);
        const generation = translationGeneration;
        const request = language === null
            ? api.invoke('translate', key, options)
            : Promise.resolve(catalogTranslation(language, key, options));
        const result = request.then(value => generation === translationGeneration ? value : translate(key, options));
        if (translations.size >= MAX_TRANSLATIONS) translations.delete(translations.keys().next().value);
        translations.set(cacheKey, result);
        result.catch(() => {
            if (translations.get(cacheKey) === result) translations.delete(cacheKey);
        });
        return result;
    }

    function deliver({ channel, args }) {
        // Update before subscribers request labels. Old pending results cannot
        // overwrite the selected language or repopulate its translation cache.
        if (channel === 'apply-language') setLanguage(args[0]);
        if (channel === 'accent-color-changed') setAccentColor(args[0]);
        for (const callback of [...(listeners.get(channel) || [])]) {
            if (disposed) break;
            try {
                Promise.resolve(callback(...args)).catch(report);
            } catch (error) {
                report(error);
            }
        }
    }

    function onEvent(event) {
        const payload = event?.payload;
        if (disposed || !payload || typeof payload.channel !== 'string'
            || !capabilities.receive.has(payload.channel) || !Array.isArray(payload.args)) return;
        if (!active) {
            if (pendingEvents.length >= MAX_BOOT_EVENTS) {
                report(new Error('Window event queue exceeded its startup limit'));
                return;
            }
            pendingEvents.push(payload);
        } else {
            deliver(payload);
        }
    }

    const api = Object.freeze({
        can(direction, channel) {
            return ['send', 'invoke', 'receive'].includes(direction)
                && !disposed && capabilities?.[direction]?.has(channel) === true;
        },
        invoke(channel, ...args) {
            assertAllowed('invoke', channel);
            return invoke('dispatch', { channel, args, direction: 'invoke' });
        },
        send(channel, ...args) {
            assertAllowed('send', channel);
            // Existing callers can ignore the return value. Callers that close
            // a window await it so the host finishes the action before disposal.
            let operation;
            try {
                operation = Promise.resolve(invoke('dispatch', { channel, args, direction: 'send' }));
            } catch (error) {
                operation = Promise.reject(error);
            }
            operation.catch(report);
            return operation;
        },
        receive(channel, callback) {
            assertAllowed('receive', channel);
            if (typeof callback !== 'function') throw new TypeError('IPC receive callback must be a function');
            if (!listeners.has(channel)) listeners.set(channel, new Set());
            // A wrapper keeps separate subscriptions of the same callback
            // independently removable, matching the old API.
            const listener = (...args) => callback(...args);
            listeners.get(channel).add(listener);
            return () => {
                const subscribers = listeners.get(channel);
                subscribers?.delete(listener);
                if (subscribers?.size === 0) listeners.delete(channel);
            };
        }
    });

    function dispose() {
        if (disposed) return;
        disposed = true;
        listeners.clear();
        translations.clear();
        pendingEvents.length = 0;
        targetWindow.removeEventListener('pagehide', dispose);
        if (unlisten) {
            const release = unlisten;
            unlisten = null;
            try { Promise.resolve(release()).catch(report); } catch (error) { report(error); }
        }
    }

    targetWindow.addEventListener('pagehide', dispose, { once: true });

    const ready = (async () => {
        try {
            const context = await invoke('get_window_context');
            if (disposed) throw new Error('Window closed during bridge initialization');
            if (typeof context?.role !== 'string' || !Object.prototype.hasOwnProperty.call(ROLE_FILES, context.role)) {
                throw new Error('The host did not register a valid window role');
            }
            role = context.role;
            setLanguage(context.language);
            const policy = getRoleCapabilities(role);
            capabilities = Object.fromEntries(['send', 'invoke', 'receive'].map(direction => [direction, new Set(policy[direction])]));
            const release = await listen(EVENT_NAME, onEvent);
            if (disposed) {
                release();
                throw new Error('Window closed while subscribing to host events');
            }
            unlisten = release;
            const i18n = Object.freeze({
                changeLanguage: async nextLanguage => {
                    const selectedLanguage = await api.invoke('change-language', nextLanguage);
                    setLanguage(selectedLanguage);
                    return selectedLanguage;
                },
                translate
            });
            Object.defineProperties(targetWindow, {
                api: { value: api, writable: false, configurable: false },
                i18n: { value: i18n, writable: false, configurable: false }
            });
            setAccentColor(DEFAULT_ACCENT_COLOR);
            try { setAccentColor(await api.invoke('get-window-accent-color')); } catch (error) { report(error); }
            if (disposed) throw new Error('Window closed during bridge initialization');
            return api;
        } catch (error) {
            dispose();
            throw error;
        }
    })();

    function notifyReady() {
        if (!readyNotification) {
            readyNotification = ready.then(async () => {
                if (disposed) throw new Error('The window bridge has been disposed');
                active = true;
                for (const event of pendingEvents.splice(0)) deliver(event);
                // The host may now deliver initial menu/modal data and show
                // hidden windows; all page event handlers are registered.
                await invoke('renderer_ready');
            });
        }
        return readyNotification;
    }

    return Object.freeze({ ready, notifyReady, dispose });
}

module.exports = { createTauriBridge };
