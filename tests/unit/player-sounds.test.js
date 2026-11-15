'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, CONFIG } = require('./sandbox');

const plain = x => JSON.parse(JSON.stringify(x));

// The player only needs a document to register its key handler at load time.
const doc = () => ({ addEventListener() {}, getElementById: () => null, hidden: false, documentElement: { classList: { add() {}, remove() {} } } });

test('subtitles: SRT, WebVTT and ASS are parsed into timed lines', () => {
    const { ctx } = load({ scripts: ['js/plex.js', 'js/player.js'], globals: Object.assign(plain(CONFIG), { document: doc() }) });
    const srt = ctx.Player._parseSubs('1\r\n00:00:01,500 --> 00:00:03,000\r\nHello <i>there</i>\r\n\r\n2\r\n00:01:00,000 --> 00:01:02,250\r\nSecond\r\nline\r\n');
    assert.deepEqual(plain(srt), [{ start: 1500, end: 3000, text: 'Hello <i>there</i>' }, { start: 60000, end: 62250, text: 'Second\nline' }]);
    const vtt = ctx.Player._parseSubs('WEBVTT\n\n00:00:05.000 --> 00:00:06.000 align:center\n<c.yellow>Coloured</c>\n');
    assert.deepEqual(plain(vtt), [{ start: 5000, end: 6000, text: 'Coloured' }]);
    const ass = ctx.Player._parseSubs('[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
        'Dialogue: 0,0:00:02.00,0:00:04.50,Default,,0,0,0,,{\\an8}Top line\\Nsecond, with comma\n');
    assert.deepEqual(plain(ass), [{ start: 2000, end: 4500, text: 'Top line\nsecond, with comma' }]);
    assert.deepEqual(plain(ctx.Player._parseSubs('')), []);
    assert.equal(ctx.Player.isOpen(), false);
});

function audioContext() {
    const made = { oscillators: 0 };
    class Param { setValueAtTime() {} exponentialRampToValueAtTime() {} }
    class Node { connect() {} }
    class Osc extends Node { constructor() { super(); this.frequency = new Param(); } start() {} stop() {} }
    class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
    class Filter extends Node { constructor() { super(); this.frequency = { value: 0 }; } }
    class AC {
        constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
        resume() { this.state = 'running'; }
        createOscillator() { made.oscillators++; return new Osc(); }
        createGain() { return new Gain(); }
        createBiquadFilter() { return new Filter(); }
    }
    return { AC, made };
}

test('remote sounds: on by default, every sound plays, held arrows are throttled, off is silent and saved', async () => {
    const { AC, made } = audioContext();
    const { ctx, storage } = load({ scripts: ['js/sounds.js'], globals: { AudioContext: AC } });
    assert.equal(ctx.Sounds.enabled(), true);
    ctx.Sounds.play('select'); assert.equal(made.oscillators, 2);
    ctx.Sounds.play('back'); assert.equal(made.oscillators, 4);
    ctx.Sounds.play('intro'); assert.equal(made.oscillators, 13);
    ctx.Sounds.play('move'); ctx.Sounds.play('move');
    assert.equal(made.oscillators, 14, 'a second move within 35 ms is skipped');
    await new Promise(r => setTimeout(r, 40));
    ctx.Sounds.play('move'); assert.equal(made.oscillators, 15);
    ctx.Sounds.setEnabled(false);
    ctx.Sounds.play('select'); assert.equal(made.oscillators, 15);
    assert.equal(storage.getItem('medialoader.sounds'), 'off');
    const again = load({ scripts: ['js/sounds.js'], storage: { 'medialoader.sounds': 'off' }, globals: { AudioContext: AC } });
    assert.equal(again.ctx.Sounds.enabled(), false);
    const noAudio = load({ scripts: ['js/sounds.js'] });
    noAudio.ctx.Sounds.play('select');          // no Web Audio: silently nothing
});
