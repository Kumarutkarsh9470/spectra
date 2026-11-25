/* SPECTRA — app shell: lab registry, router, lifecycle, insights, hub + constellation. Loaded LAST. */
(function () {
  const SL = (window.SL = window.SL || {});
  const h = SL.h, U = SL.ui;

  /* ---------------- Math pillars: the shared mathematics both senses run on ---------------- */
  SL.PILLARS = [
    { id: 'fourier', label: 'Fourier', glyph: '∿' },
    { id: 'sampling', label: 'Sampling', glyph: '⁞' },
    { id: 'noise', label: 'Noise', glyph: '≋' },
    { id: 'filter', label: 'Filtering', glyph: '⊛' },
    { id: 'predict', label: 'Prediction', glyph: '↗' },
    { id: 'quant', label: 'Quantisation', glyph: '▥' },
    { id: 'percept', label: 'Perception', glyph: '◉' },
  ];
  const SIDE = { eye: { label: 'EYE', icon: 'eye' }, ear: { label: 'EAR', icon: 'ear' }, bridge: { label: 'BRIDGE', icon: 'bridge' } };

  /* ---------------- Insight store ---------------- */
  const KEY = 'spectra.found.v1';
  let found = {};
  try { found = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { found = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(found)); } catch (e) {} };
  SL.isFound = (lab, key) => !!(found[lab] && found[lab].includes(key));
  SL.countFound = (lab) => {
    const L = SL.labs.find((l) => l.id === lab);
    return L ? L.concepts.filter((c) => SL.isFound(lab, c.key)).length : 0;
  };
  SL.totalFound = () => SL.labs.reduce((s, l) => s + SL.countFound(l.id), 0);
  SL.totalConcepts = () => SL.labs.reduce((s, l) => s + l.concepts.length, 0);

  /* ---------------- Registry ---------------- */
  SL.labs = SL.labs || [];
  /** Register a lab. def: {id, side, code, title, tagline, accent?, syllabus:[...], concepts:[{key,label,line,hint,math:[]}], build(ctx), thumb?(g,w,h,t)} */
  SL.lab = function (def) {
    def.concepts = def.concepts || [];
    SL.labs.push(def);
  };

  /* ---------------- Frame loop ---------------- */
  let frames = [], last = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    for (const f of frames.slice()) {
      try { f(t, dt); } catch (e) { console.error(e); frames = frames.filter((x) => x !== f); }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  /* ---------------- Router ---------------- */
  const app = document.getElementById('app');
  let active = null; // {lab, ctx, cleanups}

  function teardown() {
    if (active) {
      active.ctx.alive = false;
      for (const c of active.cleanups.reverse()) { try { c(); } catch (e) { console.error(e); } }
      active = null;
    }
    frames = [];
    SL.audio.stop();
    SL.audio.stopMic();
    SL.img.stopCamera();
  }

  function route() {
    const m = location.hash.match(/^#\/lab\/([\w-]+)/);
    teardown();
    app.innerHTML = '';
    window.scrollTo(0, 0);
    const lab = m && SL.labs.find((l) => l.id === m[1]);
    if (lab) openLab(lab); else renderHub();
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active && !e.target.closest('input,textarea')) location.hash = '#/';
  });

  /* ---------------- Lab view ---------------- */
  function openLab(lab) {
    const side = SIDE[lab.side] || SIDE.eye;
    document.title = `${lab.title} · SPECTRA`;
    const chipEls = {};
    const prog = h('div.lab-prog');
    const chips = h('div.chips', null, lab.concepts.map((c) => {
      const el = h('button.chip', { type: 'button' }, h('i.chip-dot'), h('span', null, c.label));
      chipEls[c.key] = el;
      el.addEventListener('click', () => {
        if (SL.isFound(lab.id, c.key)) U.toast({ title: c.label, line: c.line, color: `var(--${lab.side})` });
        else U.toast({ title: 'Not found yet', line: c.hint || 'Keep experimenting.', color: 'var(--ink-faint)', icon: 'info', ms: 3000 });
      });
      return el;
    }));
    const paintChips = () => {
      lab.concepts.forEach((c) => {
        const on = SL.isFound(lab.id, c.key);
        chipEls[c.key].classList.toggle('lit', on);
        chipEls[c.key].dataset.tip = on ? c.line : c.hint || '?';
      });
      prog.innerHTML = '';
      prog.append(h('b', null, SL.countFound(lab.id)), h('span', null, '/' + lab.concepts.length));
    };
    const head = h('header.lab-head', null,
      h('a.back', { href: '#/', title: 'Back to SPECTRA (Esc)' }, U.icon('back', 20)),
      h('div.lab-id', null,
        h('div.lab-code', null, U.icon(side.icon, 14), h('span', null, `${side.label} · ${lab.code}`)),
        h('h1.lab-title', null, lab.title),
        h('div.lab-tag', null, lab.tagline)),
      chips, prog);
    const stage = h('main.lab-stage');
    const rail = h('aside.lab-rail');
    const root = h('div.labview', { 'data-side': lab.side }, head, h('div.lab-body', null, stage, rail));
    app.append(root);

    const cleanups = [];
    const ctx = {
      lab, root, stage, rail, head, alive: true,
      frame(fn) { frames.push(fn); return () => (frames = frames.filter((f) => f !== fn)); },
      on(t, ev, fn, opt) { t.addEventListener(ev, fn, opt); cleanups.push(() => t.removeEventListener(ev, fn, opt)); },
      cleanup(fn) { cleanups.push(fn); },
      timeout(fn, ms) { const id = setTimeout(() => ctx.alive && fn(), ms); cleanups.push(() => clearTimeout(id)); return id; },
      interval(fn, ms) { const id = setInterval(() => ctx.alive && fn(), ms); cleanups.push(() => clearInterval(id)); return id; },
      found: (key) => SL.isFound(lab.id, key),
      /** Unlock an insight: lights its chip, shows its one-line explanation. Idempotent. */
      discover(key) {
        const c = lab.concepts.find((x) => x.key === key);
        if (!c || SL.isFound(lab.id, key) || !ctx.alive) return false;
        (found[lab.id] = found[lab.id] || []).push(key);
        save();
        paintChips();
        chipEls[key].classList.add('pop');
        setTimeout(() => chipEls[key] && chipEls[key].classList.remove('pop'), 1200);
        U.toast({ title: c.label, line: c.line, color: `var(--${lab.side})` });
        return true;
      },
    };
    active = { lab, ctx, cleanups };
    paintChips();
    try { lab.build(ctx); } catch (e) {
      console.error(e);
      stage.append(h('div.err', null, 'This lab hit an error: ' + e.message));
    }
  }

  /* ---------------- Hub ---------------- */
  function renderHub() {
    document.title = 'SPECTRA · eyes & ears, one mathematics';
    const total = SL.totalConcepts(), got = SL.totalFound();
    const ring = h('div.ring', { style: { '--p': total ? got / total : 0 } }, h('b', null, got), h('span', null, '/' + total));
    const constel = h('canvas.constel');
    const hero = h('section.hero', null,
      h('div.hero-text', null,
        h('div.brand', null, h('span.brand-mark'), 'SPECTRA'),
        h('h1', null, 'Two senses.', h('br'), h('em', null, 'One mathematics.')),
        h('p.hero-sub', null, 'Eight instruments. No lectures. Break them until they make sense.'),
        h('div.hero-meta', null, ring, h('div.ring-lab', null, 'insights', h('br'), 'unlocked'),
          h('button.btn.ghost.sm', { type: 'button', onClick: () => { if (confirm('Forget every unlocked insight?')) { found = {}; save(); route(); } } }, U.icon('reset', 14), h('span', null, 'Reset')))),
      h('div.constel-wrap', null, constel));
    const sections = ['eye', 'bridge', 'ear'].map((side) => {
      const labs = SL.labs.filter((l) => l.side === side);
      if (!labs.length) return null;
      return h('section.deck', { 'data-side': side },
        h('div.deck-head', null, U.icon(SIDE[side].icon, 16), h('span', null, SIDE[side].label),
          h('i.deck-rule')),
        h('div.deck-grid', null, labs.map(card)));
    });
    const foot = h('footer.foot', null,
      h('span', null, 'Built on the IIT Guwahati courses '),
      h('a', { href: 'https://spinlabiitg.github.io/vip/', target: '_blank', rel: 'noopener' }, 'Vision & Image Processing'),
      h('span', null, ' and '),
      h('a', { href: 'https://spinlabiitg.github.io/sap/', target: '_blank', rel: 'noopener' }, 'Speech & Audio Processing'),
      h('span', null, '. Every algorithm here is written from scratch in plain JavaScript.'));
    app.append(h('div.hub', null, hero, ...sections, foot));

    // animated thumbnails
    const thumbs = [...app.querySelectorAll('canvas.thumb')];
    frames.push((t) => {
      for (const cv of thumbs) {
        const r = cv.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) continue;
        const lab = SL.labs.find((l) => l.id === cv.dataset.lab);
        const { ctx, w, h: H } = U.fit(cv);
        ctx.clearRect(0, 0, w, H);
        try { (lab.thumb || defaultThumb)(ctx, w, H, t, lab); } catch (e) { defaultThumb(ctx, w, H, t, lab); }
      }
    });
    constellation(constel);
  }

  function card(lab) {
    const n = SL.countFound(lab.id), N = lab.concepts.length;
    const pips = h('div.pips', null, lab.concepts.map((c) => h('i' + (SL.isFound(lab.id, c.key) ? '.on' : ''))));
    return h('a.lcard', { href: '#/lab/' + lab.id, 'data-side': lab.side },
      h('canvas.thumb', { 'data-lab': lab.id }),
      h('div.lcard-body', null,
        h('div.lcard-code', null, lab.code),
        h('h3', null, lab.title),
        h('p', null, lab.tagline),
        h('div.lcard-foot', null, pips, h('span.lcard-n', null, `${n}/${N}`))),
      lab.syllabus ? h('div.lcard-syl', null, lab.syllabus.join(' · ')) : null);
  }

  function defaultThumb(g, w, H, t, lab) {
    const col = getComputedStyle(document.documentElement).getPropertyValue('--' + (lab ? lab.side : 'eye'));
    g.strokeStyle = col; g.lineWidth = 1.5; g.globalAlpha = 0.8;
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const y = H / 2 + Math.sin(x / 18 + t * (1 + k * 0.3) + k) * (H / 6) * Math.sin(t * 0.5 + k);
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  /* ---------------- Constellation: labs ↔ shared mathematics ---------------- */
  function constellation(cv) {
    const th = U.theme();
    const P = SL.PILLARS;
    let hover = null, nodes = [], mouse = { x: -1, y: -1 }, compact = false;
    const sparks = [];
    function layout(w, H) {
      nodes = [];
      const eye = SL.labs.filter((l) => l.side === 'eye'), ear = SL.labs.filter((l) => l.side === 'ear'), br = SL.labs.filter((l) => l.side === 'bridge');
      const colY = (i, n) => H * (0.14 + (0.72 * (i + 0.5)) / n);
      compact = w < 640;
      if (compact) {
        // phones: eye row on top, ear row at the bottom, maths ring in between, bridge at its heart
        const rowX = (i, n) => w * (0.12 + (0.76 * (i + 0.5)) / n);
        eye.forEach((l, i) => nodes.push({ kind: 'lab', lab: l, x: rowX(i, eye.length), y: H * 0.08 }));
        ear.forEach((l, i) => nodes.push({ kind: 'lab', lab: l, x: rowX(i, ear.length), y: H * 0.92 }));
        br.forEach((l) => nodes.push({ kind: 'lab', lab: l, x: w * 0.5, y: H * 0.5 }));
        P.forEach((p, i) => {
          const a = (i / P.length) * Math.PI * 2 - Math.PI / 2;
          nodes.push({ kind: 'pillar', p, x: w * 0.5 + Math.cos(a) * w * 0.34, y: H * 0.5 + Math.sin(a) * H * 0.25 });
        });
        return;
      }
      const side = Math.max(150, w * 0.22);
      eye.forEach((l, i) => nodes.push({ kind: 'lab', lab: l, x: side, y: colY(i, eye.length) }));
      ear.forEach((l, i) => nodes.push({ kind: 'lab', lab: l, x: w - side, y: colY(i, ear.length) }));
      br.forEach((l, i) => nodes.push({ kind: 'lab', lab: l, x: w * 0.5, y: H * 0.86 }));
      P.forEach((p, i) => {
        const a = (i / P.length) * Math.PI * 2 - Math.PI / 2;
        const rx = Math.max(60, Math.min((w - 2 * side) * 0.5 - 70, H * 0.3));
        nodes.push({ kind: 'pillar', p, x: w * 0.5 + Math.cos(a) * rx, y: H * 0.43 + Math.sin(a) * H * 0.29 });
      });
    }
    function edges() {
      const out = [];
      for (const n of nodes) {
        if (n.kind !== 'lab') continue;
        const per = {};
        for (const c of n.lab.concepts) for (const m of c.math || []) {
          per[m] = per[m] || { tot: 0, got: 0 };
          per[m].tot++;
          if (SL.isFound(n.lab.id, c.key)) per[m].got++;
        }
        for (const m in per) {
          const pn = nodes.find((x) => x.kind === 'pillar' && x.p.id === m);
          if (pn) out.push({ a: n, b: pn, frac: per[m].got / per[m].tot, side: n.lab.side });
        }
      }
      return out;
    }
    let E = [];
    let lastW = 0, lastH = 0;
    U.pointer(cv, (p) => {
      const r = cv.getBoundingClientRect();
      mouse = { x: p.u * r.width, y: p.v * r.height };
      if (p.type === 'up' && hover && hover.kind === 'lab') location.hash = '#/lab/' + hover.lab.id;
      if (p.type === 'leave') mouse = { x: -1, y: -1 };
    });
    frames.push((t) => {
      const { ctx: g, w, h: H } = U.fit(cv);
      if (w !== lastW || H !== lastH) { layout(w, H); E = edges(); lastW = w; lastH = H; }
      g.clearRect(0, 0, w, H);
      hover = null;
      for (const n of nodes) if (Math.hypot(n.x - mouse.x, n.y - mouse.y) < (n.kind === 'lab' ? 40 : 26)) hover = n;
      cv.style.cursor = hover && hover.kind === 'lab' ? 'pointer' : 'default';
      // edges
      for (const e of E) {
        const hl = hover && (hover === e.a || hover === e.b);
        const col = th[e.side] || th.eye;
        const mx = (e.a.x + e.b.x) / 2, my = (e.a.y + e.b.y) / 2 - 20;
        g.beginPath(); g.moveTo(e.a.x, e.a.y); g.quadraticCurveTo(mx, my, e.b.x, e.b.y);
        g.strokeStyle = col;
        g.globalAlpha = hl ? 0.9 : 0.17 + 0.6 * e.frac;
        g.lineWidth = hl ? 2 : 1 + e.frac * 1.5;
        g.setLineDash(e.frac > 0 || hl ? [] : [3, 5]);
        g.stroke();
        g.setLineDash([]);
        // travelling sparks on lit edges
        if (e.frac > 0 || hl) {
          const s = ((t * 0.35 + e.a.y * 0.013 + e.b.x * 0.007) % 1);
          const x = (1 - s) ** 2 * e.a.x + 2 * (1 - s) * s * mx + s * s * e.b.x;
          const y = (1 - s) ** 2 * e.a.y + 2 * (1 - s) * s * my + s * s * e.b.y;
          g.globalAlpha = 0.9; g.fillStyle = col;
          g.beginPath(); g.arc(x, y, 2.2, 0, 7); g.fill();
        }
      }
      g.globalAlpha = 1;
      // nodes
      for (const n of nodes) {
        const hl = hover === n;
        if (n.kind === 'pillar') {
          const lit = E.filter((e) => e.b === n).reduce((s, e) => s + e.frac, 0);
          const r = (compact ? 15 : 22) + Math.min(compact ? 4 : 8, lit * 2);
          const grd = g.createRadialGradient(n.x, n.y, 2, n.x, n.y, r * 2.2);
          grd.addColorStop(0, `rgba(255,255,255,${0.08 + Math.min(0.25, lit * 0.06)})`); grd.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grd; g.beginPath(); g.arc(n.x, n.y, r * 2.2, 0, 7); g.fill();
          g.fillStyle = '#0d0f17'; g.strokeStyle = hl ? th.ink : 'rgba(255,255,255,.25)'; g.lineWidth = 1.2;
          g.beginPath(); g.arc(n.x, n.y, r, 0, 7); g.fill(); g.stroke();
          g.fillStyle = th.ink; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.font = '600 18px "Space Grotesk", system-ui'; g.fillText(n.p.glyph, n.x, n.y + 1);
          g.font = `500 ${compact ? 8.5 : 10.5}px "JetBrains Mono", ui-monospace, monospace`; g.fillStyle = th.dim;
          g.fillText(n.p.label.toUpperCase(), n.x, n.y + r + (compact ? 10 : 13));
        } else {
          const col = th[n.lab.side];
          const frac = SL.countFound(n.lab.id) / (n.lab.concepts.length || 1);
          const r = compact ? (hl ? 21 : 18) : hl ? 30 : 26;
          g.fillStyle = '#0b0d14'; g.beginPath(); g.arc(n.x, n.y, r, 0, 7); g.fill();
          g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 3; g.beginPath(); g.arc(n.x, n.y, r, 0, 7); g.stroke();
          g.strokeStyle = col; g.lineWidth = 3; g.beginPath(); g.arc(n.x, n.y, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2 + 0.001); g.stroke();
          if (hl) { g.shadowColor = col; g.shadowBlur = 20; g.stroke(); g.shadowBlur = 0; }
          g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.font = '700 13px "JetBrains Mono", ui-monospace, monospace'; g.fillText(n.lab.code, n.x, n.y);
          if (compact) continue; // codes only on phones; the cards below carry the titles
          g.fillStyle = hl ? th.ink : th.dim; g.font = `${hl ? 600 : 500} 12px Inter, system-ui`;
          // labels sit on the outside of each column so they never cross the edges
          const lx = n.lab.side === 'eye' ? n.x - r - 10 : n.lab.side === 'ear' ? n.x + r + 10 : n.x;
          g.textAlign = n.lab.side === 'eye' ? 'right' : n.lab.side === 'ear' ? 'left' : 'center';
          g.fillText(n.lab.title, lx, n.lab.side === 'bridge' ? n.y + r + 15 : n.y);
        }
      }
    });
  }

  /* ---------------- Boot ---------------- */
  // Order labs: eye → bridge → ear, by code
  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    SL.labs.sort((a, b) => (a.code > b.code ? 1 : -1));
    route();
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
