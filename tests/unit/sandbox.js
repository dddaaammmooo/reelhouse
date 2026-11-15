/*
 * Loads Reelhouse's browser scripts into an isolated context for unit tests:
 *   - XMLHttpRequest answered by tests/mock/world.js (or a test's own handler first)
 *   - an in-memory localStorage
 *   - optional stand-ins for the TV (tizen, webapis) and Web Audio
 * Scripts are run with their real file paths, so code coverage maps back to js/*.js.
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const world = require('../mock/world');

const ROOT = path.resolve(__dirname, '..', '..');

function storage(initial) {
    const map = new Map(Object.entries(initial || {}));
    return {
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: k => { map.delete(k); },
        clear: () => map.clear(),
        key: i => Array.from(map.keys())[i] || null,
        get length() { return map.size; },
        _map: map
    };
}

/*
 * options:
 *   scripts:  files under js/ to load, in order
 *   handler:  (method, url, body) => response | undefined   (checked before the mock world)
 *   storage:  initial localStorage contents
 *   globals:  extra globals (e.g. tizen, webapis, document)
 *   protocol: location.protocol (default 'file:', i.e. not via the Docker proxies)
 */
function load(options) {
    const opts = options || {};
    const requests = [];
    const ls = storage(opts.storage);
    class FakeXHR {
        constructor() { this.headers = {}; this.status = 0; this.responseText = ''; this.listeners = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(k, v) { this.headers[k] = v; }
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
        getResponseHeader(name) { return (this.resHeaders || {})[String(name).toLowerCase()] || null; }
        send(body) {
            const req = { method: this.method, url: this.url, body: body || null, headers: this.headers };
            requests.push(req);
            setTimeout(() => {
                let res = opts.handler ? opts.handler(this.method, this.url, body) : undefined;
                if (res === undefined) { res = world.route(this.method, this.url, body); }
                if (res === 'error' || res === null && opts.strict) { this.onerror && this.onerror(); this.emit('loadend'); return; }
                if (res === 'timeout') { this.ontimeout && this.ontimeout(); this.emit('loadend'); return; }
                if (!res) { res = { status: 404, body: '' }; }
                this.status = res.status || 200;
                this.resHeaders = res.headers || {};
                if (this.responseType === 'arraybuffer') { this.response = res.buffer || new ArrayBuffer(0); }
                this.responseText = typeof res.body === 'string' ? res.body : JSON.stringify(res.body === undefined ? null : res.body);
                this.onload && this.onload();
                this.emit('loadend');
            }, 0);
        }
        emit(ev) { (this.listeners[ev] || []).forEach(fn => fn()); }
    }
    const context = {
        console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, Object, Array, String, Number,
        Boolean, RegExp, Error, TypeError, Map, Set, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, URL, Uint8Array, DataView, ArrayBuffer, Blob: class { constructor(parts, o) { this.parts = parts; this.type = o && o.type; } },
        XMLHttpRequest: FakeXHR,
        localStorage: ls,
        location: { protocol: opts.protocol || 'file:' }
    };
    Object.assign(context, opts.globals || {});
    context.window = context;
    context.self = context;
    vm.createContext(context);
    (opts.scripts || []).forEach(rel => {
        const file = path.join(ROOT, rel);
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    });
    return { ctx: context, requests, storage: ls };
}

// Default configuration (what js/config.js provides in a real build), with test keys.
const CONFIG = {
    MEDIALOADER_DEFAULTS: {
        tv: { url: 'http://media-server:8989', apiKey: 'test-sonarr-key', qualityProfile: 'HD-1080p' },
        movie: { url: 'http://media-server:7878', apiKey: 'test-radarr-key', qualityProfile: 'Low Quality 1080' },
        music: { url: 'http://media-server:8686', apiKey: 'test-lidarr-key', qualityProfile: '' }
    },
    MEDIALOADER_PLEX: { url: 'http://plex-server:32400', token: 'test-plex-token' },
    MEDIALOADER_TMDB: { token: 'test-tmdb-token' }
};

const tick = ms => new Promise(r => setTimeout(r, ms || 0));

module.exports = { load, CONFIG, tick, world, ROOT };
