/*
 * Player: MediaLoader's own video player for movies and episodes on the Plex server.
 *
 * Engines
 *   TV       Samsung AVPlay (webapis.avplay): MKV/MP4/TS, HEVC/H.264/VP9, 4K/HDR, AC3/EAC3 passthrough,
 *            track switching. Video is drawn on the TV's video plane under the (transparent) page.
 *   Browser  HTML5 <video> (desktop testing; plays what the browser can).
 *
 * Plex
 *   - Direct play of the file when the TV can decode it; otherwise Plex's universal transcoder (HLS),
 *     which also converts DTS/TrueHD audio, burns in picture subtitles and lowers the quality on request.
 *   - Resume prompt (viewOffset), Skip Intro / Skip Credits (markers), Up Next for episodes,
 *     scrub thumbnails (the part's BIF index), progress reported with /:/timeline so watched state
 *     and resume points stay in sync, audio/subtitle choices saved to the part like Plex does.
 *   - Subtitles: text tracks inside the file (AVPlay, rendered by us), external subtitle files
 *     (SRT / VTT / ASS, parsed and rendered by us), picture subtitles (burned in by the transcoder).
 *
 * Keys (the player handles its own keys while open)
 *   hidden controls: OK = pause/play + show, Left/Right = scrub back/forward (hold to go faster),
 *                    Up/Down = show controls, Back = stop.  Skip Intro / Up Next take OK when shown.
 *   controls:        arrows move between the scrub bar and buttons, OK presses, Back hides them.
 *   media keys:      play, pause, play/pause, stop, rewind, fast-forward.
 */
