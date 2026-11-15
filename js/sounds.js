/*
 * Remote sounds: short UI clicks synthesised with Web Audio (no audio files to load or decode).
 *   move   – soft tick on arrow keys
 *   select – brighter two-note click on OK
 *   back   – lower, falling tone on Back
 *   intro  – short start-up chime as the loading screen fades out
 * On by default; the choice is saved in localStorage['medialoader.sounds'] ('off' = disabled).
 */
var Sounds = (function () {
    'use strict';

    const KEY = 'medialoader.sounds';
    let on = true;
    try { on = localStorage.getItem(KEY) !== 'off'; } catch (e) { /* storage unavailable: keep default */ }

    let ctx = null, master = null, lastMove = 0;

    function audio() {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { return null; }
            try { ctx = new AC(); } catch (e) { return null; }
            master = ctx.createGain();
            master.gain.value = 0.9;
            master.connect(ctx.destination);
        }
        if (ctx.state === 'suspended' && ctx.resume) { ctx.resume(); }   // desktop browsers start suspended until a key press
        return ctx;
    }

    // One short tone: pitch glides from f0 to f1 while the volume rises fast and decays.
    function tone(type, f0, f1, peak, length, delay) {
        const c = ctx, t = c.currentTime + (delay || 0);
        const osc = c.createOscillator(), gain = c.createGain(), filter = c.createBiquadFilter();
        osc.type = type;
        osc.frequency.setValueAtTime(f0, t);
        osc.frequency.exponentialRampToValueAtTime(f1, t + length * 0.6);
        filter.type = 'lowpass';
        filter.frequency.value = 4000;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
        osc.connect(filter); filter.connect(gain); gain.connect(master);
        osc.start(t);
        osc.stop(t + length + 0.02);
    }

    function play(name) {
        if (!on || !audio()) { return; }
        try {
            if (name === 'move') {
                const now = Date.now();
                if (now - lastMove < 35) { return; }          // holding an arrow: don't stack clicks
                lastMove = now;
                tone('triangle', 1500, 1050, 0.09, 0.05);
            } else if (name === 'select') {
                tone('sine', 820, 900, 0.11, 0.09);
                tone('sine', 1230, 1350, 0.06, 0.11, 0.035);
            } else if (name === 'intro') {
                // Start-up chime: a rising C major arpeggio, the last note held over a soft low C.
                [[523.25, 0], [659.25, 0.13], [783.99, 0.26], [1046.5, 0.39]].forEach((n, i) => {
                    const last = i === 3;
                    tone('sine', n[0], n[0], 0.08, last ? 1.5 : 0.55, n[1]);
                    tone('triangle', n[0] * 2, n[0] * 2, 0.012, last ? 1.0 : 0.35, n[1]);
                });
                tone('sine', 261.63, 261.63, 0.05, 1.9, 0.39);
            } else if (name === 'back') {
                tone('sine', 700, 430, 0.12, 0.14);
                tone('triangle', 1050, 640, 0.03, 0.10);
            }
        } catch (e) { /* audio is optional */ }
    }

    return {
        play,
        enabled: () => on,
        setEnabled: value => {
            on = !!value;
            try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) { /* not saved */ }
        }
    };
}());
