/* SPECTRA — UI kit. Tiny hyperscript + instrument-style controls shared by every lab. */
(function () {
  const SL = (window.SL = window.SL || {});
  const U = (SL.ui = {});

  /* Lab registry lives here (loaded before the lab scripts); app.js boots them. */
  SL.labs = SL.labs || [];
  SL.lab = function (def) { def.concepts = def.concepts || []; SL.labs.push(def); };

  /** h('div.a.b', {props}, ...children). Props: style (obj|string), on* listeners, html, data-*, any attr. */
  const h = (SL.h = function (tag, props, ...kids) {
    const [t, ...cls] = tag.split('.');
    const e = document.createElement(t || 'div');
    if (cls.length) e.className = cls.join(' ');
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'style' && typeof v === 'object') {
          for (const sk in v) sk.startsWith('--') ? e.style.setProperty(sk, v[sk]) : (e.style[sk] = v[sk]);
        }
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'class') e.className += ' ' + v;
        else if (k in e && typeof v !== 'string') e[k] = v;
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return e;
  });

  /* ---------------- Icons (inline SVG, 24×24, stroke = currentColor) ---------------- */
  const ICONS = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    cam: '<path d="M3 7h3l2-2.5h8L18 7h3v12H3z"/><circle cx="12" cy="13" r="3.6"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5"/>',
    wave: '<path d="M2 12h3l2-6 3 12 3-15 3 18 2-9h4"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    ear: '<path d="M7 9a5 5 0 0 1 10 0c0 3-3 4-3 7a3 3 0 0 1-6 0"/><path d="M10 10a2 2 0 0 1 4 0"/>',
    spark: '<path d="M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>',
    bridge: '<path d="M2 18h20M4 18V10M20 18V10M4 10c4 0 4-4 8-4s4 4 8 4M8 18v-6M12 18v-7M16 18v-6"/>',
    brush: '<path d="M14 4l6 6-8 8H6v-6z"/><path d="M4 20l2-2"/>',
    eraser: '<path d="M4 15l8-8 6 6-6 6H8z"/><path d="M12 19h8"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  };
  U.icon = function (name, size = 18) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = ICONS[name] || ICONS.spark;
    s.classList.add('ico');
    return s;
  };

  /* ---------------- Layout pieces ---------------- */
  /** Glass card with a tiny mono label in the corner. */
  U.card = function (label, ...kids) {
    return h('div.card', null, label ? h('div.card-label', null, label) : null, ...kids);
  };
  /** Control group in the rail. */
  U.group = function (label, ...kids) {
    return h('div.group', null, label ? h('div.group-label', null, label) : null, ...kids);
  };
  /** Canvas with fixed pixel size; CSS scales it to fit its box. opt.pixel → crisp pixels. */
  U.canvas = function (w, h_, opt = {}) {
    const c = h('canvas.cv' + (opt.pixel ? '.pixel' : '') + (opt.cls ? '.' + opt.cls : ''), { width: w, height: h_ });
    if (opt.style) Object.assign(c.style, opt.style);
    return c;
  };
  /** Pointer helper: calls fn({x, y, u, v, down, type, e}) in canvas pixel coords (u,v ∈ [0,1]). */
  U.pointer = function (cv, fn, ctxHost) {
    let down = false;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
      return { u, v, x: u * cv.width, y: v * cv.height };
    };
    const onDown = (e) => { down = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} fn({ ...pos(e), down, type: 'down', e }); };
    const onMove = (e) => fn({ ...pos(e), down, type: 'move', e });
    const onUp = (e) => { if (!down) return; down = false; fn({ ...pos(e), down, type: 'up', e }); };
    const onLeave = (e) => fn({ ...pos(e), down, type: 'leave', e });
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('pointerleave', onLeave);
    cv.style.touchAction = 'none';
  };

  /* ---------------- Controls ---------------- */
  /** Range slider. opt: {label, min, max, step, value, fmt(v), onInput(v), log, unit}. */
  U.slider = function (o) {
    const { label, min = 0, max = 1, step = 0.01, log = false, unit = '' } = o;
    const fmt = o.fmt || ((v) => (Math.abs(v) >= 100 ? Math.round(v) : +v.toFixed(2)));
    const toPos = (v) => (log ? (Math.log(v / min) / Math.log(max / min)) * 1000 : v);
    const fromPos = (p) => {
      if (!log) return +p;
      const v = min * Math.pow(max / min, p / 1000);
      return step ? Math.round(v / step) * step : v;
    };
    const input = h('input.range', { type: 'range', min: log ? 0 : min, max: log ? 1000 : max, step: log ? 1 : step });
    const val = h('span.ctl-val');
    let value = o.value ?? min;
    const paint = () => {
      input.value = toPos(value);
      val.textContent = fmt(value) + (unit ? ' ' + unit : '');
      const p = (toPos(value) - +input.min) / (+input.max - +input.min);
      input.style.setProperty('--p', (p * 100).toFixed(2) + '%');
    };
    input.addEventListener('input', () => { value = fromPos(input.value); paint(); o.onInput && o.onInput(value); });
    paint();
    const el = h('label.ctl', { title: o.title || '' }, h('div.ctl-row', null, h('span.ctl-label', null, label), val), input);
    return { el, get value() { return value; }, set(v, silent) { value = v; paint(); if (!silent && o.onInput) o.onInput(v); } };
  };

  /** Segmented control. options: array of values, or [value, label] pairs. */
  U.seg = function (o) {
    const opts = o.options.map((x) => (Array.isArray(x) ? x : [x, String(x)]));
    let value = o.value ?? opts[0][0];
    const btns = opts.map(([v, l]) => {
      const b = h('button.seg-btn', { type: 'button', title: o.titles ? o.titles[v] || '' : '' });
      if (l instanceof Node) b.append(l); else b.innerHTML = l;
      b.addEventListener('click', () => set(v));
      b._v = v;
      return b;
    });
    const paint = () => btns.forEach((b) => b.classList.toggle('on', b._v === value));
    function set(v, silent) { value = v; paint(); if (!silent && o.onChange) o.onChange(v); }
    paint();
    const el = h('div.ctl', null, o.label ? h('div.ctl-row', null, h('span.ctl-label', null, o.label)) : null, h('div.seg' + (o.wrap ? '.wrap' : ''), null, btns));
    return { el, get value() { return value; }, set };
  };

  /** Toggle switch. */
  U.toggle = function (o) {
    let value = !!o.value;
    const sw = h('button.switch', { type: 'button', role: 'switch' }, h('span.knob'));
    const paint = () => { sw.classList.toggle('on', value); sw.setAttribute('aria-checked', value); };
    sw.addEventListener('click', () => set(!value));
    function set(v, silent) { value = !!v; paint(); if (!silent && o.onChange) o.onChange(value); }
    paint();
    const el = h('div.ctl.ctl-toggle', null, h('span.ctl-label', null, o.label), sw);
    return { el, get value() { return value; }, set };
  };

  /** Button. kind: 'primary' | 'ghost' | 'danger'. */
  U.button = function (o) {
    const b = h('button.btn' + (o.kind ? '.' + o.kind : ''), { type: 'button', title: o.title || '' },
      o.icon ? U.icon(o.icon, 16) : null, o.label ? h('span', null, o.label) : null);
    if (o.onClick) b.addEventListener('click', o.onClick);
    return b;
  };

  /** Big-number stat tile. returns {el, set(value, sub?)} */
  U.stat = function (label, unit = '', opt = {}) {
    const v = h('span.stat-v', null, '—'), u = h('span.stat-u', null, unit), sub = h('div.stat-sub');
    const bar = opt.bar ? h('div.stat-bar', null, h('i')) : null;
    const el = h('div.stat', null, h('div.stat-label', null, label), h('div.stat-row', null, v, u), bar, sub);
    return {
      el,
      set(val, subText, frac) {
        v.textContent = val;
        if (subText !== undefined) sub.textContent = subText;
        if (bar && frac !== undefined) bar.firstChild.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
      },
      color(c) { el.style.setProperty('--stat-c', c); },
    };
  };

  /** Floating tag that can sit on top of a stage element. */
  U.tag = (text, cls = '') => h('div.tag' + (cls ? '.' + cls : ''), null, text);

  /* ---------------- Toasts ---------------- */
  U.toast = function ({ title, line, color, icon = 'spark', ms = 5200 }) {
    let host = document.getElementById('toasts');
    if (!host) document.body.append((host = h('div#toasts')));
    const t = h('div.toast', { style: color ? { '--tc': color } : null },
      h('div.toast-ico', null, U.icon(icon, 18)),
      h('div.toast-body', null, h('div.toast-title', null, title), line ? h('div.toast-line', null, line) : null));
    host.append(t);
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 500); }, ms);
  };

  /* ---------------- Sources ---------------- */
  /** Image source picker. onChange({kind:'scene'|'image'|'video', el, id}). Returns {el, current, set(id)} */
  U.imageSource = function (o) {
    const scenes = o.scenes || SL.img.sceneList.map((s) => s.id);
    const labels = Object.fromEntries(SL.img.sceneList.map((s) => [s.id, s.label]));
    let current = null;
    const fileIn = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const opts = scenes.map((id) => [id, labels[id] || id]);
    if (o.upload !== false) opts.push(['__up', '<span class="seg-ico">⇪</span>']);
    if (o.camera) opts.push(['__cam', '<span class="seg-ico">◉</span>']);
    const seg = U.seg({
      label: o.label || 'Source', options: opts, value: o.value || scenes[0], wrap: true,
      titles: { __up: 'Your image', __cam: 'Webcam' },
      onChange: async (v) => {
        if (v === '__up') { fileIn.click(); return; }
        if (v === '__cam') {
          try {
            const vid = await SL.img.camera();
            emit({ kind: 'video', el: vid, id: 'cam' });
          } catch (e) {
            U.toast({ title: 'Camera unavailable', line: 'Serve over https or localhost and allow access.', color: '#ff6b6b', icon: 'cam' });
            seg.set(current?.id || scenes[0], true);
          }
          return;
        }
        SL.img.stopCamera();
        emit({ kind: 'scene', el: SL.img.scene(v, o.size || 512, o.size || 512), id: v });
      },
    });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0];
      if (!f) return;
      const im = await SL.img.loadFile(f);
      SL.img.stopCamera();
      emit({ kind: 'image', el: im, id: 'upload' });
      fileIn.value = '';
    });
    function emit(src) { current = src; o.onChange && o.onChange(src); }
    const el = h('div', null, seg.el, fileIn);
    const api = { el, get current() { return current; }, set(id) { seg.set(id); } };
    if (o.autoload !== false) setTimeout(() => seg.set(o.value || scenes[0]), 0);
    return api;
  };

  /** Audio clip source: built-in voice / record / upload. onAudio(x: Float32Array, sr, label). */
  U.audioSource = function (o) {
    const sr = o.sr || 16000, maxSec = o.maxSec || 4;
    const fileIn = h('input', { type: 'file', accept: 'audio/*', style: { display: 'none' } });
    const level = h('div.rec-level', null, h('i'));
    let rec = null;
    const emit = (x, srcSr, label) => {
      let y = SL.dsp.resample(x, srcSr, sr);
      if (o.trim !== false) y = SL.audio.trim(y, sr);
      y = SL.dsp.normalize(y, 0.9);
      o.onAudio && o.onAudio(y, sr, label);
    };
    const bDemo = U.button({ icon: 'wave', label: 'Demo voice', onClick: () => { stopRec(); emit(SL.audio.demoVoice(sr), sr, 'demo'); } });
    const bRec = U.button({ icon: 'mic', label: 'Record', kind: 'primary' });
    const bUp = U.button({ icon: 'upload', title: 'Upload audio', onClick: () => fileIn.click() });
    function stopRec() { if (rec) rec.stop(); }
    bRec.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      SL.audio.stop();
      rec = SL.audio.record(maxSec, (l) => level.firstChild.style.width = Math.min(100, l * 400) + '%');
      bRec.classList.add('rec');
      bRec.querySelector('span').textContent = 'Stop';
      rec.done.then(({ x, sr: s }) => { if (x.length > s * 0.2) emit(x, s, 'mic'); })
        .catch(() => U.toast({ title: 'Mic unavailable', line: 'Serve over https or localhost and allow access.', color: '#ff6b6b', icon: 'mic' }))
        .finally(() => { rec = null; bRec.classList.remove('rec'); bRec.querySelector('span').textContent = 'Record'; level.firstChild.style.width = '0'; });
    });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0];
      if (!f) return;
      try {
        const { x, sr: s } = await SL.audio.decodeFile(f);
        emit(x.subarray(0, Math.floor(s * (o.maxUploadSec || 8))), s, 'file');
      } catch (e) { U.toast({ title: 'Could not decode audio', color: '#ff6b6b', icon: 'wave' }); }
      fileIn.value = '';
    });
    const el = h('div.ctl', null, h('div.ctl-row', null, h('span.ctl-label', null, o.label || 'Sound')), h('div.btn-row', null, bDemo, bRec, bUp), level, fileIn);
    if (o.autoload !== false) setTimeout(() => emit(SL.audio.demoVoice(sr), sr, 'demo'), 0);
    return { el, stop: stopRec };
  };

  /* ---------------- Plot helpers (canvas 2D) ---------------- */
  /** Prepare a 2-D canvas for crisp drawing at devicePixelRatio, sized to its CSS box. Returns {ctx, w, h} in CSS px. */
  U.fit = function (cv) {
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: r.width, h: r.height };
  };
  /** Stroke a polyline of y-values across [x0, x1] mapping vmin..vmax to bottom..top. */
  U.line = function (ctx, ys, x0, x1, top, bottom, vmin, vmax, color, width = 1.5) {
    ctx.beginPath();
    const n = ys.length;
    for (let i = 0; i < n; i++) {
      const x = x0 + ((x1 - x0) * i) / (n - 1 || 1);
      const t = (ys[i] - vmin) / (vmax - vmin || 1);
      const y = bottom - Math.max(-0.05, Math.min(1.05, t)) * (bottom - top);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  };

  /** Theme colours read once from CSS custom properties. */
  U.theme = function () {
    const s = getComputedStyle(document.documentElement);
    const g = (n) => s.getPropertyValue(n).trim();
    return { eye: g('--eye'), ear: g('--ear'), bridge: g('--bridge'), ink: g('--ink'), dim: g('--ink-dim'), faint: g('--ink-faint'), line: g('--line'), bg: g('--bg'), good: g('--good'), bad: g('--bad'), warn: g('--warn') };
  };
})();