var Player = (function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const avplay = () => (typeof webapis !== 'undefined' && webapis.avplay) ? webapis.avplay : null;
    const CLIENT_ID = 'medialoader-tizen-player';
    const KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8,
        PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412, NEXT: 10233, PREV: 10232 };

    /* ---------------- preferences ---------------- */

    const PREFS_KEY = 'medialoader.player';
    const QUALITIES = [
        { id: 'original', label: 'Original quality' },
        { id: '20000', label: '20 Mbps · 1080p', res: '1920x1080' },
        { id: '12000', label: '12 Mbps · 1080p', res: '1920x1080' },
        { id: '8000', label: '8 Mbps · 720p', res: '1280x720' },
        { id: '4000', label: '4 Mbps · 720p', res: '1280x720' },
        { id: '2000', label: '2 Mbps · 480p', res: '720x480' }
    ];
    const SUB_SIZES = [{ id: 'small', label: 'Small' }, { id: 'normal', label: 'Normal' }, { id: 'large', label: 'Large' }];
    let prefs = { quality: 'original', subSize: 'normal', autoNext: true, skipIntro: true, skipCredits: true };
    try { prefs = Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) { /* defaults */ }
    const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* not saved */ } };

    /* ---------------- formats ---------------- */

    // What Samsung's player decodes itself (2019 Tizen 5.0 TVs). Anything else goes through Plex's transcoder.
    const TV_DIRECT = {
        container: ['mkv', 'mp4', 'm4v', 'mov', 'ts', 'mpegts', 'avi', 'webm', 'm2ts', 'wmv', 'asf', 'flv', '3gp', 'mpeg', 'mpg', 'vob'],
        video: ['h264', 'hevc', 'h265', 'mpeg2video', 'mpeg4', 'msmpeg4v3', 'vp8', 'vp9', 'vc1', 'wmv3', 'mjpeg', 'h263'],
        audio: ['aac', 'ac3', 'eac3', 'mp3', 'mp2', 'flac', 'opus', 'vorbis', 'pcm', 'lpcm', 'wmav2', 'wmapro', 'alac']
    };
    const BROWSER_DIRECT = { container: ['mp4', 'm4v', 'webm', 'mov'], video: ['h264', 'vp8', 'vp9'], audio: ['aac', 'mp3', 'opus', 'vorbis'] };
    const IMAGE_SUBS = ['pgs', 'hdmv_pgs_subtitle', 'vobsub', 'dvd_subtitle', 'dvb_subtitle', 'dvbsub', 'xsub'];

    /* ---------------- state ---------------- */

    let S = null;                 // the current session (see open())
    let hideTimer = null, tickTimer = null, timelineTimer = null, seekTimer = null, upNextTimer = null;

    const plexUrl = path => Plex.base() + path + (path.indexOf('?') === -1 ? '?' : '&') + 'X-Plex-Token=' + encodeURIComponent(Plex.token());
    const fmt = ms => {
        const t = Math.max(0, Math.round((ms || 0) / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
        return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
    };
    const clock = d => { const h = d.getHours() % 12 || 12, m = d.getMinutes(); return h + ':' + (m < 10 ? '0' : '') + m + (d.getHours() < 12 ? 'am' : 'pm'); };
    const uuid = () => 'ml-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

    /* =============================== engines =============================== */

    // Each engine: load(url, startMs) → Promise, play(), pause(), seek(ms), time(), duration(), stop(),
    // tracks(type) → [{index, lang}], selectTrack(type, index), plus callbacks set in S.engine.on.
    function avEngine() {
        const av = avplay();
        const on = {};
        let dur = 0, cur = 0;
        return {
            name: 'avplay', on,
            load(url, startMs) {
                try { av.stop(); av.close(); } catch (e) { /* nothing open */ }
                av.open(url);
                av.setDisplayRect(0, 0, 1920, 1080);
                try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) { /* older firmware */ }
                // 4K / HDR files need the UHD hint before prepare.
                if (S && S.uhd) { try { av.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch (e) { /* not a UHD TV */ } }
                av.setListener({
                    onbufferingstart: () => on.buffering && on.buffering(true),
                    onbufferingcomplete: () => on.buffering && on.buffering(false),
                    oncurrentplaytime: t => { cur = t; },
                    onstreamcompleted: () => on.ended && on.ended(),
                    onerror: e => on.error && on.error(String(e)),
                    onsubtitlechange: (duration, text) => on.subtitle && on.subtitle(text, duration)
                });
                return new Promise((resolve, reject) => {
                    av.prepareAsync(() => {
                        dur = av.getDuration() || 0;
                        const go = () => { av.play(); resolve(); };
                        if (startMs > 0) { av.seekTo(startMs, go, go); } else { go(); }
                    }, e => reject(new Error('Can’t play this file (' + e + ')')));
                });
            },
            play() { try { av.play(); } catch (e) { /* not ready */ } },
            pause() { try { av.pause(); } catch (e) { /* not ready */ } },
            paused() { try { return av.getState() === 'PAUSED'; } catch (e) { return false; } },
            seek(ms) { try { av.seekTo(Math.max(0, Math.round(ms)), () => {}, () => {}); cur = ms; } catch (e) { /* ignore */ } },
            time() { try { return av.getCurrentTime() || cur; } catch (e) { return cur; } },
            duration() { return dur; },
            stop() { try { av.stop(); } catch (e) { /* */ } try { av.close(); } catch (e) { /* */ } },
            tracks(type) {
                try {
                    return av.getTotalTrackInfo().filter(t => t.type === type).map(t => {
                        let info = {};
                        try { info = JSON.parse(t.extra_info); } catch (e) { /* plain */ }
                        return { index: t.index, lang: info.language || '' };
                    });
                } catch (e) { return []; }
            },
            selectTrack(type, index) { av.setSelectTrack(type, index); },
            silentSubtitles(on2) { try { av.setSilentSubtitle(on2); } catch (e) { /* */ } },
            // Shift subtitles inside the file by ms (positive = later). False if this TV can't.
            subtitleOffset(ms) { try { av.setSubtitlePosition(ms); return true; } catch (e) { return false; } }
        };
    }

    function htmlEngine() {
        const v = $('pl-video');
        const on = {};
        v.onwaiting = () => on.buffering && on.buffering(true);
        v.onplaying = () => on.buffering && on.buffering(false);
        v.onended = () => on.ended && on.ended();
        v.onerror = () => on.error && on.error(v.error ? 'code ' + v.error.code : 'error');
        return {
            name: 'html5', on,
            load(url, startMs) {
                return new Promise((resolve, reject) => {
                    v.oncanplay = () => { v.oncanplay = null; const p = v.play(); if (p && p.catch) { p.catch(() => {}); } resolve(); };
                    v.onerror = () => { reject(new Error('This browser can’t play this file')); };
                    v.src = url + (startMs > 0 ? '#t=' + (startMs / 1000) : '');
                    v.load();
                }).then(() => { v.onerror = () => on.error && on.error('playback'); });
            },
            play() { const p = v.play(); if (p && p.catch) { p.catch(() => {}); } },
            pause() { v.pause(); },
            paused() { return v.paused; },
            seek(ms) { v.currentTime = Math.max(0, ms / 1000); },
            time() { return (v.currentTime || 0) * 1000; },
            duration() { return isFinite(v.duration) ? v.duration * 1000 : 0; },
            stop() { v.pause(); v.removeAttribute('src'); try { v.load(); } catch (e) { /* */ } },
            tracks() { return []; },
            selectTrack() { throw new Error('not supported'); },
            silentSubtitles() {},
            subtitleOffset() { return false; }
        };
    }

    /* =============================== Plex =============================== */

    function metadata(ratingKey) {
        return Plex.api('GET', '/library/metadata/' + ratingKey + '?includeMarkers=1&includeChapters=1')
            .then(d => ((d.MediaContainer && d.MediaContainer.Metadata) || [])[0]);
    }

    // The next episode after this one (for Up Next), or null.
    function nextEpisode(m) {
        if (m.type !== 'episode' || !m.grandparentRatingKey) { return Promise.resolve(null); }
        return Plex.api('GET', '/library/metadata/' + m.grandparentRatingKey + '/allLeaves').then(d => {
            const eps = (d.MediaContainer && d.MediaContainer.Metadata) || [];
            const i = eps.map(e => String(e.ratingKey)).indexOf(String(m.ratingKey));
            return i >= 0 && i + 1 < eps.length ? eps[i + 1] : null;
        }).catch(() => null);
    }

    const streamsOf = (part, type) => (part.Stream || []).filter(s => s.streamType === type);

    // Direct play or transcode, and why.
    function decide(media, part, audio, sub) {
        const can = avplay() ? TV_DIRECT : BROWSER_DIRECT;
        const why = [];
        if (prefs.quality !== 'original') { why.push('quality'); }
        if (can.container.indexOf(String(media.container || part.container || '').toLowerCase()) === -1) { why.push('container ' + media.container); }
        if (can.video.indexOf(String(media.videoCodec || '').toLowerCase()) === -1) { why.push('video ' + media.videoCodec); }
        if (audio && can.audio.indexOf(String(audio.codec || '').toLowerCase()) === -1) { why.push('audio ' + audio.codec); }
        if (sub && IMAGE_SUBS.indexOf(String(sub.codec || '').toLowerCase()) !== -1) { why.push('picture subtitles'); }
        // The browser can't show subtitles from inside the file; the transcoder burns them in.
        if (sub && !sub.key && !avplay()) { why.push('embedded subtitles'); }
        if (S && S.forceTranscode) { why.push('direct play failed'); }
        return why;
    }

    function transcodeUrl(startMs, sub) {
        const q = QUALITIES.filter(x => x.id === prefs.quality)[0] || QUALITIES[0];
        const original = q.id === 'original';
        const extra = 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264,hevc&audioCodec=aac,ac3,eac3)' +
            '+add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.bitDepth&value=10)';
        const burn = sub && (IMAGE_SUBS.indexOf(String(sub.codec || '').toLowerCase()) !== -1 || !sub.key);
        const params = {
            hasMDE: 1, path: '/library/metadata/' + S.meta.ratingKey, mediaIndex: 0, partIndex: 0, protocol: 'hls', fastSeek: 1,
            directPlay: 0, directStream: original ? 1 : 0, directStreamAudio: 1, location: 'lan', autoAdjustQuality: 0,
            offset: Math.floor(startMs / 1000), videoQuality: 100, maxVideoBitrate: original ? 200000 : q.id,
            videoResolution: original ? '3840x2160' : q.res, subtitles: burn ? 'burn' : 'none', subtitleSize: 100, audioBoost: 100,
            session: S.session, 'X-Plex-Session-Identifier': S.session, 'X-Plex-Client-Identifier': CLIENT_ID,
            'X-Plex-Product': 'Reelhouse', 'X-Plex-Platform': avplay() ? 'Tizen' : 'Chrome', 'X-Plex-Device-Name': 'Reelhouse',
            'X-Plex-Client-Profile-Extra': extra
        };
        const qs = Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
        return plexUrl('/video/:/transcode/universal/start.m3u8?' + qs);
    }

    function stopTranscode() {
        if (S && S.transcoding) { Plex.api('GET', '/video/:/transcode/universal/stop?session=' + S.session).catch(() => {}); }
    }

    // Tell Plex where we are: keeps the resume point and watched state in sync (Plex marks it watched at ~90%).
    function timeline(state) {
        if (!S || !S.meta || S.direct) { return; }        // trailers aren't Plex library items
        const t = Math.round(now()), d = Math.round(total());
        const q = 'ratingKey=' + S.meta.ratingKey + '&key=' + encodeURIComponent('/library/metadata/' + S.meta.ratingKey) +
            '&state=' + state + '&time=' + t + '&duration=' + d + '&playbackTime=' + t;
        Plex.api('GET', '/:/timeline?' + q, { 'X-Plex-Client-Identifier': CLIENT_ID, 'X-Plex-Session-Identifier': S.session }).catch(() => {});
    }

    // Remember the chosen audio / subtitle on the part, as Plex apps do (used next time, on any Plex app).
    function rememberStreams() {
        const q = 'allParts=1' + (S.audio ? '&audioStreamID=' + S.audio.id : '') + '&subtitleStreamID=' + (S.sub ? S.sub.id : 0);
        Plex.api('PUT', '/library/parts/' + S.part.id + '?' + q).catch(() => {});
    }

    /* =============================== subtitles =============================== */

    function parseTime(t) {
        const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(t);
        if (!m) { return 0; }
        return ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + Math.round(+('0.' + m[4]) * 1000);
    }

    // SRT, WebVTT and (text of) ASS/SSA into [{start, end, text}].
    function parseSubs(text) {
        const cues = [];
        text = String(text || '').replace(/\r/g, '');
        if (/^\[Script Info\]/m.test(text)) {
            const fmtLine = /^Format:\s*(.*)$/m.exec(text.split(/\[Events\]/)[1] || '');
            const cols = fmtLine ? fmtLine[1].split(',').map(s => s.trim().toLowerCase()) : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
            text.split('\n').forEach(line => {
                if (line.indexOf('Dialogue:') !== 0) { return; }
                const parts = line.slice(9).split(',');
                const body = parts.slice(cols.length - 1).join(',');
                const val = name => (parts[cols.indexOf(name)] || '').trim();
                cues.push({ start: parseTime(val('start')), end: parseTime(val('end')),
                    text: body.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim() });
            });
        } else {
            text.split(/\n\n+/).forEach(block => {
                const lines = block.split('\n').filter(Boolean);
                const i = lines.findIndex(l => l.indexOf('-->') !== -1);
                if (i === -1) { return; }
                const se = lines[i].split('-->');
                cues.push({ start: parseTime(se[0]), end: parseTime(se[1]), text: lines.slice(i + 1).join('\n').replace(/<(?!\/?(i|b|u)>)[^>]*>/g, '') });
            });
        }
        return cues.filter(c => c.text).sort((a, b) => a.start - b.start);
    }

    function showSub(text) {
        const el = $('pl-subs');
        el.innerHTML = text ? esc(text).replace(/&lt;(\/?)(i|b|u)&gt;/g, '<$1$2>').replace(/\n/g, '<br>') : '';
    }

    function renderExternalSub(t) {
        if (!S.cues) { return; }
        t -= S.subOffset || 0;                      // positive offset = subtitles later
        const cue = S.cues.filter(c => t >= c.start && t <= c.end);
        showSub(cue.map(c => c.text).join('\n'));
    }

    /* =============================== loading =============================== */

    function open(kind, real, title) {
        if (!Plex.configured()) { return Promise.reject(new Error('Plex isn’t set up (PLEX_URL / PLEX_TOKEN)')); }
        if (kind !== 'movie' && kind !== 'tv') { return Promise.reject(new Error('Only movies and TV shows play here')); }
        return Plex.findItem(kind, real).then(item => {
            if (!item) { throw new Error('“' + title + '” isn’t on the Plex server yet'); }
            return Plex.target(kind, item);
        }).then(t => metadata(t.key.split('/').pop())).then(meta => {
            if (!meta || !meta.Media || !meta.Media.length) { throw new Error('Plex has no playable file for “' + title + '”'); }
            start(meta, null);
        });
    }

    // A specific episode (or movie) by its Plex rating key, e.g. from the season screen.
    // Any directly playable video (a trailer): the same player and controls, without the Plex extras
    // (no resume, progress reporting, audio/subtitle menu or Up Next).
    function openUrl(url, title, label) {
        start({ title, type: 'clip', year: label || '', Media: [{ Part: [{ key: '', duration: 0 }] }] }, 0, url);
        return Promise.resolve();
    }

    // resume = true: continue straight from where it was left (the button already said "Resume"), no question.
    function openKey(ratingKey, resume) {
        if (!Plex.configured()) { return Promise.reject(new Error('Plex isn’t set up (PLEX_URL / PLEX_TOKEN)')); }
        return metadata(ratingKey).then(meta => {
            if (!meta || !meta.Media || !meta.Media.length) { throw new Error('Plex has no playable file for this episode'); }
            start(meta, resume ? (meta.viewOffset || 0) : null);
        });
    }

    function start(meta, startAt, directUrl) {
        const media = meta.Media[0], part = media.Part[0];
        const audios = streamsOf(part, 2), subs = streamsOf(part, 3);
        if (S) { teardown(true); }
        if (Player.onStart) { Player.onStart(); }        // e.g. stop the details' theme music
        S = {
            meta, media, part, audios, subs, session: uuid(),
            audio: audios.filter(s => s.selected)[0] || audios[0] || null,
            sub: subs.filter(s => s.selected)[0] || null,
            uhd: /4k|2160/i.test(String(media.videoResolution || '')),
            engine: window.MEDIALOADER_TEST_ENGINE ? window.MEDIALOADER_TEST_ENGINE() : avplay() ? avEngine() : htmlEngine(),   // test hook: a fake engine for desktop UI tests
            controls: false, menu: null, focus: 'play', scrubbing: null, upNext: null, next: null, upNextCancelled: false, subOffset: 0,
            direct: directUrl || null
        };
        $('pl-btn-menu').classList.toggle('hidden', !!S.direct);
        $('pl').classList.add('open');
        $('pl').classList.toggle('av', S.engine.name === 'avplay');
        document.documentElement.classList.add('playing');      // on the TV the video plane shows through the page
        $('pl-video').classList.toggle('hidden', !!avplay());
        $('pl-title').textContent = meta.type === 'episode' ? meta.grandparentTitle : meta.title;
        $('pl-sub').textContent = meta.type === 'episode' ? 'S' + meta.parentIndex + ' · E' + meta.index + ' · ' + meta.title : (meta.year || '');
        $('pl-subs').className = 'pl-subs ' + prefs.subSize;
        showSub('');
        hideUpNext();
        setScreenSaver(false);
        registerMediaKeys();
        nextEpisode(meta).then(n => { if (S && S.meta === meta) { S.next = n; } });

        const offset = startAt !== null ? startAt : (meta.viewOffset || 0);
        if (startAt === null && offset > 30000 && offset < (part.duration || Infinity) * 0.95) { askResume(offset); }
        else { load(offset); }
    }

    function load(startMs) {
        const why = S.direct ? [] : decide(S.media, S.part, S.audio, S.sub);
        S.transcoding = why.length > 0;
        S.why = why;
        S.cues = null;
        showSub('');
        busy(true);
        const url = S.direct || (S.transcoding ? transcodeUrl(startMs, S.sub) : plexUrl(S.part.key));
        const eng = S.engine, session = S;
        eng.on.buffering = b => busy(b);
        eng.on.ended = () => finished();
        eng.on.subtitle = (text, duration) => {
            if (!S || S.cues || !S.sub) { return; }
            // AVPlay sends lines like "Here we go.\r<br>Here we go", and a blank line (duration 0) to clear.
            const line = String(text || '').replace(/\r/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<(?!\/?(i|b|u)>)[^>]*>/gi, '').trim();
            const ms = parseInt(duration, 10) || 0;
            const show = () => {
                if (!S) { return; }
                clearTimeout(S.subTimer);
                showSub(line);
                if (line && ms > 0) { S.subTimer = setTimeout(() => showSub(''), Math.max(500, ms)); }
            };
            if (!S.subOffsetNative && S.subOffset > 0) { setTimeout(show, S.subOffset); } else { show(); }
        };
        eng.on.error = msg => {
            if (S !== session) { return; }
            if (!S.transcoding && !S.direct) { S.forceTranscode = true; load(eng.time() || startMs); return; }   // direct play failed: let Plex convert it
            fail('Playback stopped (' + msg + ')');
        };
        // Transcoded streams start at the offset already.
        eng.load(url, S.transcoding ? 0 : startMs).then(() => {
            if (S !== session) { return; }
            S.base = S.transcoding ? startMs : 0;      // HLS from the transcoder restarts its clock at the offset
            busy(false);
            if (S.engine.name === 'avplay' && !S.transcoding) {
                S.textTracks = S.engine.tracks('TEXT').length;
                if (S.sub && !subUsable(S.sub)) { S.sub = null; }       // the remembered choice isn't available here
            }
            applySubtitles();
            if (S.subOffset) { setSubOffset(S.subOffset); }       // keep the chosen timing after a restart
            applyAudio();
            tick();
            clearInterval(tickTimer); tickTimer = setInterval(tick, 500);
            clearInterval(timelineTimer); timelineTimer = setInterval(() => timeline(S.engine.paused() ? 'paused' : 'playing'), 10000);
            timeline('playing');
            showControls(true);
        }, err => {
            if (S !== session) { return; }
            if (!S.transcoding && !S.direct) { S.forceTranscode = true; load(startMs); return; }
            fail(err.message);
        });
    }

    // Position in the title (transcoded streams count from where they started).
    const now = () => (S ? (S.base || 0) + S.engine.time() : 0);
    const total = () => (S ? S.part.duration || S.meta.duration || ((S.base || 0) + S.engine.duration()) : 0);

    function seekTo(ms) {
        ms = Math.max(0, Math.min(total() - 2000, ms));
        if (S.transcoding && S.engine.name === 'html5') { load(ms); return; }   // browsers can't seek a live HLS session far
        if (S.transcoding && (ms < S.base)) { load(ms); return; }
        S.engine.seek(ms - (S.base || 0));
        timeline(S.engine.paused() ? 'paused' : 'playing');
        tick();
    }

    function applyAudio() {
        if (!S.audio || S.transcoding || S.engine.name !== 'avplay') { return; }
        const order = S.audios.slice().sort((a, b) => a.index - b.index).indexOf(S.audio);
        const tracks = S.engine.tracks('AUDIO').sort((a, b) => a.index - b.index);
        if (order >= 0 && tracks[order] && tracks.length > 1) { try { S.engine.selectTrack('AUDIO', tracks[order].index); } catch (e) { /* keep default */ } }
    }

    // Can this subtitle be shown? Separate files and picture subtitles always can (picture ones are burned in
    // by Plex). Text inside the file plays through AVPlay, which only exposes the first 30 such tracks.
    function subUsable(s) {
        if (s.key || IMAGE_SUBS.indexOf(String(s.codec || '').toLowerCase()) !== -1) { return true; }
        if (S.engine.name !== 'avplay' || S.transcoding || S.textTracks == null) { return true; }   // burned in, or not known yet
        const rank = S.subs.filter(x => !x.key && IMAGE_SUBS.indexOf(String(x.codec || '').toLowerCase()) === -1)
            .sort((a, b) => a.index - b.index).indexOf(s);
        return rank >= 0 && rank < S.textTracks;
    }

    function setSubOffset(ms) {
        S.subOffset = ms;
        const embedded = S.sub && !S.sub.key && S.engine.name === 'avplay' && !S.transcoding;
        S.subOffsetNative = embedded ? S.engine.subtitleOffset(ms) : null;
        if (S.cues) { renderExternalSub(now()); }
    }

    function applySubtitles() {
        S.cues = null;
        showSub('');
        const sub = S.sub;
        if (!sub || (S.transcoding && !sub.key)) {          // none, or burned into the picture by Plex
            S.engine.silentSubtitles(true);
            return;
        }
        if (sub.key) {                           // a separate subtitle file: fetch it and draw it ourselves
            S.engine.silentSubtitles(true);
            const session = S;
            const x = new XMLHttpRequest();
            x.open('GET', plexUrl(sub.key), true);
            x.onload = () => { if (S === session && S.sub === sub && x.status === 200) { S.cues = parseSubs(x.responseText); } };
            x.send();
            return;
        }
        // Text subtitles inside the file: AVPlay decodes them, we draw them (onsubtitlechange).
        if (S.engine.name === 'avplay' && !S.transcoding) {
            const textSubs = S.subs.filter(s => !s.key).sort((a, b) => a.index - b.index);
            const tracks = S.engine.tracks('TEXT').sort((a, b) => a.index - b.index);
            const i = textSubs.indexOf(sub);
            if (i >= 0 && tracks[i]) {
                // setSilentSubtitle(true) also stops AVPlay sending the lines (onsubtitlechange), so it stays off
                // here; AVPlay doesn't draw subtitles itself, so nothing is shown twice.
                try { S.engine.selectTrack('TEXT', tracks[i].index); S.engine.silentSubtitles(false); } catch (e) { /* none */ }
            }
        }
    }

    /* =============================== UI =============================== */

    function busy(on) { $('pl-spinner').classList.toggle('hidden', !on); }

    function fail(message) {
        busy(false);
        const s = S;
        close();
        if (typeof s === 'object' && Player.onError) { Player.onError(message); }
    }

    function tick() {
        if (!S) { return; }
        const t = now(), d = total();
        if (S.scrubbing === null) {
            $('pl-fill').style.transform = 'scaleX(' + (d ? Math.min(1, t / d) : 0) + ')';
            $('pl-time').textContent = fmt(t);
            $('pl-left').textContent = '-' + fmt(d - t);
        }
        $('pl-ends').textContent = d ? 'Ends at ' + clock(new Date(Date.now() + (d - t))) : '';
        $('pl-clock').textContent = clock(new Date());
        $('pl-play').innerHTML = S.engine.paused() ? '&#9654;' : '&#10074;&#10074;';
        if (S.cues) { renderExternalSub(t); }
        markers(t);
    }

    /* Intros and credits (Plex markers). By default they're skipped automatically, and the button offers to
       watch them instead: "Play intro" (jumps back; shown 8 s) and, at the end of a movie, "Play credits" with a
       5 s countdown before playback ends. With automatic skipping off (menu › Skipping) it's "Skip Intro" /
       "Skip Credits". An episode's credits bring up Up Next instead (or 30 s before the end). */
    const REPLAY_SHOWN = 8000, CREDITS_WAIT = 5000;
    const skipShown = () => !!(S && (S.marker || S.replay));

    // OK on the button: skip, or go back and watch what was skipped.
    function pressSkip() {
        const r = S.replay;
        if (r) {
            S.replay = null;
            S.watching = r.m;                                                 // no Skip button for what you chose to watch
            if (r.m.type === 'intro') { seekTo(r.m.startTimeOffset); }     // credits: just keep playing
        } else if (S.marker) {
            seekTo(S.marker.endTimeOffset);
            S.marker = null;
        }
        $('pl-btn-skip').classList.remove('shown');
    }

    function markers(t) {
        const list = S.meta.Marker || [];
        const m = list.filter(x => (x.type === 'intro' || x.type === 'credits') && t >= x.startTimeOffset && t < x.endTimeOffset - 1000)[0];
        const creditsAt = (list.filter(x => x.type === 'credits')[0] || {}).startTimeOffset || (total() - 30000);
        if (S.next && prefs.autoNext && !S.upNextCancelled && t >= creditsAt && total() > 0) { showUpNext(); return; }
        const skip = $('pl-btn-skip');
        // "Play intro" / "Play credits" after an automatic skip.
        if (S.replay) {
            if (S.engine.paused() && S.replay.m.type === 'credits') { S.replay.until += 500; }   // paused: the countdown waits (ticks are 0.5 s)
            const left = S.replay.until - Date.now();
            if (S.replay.m.type === 'credits') {
                if (left <= 0) { S.replay = null; skip.classList.remove('shown'); seekTo(total()); finished(); return; }   // ends as watched
                skip.textContent = 'Play credits · ' + Math.ceil(left / 1000);
            } else if (left <= 0) { S.replay = null; }
            if (S.replay) { S.marker = null; skip.classList.add('shown'); return; }
        }
        // Chose to watch it ("Play intro" / "Play credits"): no button until it's over.
        if (S.watching && m !== S.watching) { S.watching = null; }
        if (m && m === S.watching) { S.marker = null; skip.classList.remove('shown'); return; }
        // Automatic skipping: once per marker, so going back with "Play intro" (or scrubbing) plays it.
        const auto = m && !S.upNext && (m.type === 'intro' ? prefs.skipIntro : prefs.skipCredits);
        const mk = m && m.type + ':' + m.startTimeOffset;
        if (auto && S.scrubbing === null && !S.engine.paused() && !(S.autoSkipped || (S.autoSkipped = {}))[mk]) {
            S.autoSkipped[mk] = true;
            S.marker = null;
            S.replay = { m, until: Date.now() + (m.type === 'intro' ? REPLAY_SHOWN : CREDITS_WAIT) };
            if (m.type === 'intro') { seekTo(m.endTimeOffset); skip.textContent = 'Play intro'; }
            else { skip.textContent = 'Play credits · ' + Math.ceil(CREDITS_WAIT / 1000); }
            skip.classList.add('shown');
            return;
        }
        if (m && !S.upNext) {
            S.marker = m;
            skip.textContent = m.type === 'intro' ? 'Skip Intro' : 'Skip Credits';
            skip.classList.add('shown');
        } else {
            S.marker = null;
            skip.classList.remove('shown');
        }
    }

    function showUpNext() {
        if (S.upNext) { return; }
        const n = S.next;
        S.upNext = { left: 10 };
        $('pl-btn-skip').classList.remove('shown');
        $('pl-next-thumb').style.backgroundImage = n.thumb ? 'url("' + plexUrl('/photo/:/transcode?width=480&height=270&minSize=1&url=' + encodeURIComponent(n.thumb)) + '")' : 'none';
        $('pl-next-title').textContent = 'S' + n.parentIndex + ' · E' + n.index + ' · ' + n.title;
        $('pl-next').classList.add('open');
        const count = () => {
            if (!S || !S.upNext) { return; }
            $('pl-next-count').textContent = 'Playing in ' + S.upNext.left;
            if (S.upNext.left-- <= 0) { playNext(); return; }
            upNextTimer = setTimeout(count, 1000);
        };
        count();
    }

    function hideUpNext() {
        clearTimeout(upNextTimer);
        $('pl-next').classList.remove('open');
        if (S) { S.upNext = null; }
    }

    function playNext() {
        if (!S || !S.next) { return; }
        const nextKey = S.next.ratingKey;
        timeline('stopped');
        hideUpNext();
        metadata(nextKey).then(m => { if (m) { start(m, 0); } }, () => fail('Couldn’t load the next episode'));
    }

    function finished() {
        if (S && S.next && prefs.autoNext && !S.upNextCancelled) { playNext(); return; }
        close();
    }

    function askResume(offset) {
        S.resume = offset;
        S.focus = 'resume';
        $('pl-resume-at').textContent = 'Resume from ' + fmt(offset);
        $('pl-resume-title').textContent = $('pl-title').textContent;
        $('pl-resume').classList.add('open');
        drawFocus();
    }

    /* ---- controls ---- */

    const BUTTONS = ['back10', 'play', 'fwd30', 'next', 'menu'];
    const visibleButtons = () => BUTTONS.filter(b => (b !== 'next' || (S && S.next)) && (b !== 'menu' || (S && !S.direct)));

    function showControls(auto) {
        S.controls = true;
        $('pl').classList.add('controls');
        if (!auto) { S.focus = S.focus === 'resume' || S.focus === 'resume-start' ? S.focus : (S.focus || 'play'); }
        $('pl-btn-next').classList.toggle('hidden', !S.next);
        drawFocus();
        armHide();
    }

    function hideControls() {
        if (!S) { return; }
        S.controls = false;
        $('pl').classList.remove('controls');
        clearTimeout(hideTimer);
    }

    function armHide() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { if (S && !S.menu && !S.engine.paused() && S.scrubbing === null) { hideControls(); } }, 5000);
    }

    function drawFocus() {
        const all = document.querySelectorAll('#pl .pl-f');
        for (let i = 0; i < all.length; i++) { all[i].classList.remove('focused'); }
        const el = $('pl-' + (S.menu ? 'menu' : '') + (S.menu ? '' : 'btn-' + S.focus));
        if (S.focus === 'scrub') { $('pl-bar').classList.add('focused'); }
        else if (S.focus === 'resume') { $('pl-resume-yes').classList.add('focused'); }
        else if (S.focus === 'resume-start') { $('pl-resume-no').classList.add('focused'); }
        else if (!S.menu && el) { el.classList.add('focused'); }
        if (S.menu) { drawMenu(); }
    }

    /* ---- scrubbing with thumbnails ---- */

    function scrub(dir, held) {
        if (S.scrubbing === null) { S.scrubbing = now(); S.scrubStep = 10000; }
        else if (held) { S.scrubStep = Math.min(300000, S.scrubStep * 1.25); }
        S.scrubbing = Math.max(0, Math.min(total() - 2000, S.scrubbing + dir * S.scrubStep));
        const d = total();
        $('pl').classList.add('scrubbing');
        $('pl-fill').style.transform = 'scaleX(' + (d ? S.scrubbing / d : 0) + ')';
        $('pl-time').textContent = fmt(S.scrubbing);
        $('pl-left').textContent = '-' + fmt(d - S.scrubbing);
        const thumb = $('pl-thumb');
        thumb.style.left = Math.round(160 + (1600 * (d ? S.scrubbing / d : 0))) + 'px';
        $('pl-thumb-time').textContent = fmt(S.scrubbing);
        thumbAt(S.scrubbing).then(url => { if (url && S && S.scrubbing !== null) { $('pl-thumb-img').style.backgroundImage = 'url("' + url + '")'; } });
        if (!S.controls) { showControls(true); }
        clearTimeout(seekTimer);
        seekTimer = setTimeout(commitScrub, 800);
        armHide();
    }

    function commitScrub() {
        if (!S || S.scrubbing === null) { return; }
        const to = S.scrubbing;
        S.scrubbing = null;
        $('pl').classList.remove('scrubbing');
        seekTo(to);
    }

    // Plex's preview thumbnails: a BIF file (index of JPEGs), loaded on the first scrub.
    function thumbAt(ms) {
        if (!S.part.indexes) { return Promise.resolve(null); }
        if (!S.bif) {
            const part = S.part;
            S.bif = new Promise(resolve => {
                const x = new XMLHttpRequest();
                x.open('GET', plexUrl('/library/parts/' + part.id + '/indexes/sd'), true);
                x.responseType = 'arraybuffer';
                x.onload = () => {
                    try {
                        const dv = new DataView(x.response);
                        const count = dv.getUint32(12, true), interval = dv.getUint32(16, true) || 1000, frames = [];
                        for (let i = 0; i < count; i++) {
                            frames.push({ t: dv.getUint32(64 + i * 8, true) * interval, off: dv.getUint32(68 + i * 8, true) });
                        }
                        resolve({ buf: x.response, frames, urls: {} });
                    } catch (e) { resolve(null); }
                };
                x.onerror = () => resolve(null);
                x.send();
            });
        }
        return S.bif.then(b => {
            if (!b || b.frames.length < 2) { return null; }
            let i = 0;
            while (i < b.frames.length - 2 && b.frames[i + 1].t <= ms) { i++; }
            if (!b.urls[i]) {
                b.urls[i] = URL.createObjectURL(new Blob([new Uint8Array(b.buf, b.frames[i].off, b.frames[i + 1].off - b.frames[i].off)], { type: 'image/jpeg' }));
            }
            return b.urls[i];
        });
    }

    /* ---- options menu: audio, subtitles, subtitle size, quality, auto-play, playback info ---- */

    function menuItems() {
        const items = [];
        const head = t => items.push({ head: t });
        head('Audio');
        S.audios.forEach(a => items.push({ label: a.displayTitle || a.language || 'Track ' + a.index, on: S.audio === a, act: () => { S.audio = a; rememberStreams(); restartHere(true); } }));
        head('Subtitles');
        items.push({ label: 'Off', on: !S.sub, act: () => { S.sub = null; rememberStreams(); applySubtitlesOrRestart(); } });
        S.subs.filter(subUsable).forEach(s => items.push({ label: (s.displayTitle || s.language || 'Subtitles') + (s.key ? ' · file' : '') + (s.forced ? ' · forced' : ''),
            on: S.sub === s, act: () => { S.sub = s; rememberStreams(); applySubtitlesOrRestart(); } }));
        if (S.sub) {
            // Timing: only "later" is possible for subtitles inside the file on TVs without AVPlay's sync setting.
            // One adjustable item: Left/Right move the subtitles 0.1 s at a time (up to 10 s either way), OK resets.
            head('Subtitle timing');
            const canEarlier = !!S.cues || S.subOffsetNative !== false;
            const o = S.subOffset || 0;
            items.push({
                label: '◀  ' + (o === 0 ? 'In sync' : (Math.abs(o) / 1000).toFixed(1) + ' s ' + (o < 0 ? 'earlier' : 'later')) + '  ▶',
                adjust: dir => setSubOffset(Math.max(canEarlier ? -10000 : 0, Math.min(10000, o + dir * 100))),
                act: () => setSubOffset(0), timing: true
            });
        }
        head('Subtitle size');
        SUB_SIZES.forEach(z => items.push({ label: z.label, on: prefs.subSize === z.id, act: () => { prefs.subSize = z.id; savePrefs(); $('pl-subs').className = 'pl-subs ' + z.id; } }));
        head('Quality');
        QUALITIES.forEach(q => items.push({ label: q.label, on: prefs.quality === q.id, act: () => { prefs.quality = q.id; savePrefs(); restartHere(); } }));
        if (S.meta.type === 'episode') {
            head('Episodes');
            items.push({ label: 'Play the next episode automatically', on: prefs.autoNext, act: () => { prefs.autoNext = !prefs.autoNext; savePrefs(); } });
        }
        head('Skipping');
        items.push({ label: 'Skip intros automatically', on: prefs.skipIntro, act: () => { prefs.skipIntro = !prefs.skipIntro; savePrefs(); } });
        items.push({ label: 'Skip credits automatically', on: prefs.skipCredits, act: () => { prefs.skipCredits = !prefs.skipCredits; savePrefs(); } });
        head('Playing');
        const a = S.audio;
        const plain = w => (/^audio/.test(w) ? 'the sound' : /^video/.test(w) ? 'the picture' : /subtitles/.test(w) ? 'the subtitles'
            : w === 'quality' ? 'a lower quality' : /^container/.test(w) ? 'the file type' : 'playback');
        const reasons = S.why.map(plain).filter((w, i, a) => a.indexOf(w) === i);
        items.push({ info: true, label: (S.transcoding ? 'Plex is converting ' + reasons.join(' and ') + ' for this TV' : 'Playing the original file') +
            ' · ' + String(S.media.videoCodec || '').toUpperCase() + ' ' + (S.media.videoResolution || '') + (/^\d+$/.test(S.media.videoResolution) ? 'p' : '') +
            (a ? ' · ' + (a.displayTitle || a.codec) : '') + ' · ' + (S.engine.name === 'avplay' ? 'Samsung player' : 'browser player') });
        return items;
    }

    function openMenu() {
        S.menu = { items: menuItems() };
        const firstOn = S.menu.items.findIndex(i => i.on);
        S.menu.i = firstOn >= 0 ? firstOn : S.menu.items.findIndex(i => !i.head && !i.info);
        $('pl-menu').classList.add('open');
        $('pl').classList.add('menu-open');
        drawMenu();
        clearTimeout(hideTimer);
    }

    function closeMenu() {
        S.menu = null;
        $('pl-menu').classList.remove('open');
        $('pl').classList.remove('menu-open');
        drawFocus();
        armHide();
    }

    function drawMenu() {
        const list = $('pl-menu-list');
        list.innerHTML = S.menu.items.map((it, i) => it.head ? '<h4>' + esc(it.head) + '</h4>'
            : '<div class="pl-opt' + (it.info ? ' info' : '') + (it.timing ? ' timing' : '') + (it.on ? ' on' : '') + (i === S.menu.i ? ' focused' : '') + '">' + esc(it.label) + '</div>').join('');
        const f = list.querySelector('.focused');
        if (f) {
            // Keep the item's section heading in view above it when moving up (offsetTop is within the list).
            const head = f.previousElementSibling && f.previousElementSibling.tagName === 'H4' ? f.previousElementSibling : null;
            const top = head === list.firstElementChild ? 0 : (head ? head.offsetTop : f.offsetTop) - 12;
            if (top < list.scrollTop) { list.scrollTop = Math.max(0, top); }
            else if (f.offsetTop + f.offsetHeight + 40 > list.scrollTop + list.clientHeight) { list.scrollTop = f.offsetTop + f.offsetHeight + 40 - list.clientHeight; }
        }
    }

    function menuMove(dir) {
        const items = S.menu.items;
        let i = S.menu.i;
        do { i += dir; } while (i >= 0 && i < items.length && (items[i].head || items[i].info));
        if (i >= 0 && i < items.length) { S.menu.i = i; drawMenu(); }
    }

    function menuPick() {
        const it = S.menu.items[S.menu.i];
        if (!it || !it.act) { return; }
        it.act();
        if (!S) { return; }
        const keep = S.menu.i;
        S.menu.items = menuItems();
        S.menu.i = keep;
        drawMenu();
    }

    // Audio: AVPlay switches tracks of a directly played file instantly; otherwise restart where we are.
    function restartHere(audioOnly) {
        if (audioOnly && S.engine.name === 'avplay' && !S.transcoding && S.engine.tracks('AUDIO').length > 1) { applyAudio(); return; }
        S.forceTranscode = false;
        load(now());
    }
    function applySubtitlesOrRestart() {
        const needsTranscode = decide(S.media, S.part, S.audio, S.sub).length > 0;
        if (needsTranscode !== S.transcoding) { load(now()); } else { applySubtitles(); if (S.subOffset) { setSubOffset(S.subOffset); } }
    }

    /* =============================== keys =============================== */

    function onKey(e) {
        if (!S) { return; }
        const k = e.keyCode;
        const handled = handle(k, e.repeat);
        if (handled !== false) { e.preventDefault(); e.stopImmediatePropagation(); }
    }

    const sound = n => { if (typeof Sounds !== 'undefined') { Sounds.play(n); } };

    function togglePause() {
        if (S.engine.paused()) { S.engine.play(); timeline('playing'); } else { S.engine.pause(); timeline('paused'); }
        tick();
    }

    function handle(k, held) {
        const isBack = k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE;
        // Media keys work everywhere.
        if (k === KEY.PLAYPAUSE) { togglePause(); showControls(true); return; }
        if (k === KEY.PLAY) { S.engine.play(); timeline('playing'); tick(); return; }
        if (k === KEY.PAUSE) { S.engine.pause(); timeline('paused'); showControls(true); tick(); return; }
        if (k === KEY.STOP) { close(); return; }
        if (k === KEY.FF) { scrub(1, true); return; }
        if (k === KEY.RW) { scrub(-1, true); return; }
        if (k === KEY.NEXT && S.next) { playNext(); return; }

        // Resume prompt
        if (S.focus === 'resume' || S.focus === 'resume-start') {
            if (k === KEY.LEFT || k === KEY.RIGHT || k === KEY.UP || k === KEY.DOWN) { sound('move'); S.focus = S.focus === 'resume' ? 'resume-start' : 'resume'; drawFocus(); return; }
            if (k === KEY.ENTER) {
                sound('select');
                const from = S.focus === 'resume' ? S.resume : 0;
                $('pl-resume').classList.remove('open');
                S.focus = 'play';
                load(from);
                return;
            }
            if (isBack) { sound('back'); close(); return; }
            return;
        }

        // Options menu
        if (S.menu) {
            if (k === KEY.UP || k === KEY.DOWN) { sound('move'); menuMove(k === KEY.UP ? -1 : 1); return; }
            if (k === KEY.ENTER) { sound('select'); menuPick(); return; }
            const item = S.menu.items[S.menu.i];
            if ((k === KEY.LEFT || k === KEY.RIGHT) && item && item.adjust) {
                sound('move');
                item.adjust(k === KEY.LEFT ? -1 : 1);
                const keep = S.menu.i;
                S.menu.items = menuItems();
                S.menu.i = keep;
                drawMenu();
                return;
            }
            if (isBack || k === KEY.LEFT) { sound('back'); closeMenu(); return; }
            return;
        }

        // Up Next card: OK plays now, Back cancels it.
        if (S.upNext && !S.controls) {
            if (k === KEY.ENTER) { sound('select'); playNext(); return; }
            if (isBack) { sound('back'); S.upNextCancelled = true; hideUpNext(); return; }
        }

        if (!S.controls) {
            if (k === KEY.ENTER) {
                sound('select');
                if (skipShown()) { pressSkip(); return; }
                togglePause(); showControls(); return;
            }
            if (k === KEY.LEFT || k === KEY.RIGHT) { sound('move'); S.focus = 'scrub'; scrub(k === KEY.LEFT ? -1 : 1, held); return; }
            if (k === KEY.UP || k === KEY.DOWN) { sound('move'); S.focus = 'play'; showControls(); return; }
            if (isBack) { sound('back'); close(); return; }
            return;
        }

        // Controls showing
        armHide();
        if (isBack) { sound('back'); if (S.scrubbing !== null) { commitScrub(); } hideControls(); return; }
        if (S.focus === 'scrub') {
            if (k === KEY.LEFT || k === KEY.RIGHT) { sound('move'); scrub(k === KEY.LEFT ? -1 : 1, held); return; }
            if (k === KEY.DOWN) { sound('move'); commitScrub(); S.focus = 'play'; drawFocus(); return; }
            if (k === KEY.ENTER) { sound('select'); if (S.scrubbing !== null) { clearTimeout(seekTimer); commitScrub(); } else { togglePause(); } return; }
            if (k === KEY.UP && skipShown()) { sound('move'); S.focus = 'skip'; drawFocus(); return; }
            return;
        }
        if (S.focus === 'skip') {
            if (k === KEY.ENTER && skipShown()) { sound('select'); pressSkip(); S.focus = 'play'; drawFocus(); return; }
            if (k === KEY.DOWN || !skipShown()) { sound('move'); S.focus = 'scrub'; drawFocus(); return; }
            return;
        }
        const btns = visibleButtons(), i = btns.indexOf(S.focus);
        if (k === KEY.LEFT || k === KEY.RIGHT) {
            const j = i + (k === KEY.LEFT ? -1 : 1);
            if (j >= 0 && j < btns.length) { sound('move'); S.focus = btns[j]; drawFocus(); }
            return;
        }
        if (k === KEY.UP) { sound('move'); S.focus = 'scrub'; drawFocus(); return; }
        if (k === KEY.DOWN) { return; }
        if (k === KEY.ENTER) {
            sound('select');
            if (S.focus === 'play') { togglePause(); }
            else if (S.focus === 'back10') { seekTo(now() - 10000); }
            else if (S.focus === 'fwd30') { seekTo(now() + 30000); }
            else if (S.focus === 'next') { playNext(); }
            else if (S.focus === 'menu') { openMenu(); }
            return;
        }
        return false;
    }

    /* =============================== TV bits =============================== */

    let keysRegistered = false;
    function registerMediaKeys() {
        if (keysRegistered) { return; }
        keysRegistered = true;
        try {
            ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious']
                .forEach(n => { try { tizen.tvinputdevice.registerKey(n); } catch (e) { /* not on this remote */ } });
        } catch (e) { /* not a TV */ }
    }

    function setScreenSaver(on) {
        try {
            const st = webapis.appcommon.AppCommonScreenSaverState;
            webapis.appcommon.setScreenSaver(on ? st.SCREEN_SAVER_ON : st.SCREEN_SAVER_OFF);
        } catch (e) { /* not a TV */ }
    }

    /* =============================== close =============================== */

    function teardown(keepOverlay) {
        if (!S) { return; }
        timeline('stopped');
        stopTranscode();
        clearInterval(tickTimer); clearInterval(timelineTimer); clearTimeout(hideTimer); clearTimeout(seekTimer); clearTimeout(S.subTimer);
        hideUpNext();
        try { S.engine.stop(); } catch (e) { /* already stopped */ }
        if (S.bif) { S.bif.then(b => { if (b) { Object.keys(b.urls).forEach(k => URL.revokeObjectURL(b.urls[k])); } }); }
        S = null;
        if (!keepOverlay) {
            $('pl').classList.remove('open', 'controls', 'scrubbing', 'menu-open');
            $('pl-menu').classList.remove('open');
            $('pl-resume').classList.remove('open');
            document.documentElement.classList.remove('playing');
            setScreenSaver(true);
        }
    }

    function close() {
        const was = !!S;
        teardown(false);
        if (was && Player.onClose) { Player.onClose(); }
    }

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden && S) { S.engine.pause(); timeline('paused'); } });

    const Player = { open, openKey, openUrl, close, isOpen: () => !!S, onClose: null, onError: null, _parseSubs: parseSubs };
    return Player;
}());
