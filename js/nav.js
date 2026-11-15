/*
 * Remote (D-pad) navigation, Netflix-style.
 *
 * Structure-aware where it matters, geometric everywhere else:
 *   .row-track  -> left/right walk siblings; entering a row returns to the card you last had focused
 *   .v-list     -> up/down walk siblings
 *   #rail       -> left from the content opens the rail on the current page; right returns to where you were
 *   everything else -> nearest element in the pressed direction
 * Scrolling is done with transforms (see .v-inner / .row-track in CSS) so it animates smoothly.
 * Text inputs are highlighted first; OK starts editing (opens the TV keyboard).
 */
var Nav = (function () {
    'use strict';

    const KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
        BACK: 10009, ESC: 27, BACKSPACE: 8,
        IME_DONE: 65376, IME_CANCEL: 65385
    };

    let current = null;
    let editing = false;
    const opts = { back: null, submit: null, onFocus: null, onRail: null, onUnhandled: null };

    const app = () => document.getElementById('app');
    const rail = () => document.getElementById('rail');
    const activeScreen = () => document.querySelector('.screen.active');
    const inRail = el => !!el && rail().contains(el);

    function isVisible(el) {
        return !!el && el.offsetParent !== null && !el.disabled && !el.classList.contains('hidden');
    }

    function candidates() {
        const out = [];
        const add = root => {
            if (!root) { return; }
            const all = root.querySelectorAll('.focusable');
            // Closed pop-ups are hidden with visibility (they keep their layout), so skip their contents explicitly:
            // otherwise Up from a Cast page's first row landed on the closed details pop-up's description.
            for (let i = 0; i < all.length; i++) { if (isVisible(all[i]) && !all[i].closest('.sheet:not(.open)')) { out.push(all[i]); } }
        };
        const sheet = openSheet();
        if (sheet) { add(sheet); return out; }          // a modal panel traps focus
        add(rail());
        add(activeScreen());
        return out;
    }

    const openSheet = () => document.querySelector('.screen.active .sheet.open');

    /* ---------- smooth scrolling ---------- */

    function offsetWithin(el, ancestor) {
        let x = 0, y = 0, n = el;
        while (n && n !== ancestor) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
        return { x, y };
    }

    function scrollRow(el) {
        const track = el.parentNode;
        if (!track || !track.classList.contains('row-track')) { return; }
        const viewport = track.parentNode;
        const visible = viewport.clientWidth - 160;            // minus viewport side padding
        const max = Math.max(0, track.scrollWidth - visible);
        // Keep the focused card one card in from the left edge, like Netflix.
        const x = Math.max(0, Math.min(el.offsetLeft - (el.previousElementSibling ? el.offsetWidth * 0.6 : 0), max));
        track.style.transform = 'translate3d(' + (-x) + 'px,0,0)';
        track.setAttribute('data-last', Array.prototype.indexOf.call(track.children, el));
    }

    function scrollVertical(el) {
        let vs = el.parentNode;
        while (vs && !(vs.classList && vs.classList.contains('v-scroll'))) { vs = vs.parentNode; }
        if (!vs) { return; }
        const inner = vs.firstElementChild;
        const target = el.closest('.row') || el;
        const reset = target.closest('[data-scroll-reset]');
        const H = vs.clientHeight, pad = 60;
        let y = parseFloat(inner.getAttribute('data-y') || '0');

        if (reset) {
            y = 0;
        } else if (vs.classList.contains('snap')) {
            // Netflix-style: the focused row always sits at the top of the area.
            y = offsetWithin(target, inner).y;
            inner.setAttribute('data-y', y);
            inner.style.transform = 'translate3d(0,' + (-y) + 'px,0)';
            inner.classList.toggle('scrolled', y > 0);
            return;
        } else {
            const top = offsetWithin(target, inner).y;
            const bottom = top + target.offsetHeight;
            if (top - y < pad) { y = top - pad; }
            else if (bottom - y > H - pad) { y = bottom - H + pad; }
        }
        y = Math.max(0, Math.min(y, inner.offsetHeight - H + pad));
        inner.setAttribute('data-y', y);
        inner.classList.toggle('scrolled', y > 0);
        inner.style.transform = 'translate3d(0,' + (-y) + 'px,0)';
    }

    /* ---------- focus ---------- */

    function focus(el) {
        if (!el) { return; }
        stopEditing();
        if (current && current !== el) { current.classList.remove('focused'); }
        // Leaving a row (up/down to another row or the banner) scrolls it back to its first item, so it
        // reads from the start again. Opening the side menu or a pop-up keeps your place.
        const prevTrack = current && current.parentNode && current.parentNode.classList && current.parentNode.classList.contains('row-track') ? current.parentNode : null;
        if (prevTrack && el.parentNode !== prevTrack && !inRail(el) && !el.closest('.sheet') && !inRail(current)) {
            prevTrack.style.transform = 'translate3d(0,0,0)';
            prevTrack.setAttribute('data-last', '0');
        }
        current = el;
        el.classList.add('focused');
        if (el.tagName !== 'INPUT') {
            try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
            // Chromium < 64 (2019 TVs, Tizen 5.0) ignores preventScroll and scrolls overflow:hidden
            // containers to reveal the element. Scrolling here is done with transforms, so undo it.
            for (let n = el.parentNode; n && n !== document.body; n = n.parentNode) {
                if (n.scrollTop && !n.classList.contains('sheet-body')) { n.scrollTop = 0; }
                if (n.scrollLeft) { n.scrollLeft = 0; }
            }
        }

        const railOpen = inRail(el);
        app().classList.toggle('rail-open', railOpen);
        if (!railOpen && !el.closest('.sheet')) {
            const scr = activeScreen();
            if (scr) { scr._lastFocus = el; }
            scrollRow(el);
            scrollVertical(el);
        }
        if (opts.onFocus) { opts.onFocus(el); }
    }

    function focusFirst(selector) {
        const scr = activeScreen();
        let el = selector && scr ? scr.querySelector(selector) : null;
        if (!isVisible(el)) { el = scr && scr._lastFocus && isVisible(scr._lastFocus) ? scr._lastFocus : null; }
        if (!el) { el = candidates().filter(c => !inRail(c))[0]; }
        focus(el);
    }

    // If moving into a carousel, land on the card you last had focused there.
    function remembered(el) {
        const track = el.parentNode;
        if (!track || !track.classList.contains('row-track')) { return el; }
        const i = parseInt(track.getAttribute('data-last') || '0', 10);
        const r = track.children[i];
        return r && isVisible(r) ? r : el;
    }

    function sibling(el, forward) {
        let n = forward ? el.nextElementSibling : el.previousElementSibling;
        while (n && !(n.classList.contains('focusable') && isVisible(n))) { n = forward ? n.nextElementSibling : n.previousElementSibling; }
        return n;
    }

    function geometric(dir, list) {
        const r = current.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        let best = null, bestScore = Infinity;
        list.forEach(el => {
            if (el === current) { return; }
            const b = el.getBoundingClientRect();
            const bx = b.left + b.width / 2, by = b.top + b.height / 2;
            let primary, secondary;
            if (dir === 'left') { if (b.right > r.left + 1) { return; } primary = r.left - b.right; secondary = Math.abs(by - cy); }
            else if (dir === 'right') { if (b.left < r.right - 1) { return; } primary = b.left - r.right; secondary = Math.abs(by - cy); }
            else if (dir === 'up') { if (b.bottom > r.top + 1) { return; } primary = r.top - b.bottom; secondary = Math.abs(bx - cx); }
            else { if (b.top < r.bottom - 1) { return; } primary = b.top - r.bottom; secondary = Math.abs(bx - cx); }
            const score = primary + secondary * 2;
            if (score < bestScore) { bestScore = score; best = el; }
        });
        return best;
    }

    function move(dir) {
        const list = candidates();
        if (!current || list.indexOf(current) === -1) { focusFirst(); return; }
        const horizontal = dir === 'left' || dir === 'right';
        const forward = dir === 'right' || dir === 'down';

        // Explicit override, e.g. data-nav-down="#settings-save"
        const override = current.getAttribute('data-nav-' + dir);
        if (override) {
            const t = document.querySelector(override);
            if (isVisible(t)) { focus(t); return; }
        }

        // Rail: up/down within it, right goes back to the page.
        if (inRail(current)) {
            if (horizontal) {
                if (dir === 'right') { focusFirst(); }
                return;
            }
            const s = sibling(current, forward);
            if (s) { focus(s); }
            return;
        }

        const track = current.parentNode && current.parentNode.classList.contains('row-track') ? current.parentNode : null;
        if (track && horizontal) {
            const s = sibling(current, forward);
            if (s) { focus(s); return; }
            if (dir === 'right') { return; }               // end of row: stay put
            // Left from the first poster opens the side menu. (Searching geometrically here could pick a
            // poster that another, sideways-scrolled row has pushed off-screen to the left.)
            if (!openSheet()) {
                focus(rail().querySelector('.rail-item.current') || rail().querySelector('.rail-item'));
                return;
            }
        }
        // Stacked carousels: up/down goes to the neighbouring row (by order, not screen position,
        // so it's reliable even while rows are mid-animation). Off the top row, fall through.
        if (track && !horizontal) {
            const rowEl = track.closest('.row');
            const rows = Array.prototype.filter.call(rowEl.parentNode.children, r => r.classList.contains('row'));
            const firstIn = r => {
                const t = r.querySelector('.row-track');
                return t && Array.prototype.filter.call(t.children, c => c.classList.contains('focusable') && isVisible(c))[0];
            };
            // In the snapping row area, Down on the last row wraps back to the first row.
            const wrap = forward && !!track.closest('.v-scroll.snap');
            const i = rows.indexOf(rowEl);
            for (let step = 1; step < rows.length; step++) {
                let j = forward ? i + step : i - step;
                if (j >= rows.length) { if (!wrap) { break; } j -= rows.length; }
                if (j < 0) { break; }
                const first = firstIn(rows[j]);
                if (first) { focus(remembered(first)); return; }
            }
            if (forward) { return; }                       // nowhere further down: stay put
        }

        const vlist = current.parentNode && current.parentNode.classList.contains('v-list') ? current.parentNode : null;
        if (vlist && !horizontal) {
            const s = sibling(current, forward);
            if (s) { focus(s); return; }
        }

        const pageOnly = list.filter(el => !inRail(el));
        let target = geometric(dir, pageOnly);
        if (!target && dir === 'left' && !openSheet()) {
            target = rail().querySelector('.rail-item.current') || rail().querySelector('.rail-item');
        }
        if (target) { focus(inRail(target) ? target : remembered(target)); }
        else if (opts.onUnhandled) { opts.onUnhandled(dir); }   // e.g. scroll a modal's text
    }

    /* ---------- text input ---------- */

    function startEditing() {
        if (!current || current.tagName !== 'INPUT') { return; }
        editing = true;
        current.classList.add('editing');
        current.focus();
        try { current.setSelectionRange(current.value.length, current.value.length); } catch (e) { /* ignore */ }
        if (opts.onFocus) { opts.onFocus(current); }
    }

    // OK on a text field: the app may handle it itself (search uses MediaLoader's own keyboard).
    function edit() {
        if (opts.onEdit && opts.onEdit(current)) { return; }
        startEditing();
    }

    function stopEditing() {
        if (!editing || !current) { editing = false; return; }
        editing = false;
        current.classList.remove('editing');
        current.blur();
        if (opts.onFocus) { opts.onFocus(current); }
    }

    /* ---------- keys ---------- */

    const sound = name => { if (opts.sound) { opts.sound(name); } };

    function onKey(e) {
        const k = e.keyCode;

        if (editing) {
            if (k === KEY.ENTER || k === KEY.IME_DONE) {
                e.preventDefault();
                sound('select');
                const input = current;
                stopEditing();
                if (opts.submit) { opts.submit(input); }
            } else if (k === KEY.IME_CANCEL || k === KEY.BACK || k === KEY.ESC) {
                e.preventDefault();
                sound('back');
                stopEditing();
            } else if (k === KEY.UP || k === KEY.DOWN) {
                e.preventDefault();
                sound('move');
                stopEditing();
                move(k === KEY.UP ? 'up' : 'down');
            } else if (k === KEY.LEFT && current.selectionStart === 0 && current.selectionEnd === 0) {
                // Left at the start of the text leaves the field (e.g. to reach the rail).
                e.preventDefault();
                stopEditing();
                move('left');
            }
            return; // typing and cursor keys go to the input
        }

        switch (k) {
            case KEY.LEFT: e.preventDefault(); sound('move'); move('left'); break;
            case KEY.RIGHT: e.preventDefault(); sound('move'); move('right'); break;
            case KEY.UP: e.preventDefault(); sound('move'); move('up'); break;
            case KEY.DOWN: e.preventDefault(); sound('move'); move('down'); break;
            case KEY.ENTER:
                e.preventDefault();
                if (!current) { break; }
                sound('select');
                if (current.tagName === 'INPUT') { edit(); } else { current.click(); }
                break;
            case KEY.BACK: case KEY.ESC: case KEY.BACKSPACE:
                e.preventDefault();
                sound('back');
                if (opts.back) { opts.back(); }
                break;
            default:
                // Desktop convenience: typing while an input is highlighted starts editing.
                if (current && current.tagName === 'INPUT' && e.key && e.key.length === 1) { edit(); }
        }
    }

    function init(o) {
        Object.assign(opts, o);
        document.addEventListener('keydown', onKey);

        // Pointer / Smart Remote support.
        document.addEventListener('mouseover', e => {
            const el = e.target.closest ? e.target.closest('.focusable') : null;
            if (el && el !== current && !editing && candidates().indexOf(el) !== -1) { focus(el); }
        });
        document.addEventListener('click', e => {
            const el = e.target.closest ? e.target.closest('input.focusable') : null;
            if (el) { if (el !== current) { focus(el); } edit(); }
        });
    }

    return {
        init, focus, focusFirst, startEditing,
        inRail: () => inRail(current),
        // Open the side menu on the current screen's item
        focusRail: () => focus(rail().querySelector('.rail-item.current') || rail().querySelector('.rail-item')),
        current: () => current,
        isEditing: () => editing
    };
}());
