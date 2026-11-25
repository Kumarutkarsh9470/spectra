/* SPECTRA · E4 Foveal Engine — render only what the eye can see; let a machine guess where it will look.
 * Fovea: per-pixel blur-pyramid blend driven by eccentricity, acuity ∝ 1/(1+E/E₂).
 * Machine gaze: Itti–Koch–Niebur saliency (intensity, R–G / B–Y opponency, orientation; centre–surround; N(·)),
 *               winner-take-all + inhibition of return scanpath.
 * Your gaze: dwell-based fixation detection on a foveated view, scored against saliency with NSS.
 */
(function () {
  const SL = window.SL, h = SL.h, U = SL.ui, I = SL.img;
  const S = 512, N = S * S, MAXL = 6;       // working image + pyramid depth
  const SS = 128, NS = SS * SS;             // saliency resolution
  const DS = S / SS;


  /* ---------- pyramid ---------- */
  function down2(src, w, hh) {
    // [1 4 6 4 1]/16 separable blur, then decimate by 2 (interleaved RGB)
    const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
    const tmp = new Float32Array(w * hh * 3);
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let j = -2; j <= 2; j++) { const xx = Math.min(w - 1, Math.max(0, x + j)); s += k[j + 2] * src[(y * w + xx) * 3 + c]; }
      tmp[(y * w + x) * 3 + c] = s;
    }
    const W2 = w >> 1, H2 = hh >> 1, out = new Float32Array(W2 * H2 * 3);
    for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let j = -2; j <= 2; j++) { const yy = Math.min(hh - 1, Math.max(0, 2 * y + j)); s += k[j + 2] * tmp[(yy * w + 2 * x) * 3 + c]; }
      out[(y * W2 + x) * 3 + c] = s;
    }
    return { w: W2, h: H2, d: out };
  }

  /* ---------- saliency (Itti, Koch & Niebur 1998), from scratch ---------- */
  function normalizeMap(m) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < m.length; i++) { if (m[i] < mn) mn = m[i]; if (m[i] > mx) mx = m[i]; }
    const sc = mx - mn > 1e-9 ? 1 / (mx - mn) : 0;
    const out = new Float32Array(m.length);
    for (let i = 0; i < m.length; i++) out[i] = (m[i] - mn) * sc;
    // N(·): promote maps with few strong peaks — weight by (1 − mean of local maxima)²
    const B = 16, maxima = [];
    for (let by = 0; by < SS; by += B) for (let bx = 0; bx < SS; bx += B) {
      let m2 = 0;
      for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) m2 = Math.max(m2, out[y * SS + x]);
      maxima.push(m2);
    }
    maxima.sort((a, b) => b - a);
    const rest = maxima.slice(1);
    const mbar = rest.reduce((s, v) => s + v, 0) / (rest.length || 1);
    const wgt = (1 - mbar) ** 2;
    for (let i = 0; i < out.length; i++) out[i] *= wgt;
    return out;
  }
  function centreSurround(F) {
    const blurs = { 1: I.blur(F, SS, SS, 1), 2: I.blur(F, SS, SS, 2), 4: I.blur(F, SS, SS, 4), 8: I.blur(F, SS, SS, 8), 16: I.blur(F, SS, SS, 16) };
    const acc = new Float32Array(NS);
    for (const [c, s] of [[1, 4], [1, 8], [2, 8], [2, 16]]) {
      const C = blurs[c], Sx = blurs[s], m = new Float32Array(NS);
      for (let i = 0; i < NS; i++) m[i] = Math.abs(C[i] - Sx[i]);
      const n = normalizeMap(m);
      for (let i = 0; i < NS; i++) acc[i] += n[i];
    }
    return acc;
  }
  function saliency(id, centreBias) {
    const d = id.data, r = new Float32Array(NS), g = new Float32Array(NS), b = new Float32Array(NS), In = new Float32Array(NS);
    let imax = 0;
    for (let i = 0; i < NS; i++) { r[i] = d[i * 4] / 255; g[i] = d[i * 4 + 1] / 255; b[i] = d[i * 4 + 2] / 255; In[i] = (r[i] + g[i] + b[i]) / 3; imax = Math.max(imax, In[i]); }
    const RG = new Float32Array(NS), BY = new Float32Array(NS);
    for (let i = 0; i < NS; i++) {
      if (In[i] < 0.1 * imax) continue;
      const R = Math.max(0, r[i] - (g[i] + b[i]) / 2), G = Math.max(0, g[i] - (r[i] + b[i]) / 2);
      const Bc = Math.max(0, b[i] - (r[i] + g[i]) / 2), Y = Math.max(0, (r[i] + g[i]) / 2 - Math.abs(r[i] - g[i]) / 2 - b[i]);
      RG[i] = R - G; BY[i] = Bc - Y;
    }
    // orientation energy at 0°, 45°, 90°, 135° from gradients of the smoothed intensity
    const Ib = I.blur(In, SS, SS, 1.2), gx = new Float32Array(NS), gy = new Float32Array(NS);
    for (let y = 1; y < SS - 1; y++) for (let x = 1; x < SS - 1; x++) {
      const i = y * SS + x;
      gx[i] = (Ib[i + 1] - Ib[i - 1]) / 2; gy[i] = (Ib[i + SS] - Ib[i - SS]) / 2;
    }
    const Ocon = new Float32Array(NS);
    for (const th of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
      const c = Math.cos(th), s = Math.sin(th), e = new Float32Array(NS);
      for (let i = 0; i < NS; i++) e[i] = Math.abs(gx[i] * c + gy[i] * s);
      const cs = centreSurround(I.blur(e, SS, SS, 1));
      const n = normalizeMap(cs);
      for (let i = 0; i < NS; i++) Ocon[i] += n[i];
    }
    const Icon = centreSurround(In);
    const Ccon = centreSurround(RG), c2 = centreSurround(BY);
    for (let i = 0; i < NS; i++) Ccon[i] += c2[i];
    const nI = normalizeMap(Icon), nC = normalizeMap(Ccon), nO = normalizeMap(Ocon);
    let Sm = new Float32Array(NS);
    for (let i = 0; i < NS; i++) Sm[i] = (nI[i] + nC[i] + nO[i]) / 3;
    Sm = I.blur(Sm, SS, SS, 2);
    if (centreBias) {
      const sg = 0.32 * SS;
      for (let y = 0; y < SS; y++) for (let x = 0; x < SS; x++) {
        const dx = x - SS / 2, dy = y - SS / 2;
        Sm[y * SS + x] *= 0.35 + 0.65 * Math.exp(-(dx * dx + dy * dy) / (2 * sg * sg));
      }
    }
    let mx = 0;
    for (let i = 0; i < NS; i++) mx = Math.max(mx, Sm[i]);
    for (let i = 0; i < NS; i++) Sm[i] /= mx || 1;
    const unit = (m) => { let a = 0; for (let i = 0; i < NS; i++) a = Math.max(a, m[i]); return m.map((v) => v / (a || 1)); };
    return { S: Sm, I: unit(nI), C: unit(nC), O: unit(nO) };
  }

  function scanpath(Sm, n, ior) {
    const s = Float32Array.from(Sm), fx = [], snaps = [];
    const sg = 0.075 * SS;
    for (let k = 0; k < n; k++) {
      snaps.push(Float32Array.from(s));
      let bi = 0, bv = -1;
      for (let i = 0; i < NS; i++) if (s[i] > bv) { bv = s[i]; bi = i; }
      const x = bi % SS, y = (bi / SS) | 0;
      fx.push({ x: (x + 0.5) * DS, y: (y + 0.5) * DS, v: Sm[bi], dur: Math.round(180 + 240 * Sm[bi]) });
      if (ior) {
        for (let yy = 0; yy < SS; yy++) for (let xx = 0; xx < SS; xx++) {
          const d2 = (xx - x) ** 2 + (yy - y) ** 2;
          s[yy * SS + xx] *= 1 - Math.exp(-d2 / (2 * sg * sg));
        }
      }
    }
    snaps.push(Float32Array.from(s));
    return { fx, snaps };
  }

  function heatCanvas(m) {
    const c = document.createElement('canvas');
    c.width = SS; c.height = SS;
    const g = c.getContext('2d'), id = g.createImageData(SS, SS), lut = I.lut('inferno');
    for (let i = 0; i < NS; i++) {
      const v = Math.max(0, Math.min(1, m[i])), k = (v * 255) | 0;
      id.data[i * 4] = lut[k * 3]; id.data[i * 4 + 1] = lut[k * 3 + 1]; id.data[i * 4 + 2] = lut[k * 3 + 2];
      id.data[i * 4 + 3] = Math.round(255 * Math.min(1, 0.08 + Math.pow(v, 1.3) * 0.95));
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  SL.lab({
    id: 'fovea', side: 'eye', code: 'E4',
    title: 'Foveal Engine',
    tagline: 'Render only what the eye can see.',
    syllabus: ['VIP M3 §1, §4–5, §7'],
    concepts: [
      { key: 'acuity', label: 'Acuity falloff', math: ['percept', 'sampling'], hint: 'Move your fovea around',
        line: 'Resolution falls as 1/(1+E/E₂) with E₂ ≈ 2°. Ten degrees out, you resolve detail about 6× coarser than at the fovea.' },
      { key: 'budget', label: 'Foveated rendering', math: ['sampling', 'filter'], hint: 'Push the budget past 80%',
        line: 'Rendering full detail only where acuity is high cuts the samples needed by more than 80%. Eye-tracked VR headsets do exactly this.' },
      { key: 'color', label: 'Peripheral colour', math: ['percept'], hint: 'Toggle colour loss',
        line: 'Cones crowd the fovea and rods dominate the periphery, so colour discrimination fades away from fixation. The brain fills the colour back in.' },
      { key: 'blindspot', label: 'Blind spot', math: ['percept'], hint: 'Find the hole',
        line: 'Where the optic nerve leaves the eye, about 15° temporal, there are no receptors at all. Vision fills the ~5° hole with the surrounding texture.' },
      { key: 'saliency', label: 'Bottom-up saliency', math: ['filter', 'percept'], hint: 'Let the machine look',
        line: 'Centre–surround contrast in the intensity, colour-opponent and orientation channels, normalised and summed, predicts what pops out (Itti, Koch & Niebur 1998).' },
      { key: 'ior', label: 'Inhibition of return', math: ['percept'], hint: 'Switch IOR off',
        line: 'After each fixation the attended spot is suppressed. Without that, winner-take-all would stare at the single most salient point forever.' },
      { key: 'compare', label: 'Human vs machine', math: ['percept', 'predict'], hint: 'Look around, then compare',
        line: 'Real scanpaths mix bottom-up pop-out with top-down goals (Yarbus 1967). NSS > 1 means your fixations landed on salient spots well above chance.' },
    ],

    thumb(g, w, hh, t) {
      const fx = w * (0.5 + 0.3 * Math.sin(t * 0.7)), fy = hh * (0.5 + 0.28 * Math.sin(t * 1.1 + 1));
      const sp = 11;
      for (let y = sp / 2; y < hh; y += sp) for (let x = sp / 2; x < w; x += sp) {
        const e = Math.hypot(x - fx, y - fy) / 40, a = 1 / (1 + e);
        const hue = (x * 0.6 + y * 0.9) % 360;
        g.fillStyle = `hsla(${hue}, ${Math.round(80 * a)}%, ${45 + 20 * a}%, ${0.25 + 0.75 * a})`;
        const r = 1 + 3.6 * a;
        g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      }
      g.strokeStyle = '#4de1ff'; g.lineWidth = 1.5; g.shadowColor = '#4de1ff'; g.shadowBlur = 10;
      g.beginPath(); g.arc(fx, fy, 13, 0, 7); g.stroke(); g.shadowBlur = 0;
    },

    build(ctx) {
      const st = { mode: 'fovea', fov: 60, e2: 2, gain: 2.5, color: false, blind: false, bias: true, ior: true, heat: true, nfix: 8, showMachine: true, foveateYou: true };
      let src = null, lev = null, baseCv = document.createElement('canvas'), sal = null, path = null, heatSnaps = [];
      baseCv.width = baseCv.height = S;
      const fovCv = document.createElement('canvas');
      fovCv.width = fovCv.height = S;
      const fovImg = fovCv.getContext('2d').createImageData(S, S);
      let fovea = { x: S / 2, y: S / 2 }, fovDirty = true, budget = 0, moved = 0;
      const flags = {};

      /* ---------- stage ---------- */
      const mainCv = U.canvas(S, S, { cls: 'fv-main-cv' });
      const modeTag = U.tag('', 'acc');
      modeTag.classList.add('fv-mode-tag');
      const viewCard = h('div.card.fv-view', null, h('div.card-label', null, 'Retina'), modeTag, mainCv);
      // side: fovea
      const budgetBig = h('div.fv-big', null, h('b', null, '—'), h('span', null, '%'));
      const budgetSub = h('div.fv-big-sub');
      const acuCv = h('canvas.fv-plot');
      const densCv = U.canvas(128, 128, { cls: 'fv-dens' });
      const sideFovea = h('div.fv-side-block', null,
        U.card('Shading budget saved', h('div.fv-budget', null, h('div', null, budgetBig, budgetSub), densCv)),
        U.card('Acuity vs eccentricity', acuCv, h('div.legend', null,
          h('span', null, h('i', { style: { background: 'var(--eye)' } }), 'eye'),
          h('span', null, h('i', { style: { background: 'var(--warn)' } }), 'display limit'),
          h('span', null, h('i', { style: { background: 'rgba(77,225,255,.25)', height: '8px' } }), 'samples saved'))));
      // side: machine
      const chanCv = ['I', 'C', 'O', 'S'].map(() => U.canvas(SS, SS, { cls: 'fv-chan-cv' }));
      const chanNames = ['Intensity', 'Colour opp.', 'Orientation', 'Saliency'];
      const timeline = h('canvas.fv-timeline');
      const sideMachine = h('div.fv-side-block', null,
        U.card('Feature channels', h('div.fv-chans', null, chanCv.map((c, i) => h('div.fv-chan', null, c, h('span', null, chanNames[i]))))),
        U.card('Fixations', timeline));
      // side: you
      const stFix = U.stat('Fixations', ''), stDur = U.stat('Mean dwell', 'ms'), stNSS = U.stat('NSS', 'z', { bar: true }), stMatch = U.stat('Hit rate', '%');
      const youPlot = h('canvas.fv-timeline');
      const sideYou = h('div.fv-side-block', null,
        U.card('Agreement with saliency', h('div.stat-grid.fv-you-stats', null, stFix.el, stDur.el, stNSS.el, stMatch.el)),
        U.card('Your dwell vs machine', youPlot));
      ctx.stage.append(h('div.fv-main', null, viewCard, h('div.fv-side', null, sideFovea, sideMachine, sideYou)));

      /* ---------- rail ---------- */
      const imgSrc = U.imageSource({
        scenes: ['city', 'market', 'text', 'zone'], size: S,
        onChange: (s) => { src = s; loadSource(); },
      });
      const modeSeg = U.seg({ options: [['fovea', 'Fovea'], ['machine', 'Machine gaze'], ['you', 'Your gaze']], value: st.mode,
        onChange: (v) => setMode(v, true) });
      const sFov = U.slider({ label: 'Field of view', min: 20, max: 140, step: 1, value: st.fov, unit: '°', fmt: (v) => Math.round(v),
        onInput: (v) => { st.fov = v; flags.slid = true; fovDirty = true; } });
      const sE2 = U.slider({ label: 'E₂ (half-acuity)', min: 0.3, max: 8, step: 0.1, value: st.e2, unit: '°', fmt: (v) => v.toFixed(1),
        onInput: (v) => { st.e2 = v; flags.slid = true; fovDirty = true; } });
      const sGain = U.slider({ label: 'Blur gain (visual)', min: 1, max: 4, step: 0.1, value: st.gain, unit: '×', fmt: (v) => v.toFixed(1),
        onInput: (v) => { st.gain = v; fovDirty = true; } });
      const tCol = U.toggle({ label: 'Peripheral colour loss', value: st.color, onChange: (v) => { st.color = v; flags.col = v; fovDirty = true; } });
      const tBlind = U.toggle({ label: 'Blind spot (right eye)', value: st.blind, onChange: (v) => { st.blind = v; flags.blind = v; fovDirty = true; } });
      const tBias = U.toggle({ label: 'Centre bias', value: st.bias, onChange: (v) => { st.bias = v; computeSaliency(); } });
      const tIOR = U.toggle({ label: 'Inhibition of return', value: st.ior, onChange: (v) => { st.ior = v; flags.iorToggled = true; recomputePath(); } });
      const tHeat = U.toggle({ label: 'Heat map', value: st.heat, onChange: (v) => { st.heat = v; } });
      const sFix = U.slider({ label: 'Fixations', min: 3, max: 14, step: 1, value: st.nfix, fmt: (v) => v, onInput: (v) => { st.nfix = v; recomputePath(); } });
      const bReplay = U.button({ icon: 'play', label: 'Replay', kind: 'primary', onClick: () => { animT0 = performance.now(); } });
      const tMach = U.toggle({ label: 'Show machine path', value: st.showMachine, onChange: (v) => { st.showMachine = v; } });
      const tFovYou = U.toggle({ label: 'Foveated view', value: st.foveateYou, onChange: (v) => { st.foveateYou = v; fovDirty = true; } });
      const bClear = U.button({ icon: 'reset', label: 'Clear my path', onClick: () => { you.length = 0; updateYou(); } });
      const gFovea = U.group('Optics', sFov.el, sE2.el, sGain.el, tCol.el, tBlind.el);
      const gMachine = U.group('Saliency model', tBias.el, tIOR.el, tHeat.el, sFix.el, h('div.btn-row', null, bReplay));
      const gYou = U.group('Recording', h('div.hint', null, 'Rest the cursor ≥ 200 ms to fixate.'), tFovYou.el, tMach.el, h('div.btn-row', null, bClear));
      ctx.rail.append(U.group('Scene', imgSrc.el), U.group('Mode', modeSeg.el), gFovea, gMachine, gYou);

      function setMode(m, byUser) {
        st.mode = m;
        sideFovea.style.display = m === 'fovea' ? '' : 'none';
        sideMachine.style.display = m === 'machine' ? '' : 'none';
        sideYou.style.display = m === 'you' ? '' : 'none';
        gFovea.style.display = m === 'machine' ? 'none' : '';
        gMachine.style.display = m === 'machine' ? '' : 'none';
        gYou.style.display = m === 'you' ? '' : 'none';
        modeTag.textContent = m === 'fovea' ? 'FOVEA · move to look' : m === 'machine' ? 'ITTI–KOCH · WTA + IOR' : 'RECORDING · dwell to fixate';
        fovDirty = true;
        if (m === 'machine') { animT0 = performance.now(); if (byUser) ctx.discover('saliency'); }
        if (m === 'you') updateYou();
        if (m === 'fovea') drawAcuity();
      }

      /* ---------- source ---------- */
      function loadSource() {
        if (!src) return;
        const id = I.grab(src.el, S, S);
        baseCv.getContext('2d').putImageData(id, 0, 0);
        const d = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) { d[i * 3] = id.data[i * 4] / 255; d[i * 3 + 1] = id.data[i * 4 + 1] / 255; d[i * 3 + 2] = id.data[i * 4 + 2] / 255; }
        lev = [{ w: S, h: S, d }];
        for (let k = 1; k <= MAXL; k++) lev.push(down2(lev[k - 1].d, lev[k - 1].w, lev[k - 1].h));
        computeSaliency();
        fovDirty = true;
      }
      let salId = null, zmap = null;
      function computeSaliency() {
        if (!src) return;
        salId = I.grab(baseCv, SS, SS);
        sal = saliency(salId, st.bias);
        let m = 0, v = 0;
        for (let i = 0; i < NS; i++) m += sal.S[i];
        m /= NS;
        for (let i = 0; i < NS; i++) v += (sal.S[i] - m) ** 2;
        const sd = Math.sqrt(v / NS) || 1;
        zmap = sal.S.map((x) => (x - m) / sd);
        ['I', 'C', 'O', 'S'].forEach((k, i) => I.draw(chanCv[i], sal[k], SS, SS, { cmap: k === 'S' ? 'inferno' : 'ice', min: 0, max: 1 }));
        recomputePath();
        updateYou();
      }
      let animT0 = performance.now();
      function recomputePath() {
        if (!sal) return;
        path = scanpath(sal.S, st.nfix, st.ior);
        heatSnaps = path.snaps.map(heatCanvas);
        animT0 = performance.now();
        if (flags.iorToggled && st.mode === 'machine') ctx.discover('ior');
        drawTimeline();
      }

      /* ---------- foveated rendering ---------- */
      const lutL = new Float32Array(1100), lutW = new Float32Array(1100), lutSat = new Float32Array(1100);
      function renderFovea() {
        if (!lev) return;
        const d = st.fov / S, E2 = st.e2;
        for (let r = 0; r < lutL.length; r++) {
          const E = r * d, scale = (1 + E / E2) / (60 * d);
          const L = scale <= 1 ? 0 : Math.min(MAXL, Math.log2(scale));
          lutL[r] = Math.min(MAXL, L * st.gain); // visual exaggeration only; the budget below uses the true scale
          lutW[r] = scale <= 1 ? 1 : Math.max(4 ** -MAXL, 1 / (scale * scale));
          lutSat[r] = st.color ? 1 / (1 + (E / 14) ** 2) : 1;
        }
        const fx = fovea.x, fy = fovea.y, out = fovImg.data;
        const bx = fx + 15 / d, by = fy + 1.5 / d, rx = 2.75 / d, ry = 3.75 / d;
        let samples = 0;
        const col = [0, 0, 0], col2 = [0, 0, 0];
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const dx = x - fx, dy = y - fy;
            const ri = Math.min(lutL.length - 1, Math.sqrt(dx * dx + dy * dy) | 0);
            let L = lutL[ri];
            samples += lutW[ri];
            if (st.blind) { const ex = (x - bx) / rx, ey = (y - by) / ry; if (ex * ex + ey * ey < 1) L = MAXL; }
            const k0 = L | 0, t = L - k0;
            sample(k0, x, y, col);
            if (t > 0.02 && k0 < MAXL) {
              sample(k0 + 1, x, y, col2);
              col[0] += (col2[0] - col[0]) * t; col[1] += (col2[1] - col[1]) * t; col[2] += (col2[2] - col[2]) * t;
            }
            const sat = lutSat[ri];
            if (sat < 0.999) {
              const lum = 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2];
              col[0] = lum + (col[0] - lum) * sat; col[1] = lum + (col[1] - lum) * sat; col[2] = lum + (col[2] - lum) * sat;
            }
            const j = (y * S + x) * 4;
            out[j] = col[0] * 255; out[j + 1] = col[1] * 255; out[j + 2] = col[2] * 255; out[j + 3] = 255;
          }
        }
        fovCv.getContext('2d').putImageData(fovImg, 0, 0);
        budget = 1 - samples / N;
        if (st.mode === 'fovea') {
          budgetBig.firstChild.textContent = (budget * 100).toFixed(1);
          budgetSub.textContent = `${Math.round(samples / 1000)}k of ${Math.round(N / 1000)}k samples`;
          drawDensity(d, E2);
          drawAcuity();
        }
      }
      function sample(k, x, y, out) {
        const L = lev[k], w = L.w, hh = L.h, sc = 1 / (1 << k);
        let u = (x + 0.5) * sc - 0.5, v = (y + 0.5) * sc - 0.5;
        if (u < 0) u = 0; if (v < 0) v = 0;
        let x0 = u | 0, y0 = v | 0;
        if (x0 > w - 2) x0 = w - 2; if (y0 > hh - 2) y0 = hh - 2;
        const tx = Math.min(1, u - x0), ty = Math.min(1, v - y0), D = L.d;
        const a = (y0 * w + x0) * 3, b = a + 3, c = a + w * 3, e = c + 3;
        for (let ch = 0; ch < 3; ch++) {
          const top = D[a + ch] + (D[b + ch] - D[a + ch]) * tx, bot = D[c + ch] + (D[e + ch] - D[c + ch]) * tx;
          out[ch] = top + (bot - top) * ty;
        }
      }
      function drawDensity(d, E2) {
        const g = densCv.getContext('2d'), id = g.createImageData(128, 128), lut = I.lut('ice');
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
          const r = Math.min(lutW.length - 1, Math.hypot(x * 4 + 2 - fovea.x, y * 4 + 2 - fovea.y) | 0);
          const k = Math.round(Math.sqrt(lutW[r]) * 255) * 3, j = (y * 128 + x) * 4;
          id.data[j] = lut[k]; id.data[j + 1] = lut[k + 1]; id.data[j + 2] = lut[k + 2]; id.data[j + 3] = 255;
        }
        g.putImageData(id, 0, 0);
      }
      function drawAcuity() {
        const { ctx: g, w, h: hh } = U.fit(acuCv), th = U.theme();
        g.clearRect(0, 0, w, hh);
        const L = 34, R = 10, T = 12, B = 24, d = st.fov / S;
        const Emax = Math.max(10, Math.max(Math.hypot(fovea.x, fovea.y), Math.hypot(S - fovea.x, fovea.y), Math.hypot(fovea.x, S - fovea.y), Math.hypot(S - fovea.x, S - fovea.y)) * d);
        const X = (E) => L + (E / Emax) * (w - L - R), Y = (a) => hh - B - a * (hh - T - B);
        g.font = '500 9.5px "JetBrains Mono", monospace'; g.fillStyle = th.faint; g.strokeStyle = 'rgba(255,255,255,.06)';
        const step = Emax > 60 ? 20 : Emax > 25 ? 10 : 5;
        for (let E = 0; E <= Emax; E += step) { g.beginPath(); g.moveTo(X(E), T); g.lineTo(X(E), hh - B); g.stroke(); g.textAlign = 'center'; g.fillText(E + '°', X(E), hh - B + 13); }
        for (const a of [0, 0.5, 1]) { g.beginPath(); g.moveTo(L, Y(a)); g.lineTo(w - R, Y(a)); g.stroke(); g.textAlign = 'right'; g.fillText(a.toFixed(1), L - 5, Y(a) + 3); }
        const cap = Math.min(1, 1 / (60 * d)); // the finest relative acuity the display can show
        const acu = (E) => 1 / (1 + E / st.e2);
        // shaded savings: where the display could show more than the eye can see
        g.beginPath(); g.moveTo(X(0), Y(cap));
        for (let k = 0; k <= 100; k++) { const E = (Emax * k) / 100; g.lineTo(X(E), Y(Math.min(cap, acu(E)))); }
        g.lineTo(X(Emax), Y(cap)); g.closePath(); g.fillStyle = 'rgba(77,225,255,.16)'; g.fill();
        g.setLineDash([4, 4]); g.strokeStyle = th.warn; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(L, Y(cap)); g.lineTo(w - R, Y(cap)); g.stroke(); g.setLineDash([]);
        g.beginPath();
        for (let k = 0; k <= 100; k++) { const E = (Emax * k) / 100; const x = X(E), y = Y(acu(E)); k ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.strokeStyle = th.eye; g.lineWidth = 2; g.stroke();
        // E₂ marker
        g.fillStyle = th.eye; g.beginPath(); g.arc(X(st.e2), Y(0.5), 3.5, 0, 7); g.fill();
        g.textAlign = 'left'; g.fillText('E₂', X(st.e2) + 6, Y(0.5) - 6);
        g.fillStyle = th.dim; g.textAlign = 'right'; g.fillText('eccentricity →', w - R - 2, T + 8);
        g.textAlign = 'left'; g.fillText('relative acuity', L + 6, T + 8);
      }

      /* ---------- machine gaze drawing ---------- */
      function pathTiming() {
        const SAC = 70, SCALE = 1.6;
        let t = 0;
        return path.fx.map((f) => { const s = t; t += SAC + f.dur * SCALE; return { start: s, arrive: s + SAC, end: t }; });
      }
      function drawPath(g, fx, upto, col, prog, numbered = true) {
        if (!fx.length) return;
        g.lineWidth = 2; g.strokeStyle = col; g.globalAlpha = 0.9;
        g.beginPath();
        for (let k = 0; k <= Math.min(upto, fx.length - 1); k++) {
          const f = fx[k];
          let x = f.x, y = f.y;
          if (k === upto && prog < 1 && k > 0) { x = fx[k - 1].x + (f.x - fx[k - 1].x) * prog; y = fx[k - 1].y + (f.y - fx[k - 1].y) * prog; }
          k ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
        for (let k = 0; k <= Math.min(upto, fx.length - 1); k++) {
          if (k === upto && prog < 1 && k > 0) break;
          const f = fx[k], r = 7 + f.dur / 40;
          g.globalAlpha = 0.25; g.fillStyle = col; g.beginPath(); g.arc(f.x, f.y, r, 0, 7); g.fill();
          g.globalAlpha = 1; g.lineWidth = 2; g.strokeStyle = col; g.beginPath(); g.arc(f.x, f.y, r, 0, 7); g.stroke();
          if (numbered) {
            g.fillStyle = '#fff'; g.font = '700 12px "JetBrains Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(String(k + 1), f.x, f.y + 0.5);
          }
        }
        g.globalAlpha = 1; g.textBaseline = 'alphabetic';
      }
      function drawMachine(now) {
        const g = mainCv.getContext('2d');
        g.drawImage(baseCv, 0, 0);
        if (!path) return;
        const tm = pathTiming(), el = now - animT0, total = tm[tm.length - 1].end + 1400;
        const e = el % total;
        let k = tm.findIndex((x) => e < x.end);
        if (k < 0) k = tm.length - 1;
        const done = e >= tm[tm.length - 1].end;
        const prog = done ? 1 : Math.min(1, (e - tm[k].start) / (tm[k].arrive - tm[k].start));
        if (st.heat) {
          g.fillStyle = 'rgba(4,6,10,.5)'; g.fillRect(0, 0, S, S);
          g.globalAlpha = 0.9; g.imageSmoothingEnabled = true;
          g.drawImage(heatSnaps[done ? heatSnaps.length - 1 : k] || heatSnaps[0], 0, 0, S, S);
          g.globalAlpha = 1;
        } else { g.fillStyle = 'rgba(4,6,10,.15)'; g.fillRect(0, 0, S, S); }
        drawPath(g, path.fx, done ? path.fx.length - 1 : k, '#4de1ff', prog);
        if (!done) {
          const f = path.fx[k], p = k > 0 ? path.fx[k - 1] : f;
          const x = p.x + (f.x - p.x) * prog, y = p.y + (f.y - p.y) * prog;
          g.fillStyle = '#fff'; g.shadowColor = '#4de1ff'; g.shadowBlur = 18;
          g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); g.shadowBlur = 0;
          if (prog >= 1) {
            const dwell = (e - tm[k].arrive) / (tm[k].end - tm[k].arrive);
            g.strokeStyle = '#fff'; g.lineWidth = 2;
            g.beginPath(); g.arc(x, y, 16, -Math.PI / 2, -Math.PI / 2 + dwell * Math.PI * 2); g.stroke();
          }
        }
        drawTimeline(done ? path.fx.length : k);
      }
      function drawTimeline(active = -1) {
        if (!path) return;
        const { ctx: g, w, h: hh } = U.fit(timeline), th = U.theme();
        g.clearRect(0, 0, w, hh);
        const n = path.fx.length, bw = (w - 20) / n, mx = 420;
        g.font = '500 9.5px "JetBrains Mono", monospace'; g.textAlign = 'center';
        path.fx.forEach((f, k) => {
          const bh = (f.dur / mx) * (hh - 40), x = 10 + k * bw;
          g.fillStyle = k < active ? th.eye : k === active ? '#fff' : 'rgba(255,255,255,.12)';
          g.fillRect(x + 3, hh - 22 - bh, bw - 6, bh);
          g.fillStyle = th.faint; g.fillText(String(k + 1), x + bw / 2, hh - 8);
          if (k <= active) { g.fillStyle = th.dim; g.fillText(f.dur, x + bw / 2, hh - 26 - bh); }
        });
      }

      /* ---------- your gaze ---------- */
      const you = [];
      let anchor = null;
      function onGaze(p) {
        const now = performance.now();
        if (!anchor || Math.hypot(p.x - anchor.x, p.y - anchor.y) > 20) {
          closeFix(now);
          anchor = { x: p.x, y: p.y, t: now, sx: p.x, sy: p.y, n: 1 };
        } else { anchor.sx += p.x; anchor.sy += p.y; anchor.n++; }
      }
      function closeFix(now) {
        if (anchor && now - anchor.t >= 200) {
          you.push({ x: anchor.sx / anchor.n, y: anchor.sy / anchor.n, dur: Math.min(2000, Math.round(now - anchor.t)) });
          if (you.length > 40) you.shift();
          updateYou();
        }
        anchor = null;
      }
      function nssOf(list) {
        if (!zmap || !list.length) return 0;
        let s = 0;
        for (const f of list) s += zmap[Math.min(SS - 1, (f.y / DS) | 0) * SS + Math.min(SS - 1, (f.x / DS) | 0)];
        return s / list.length;
      }
      function updateYou() {
        if (st.mode !== 'you') return;
        const n = you.length, nss = nssOf(you);
        stFix.set(String(n));
        stDur.set(n ? Math.round(you.reduce((s, f) => s + f.dur, 0) / n) : '—');
        stNSS.set(n ? nss.toFixed(2) : '—', n ? (nss > 1 ? 'well above chance' : nss > 0.3 ? 'above chance' : 'near chance') : 'chance = 0', Math.max(0, nss / 2.5));
        stNSS.color(nss > 1 ? 'var(--good)' : nss > 0.3 ? 'var(--warn)' : 'var(--eye)');
        // hit rate: fraction of your fixations within 60 px of any machine fixation
        let hit = 0;
        if (path) for (const f of you) if (path.fx.some((m) => Math.hypot(m.x - f.x, m.y - f.y) < 60)) hit++;
        stMatch.set(n ? Math.round((hit / n) * 100) : '—', 'within 60 px of a machine fixation');
        if (n >= 5) ctx.discover('compare');
        drawYouPlot();
      }
      function drawYouPlot() {
        const { ctx: g, w, h: hh } = U.fit(youPlot), th = U.theme();
        g.clearRect(0, 0, w, hh);
        // per-fixation saliency z-score: you (cyan) vs machine (violet)
        const rows = [['you', you, th.eye], ['machine', path ? path.fx : [], th.bridge]];
        const zmax = 4;
        g.font = '500 9.5px "JetBrains Mono", monospace';
        const rowH = hh / 2;
        rows.forEach(([lab, list, col], r) => {
          const y0 = r * rowH + 11, top = y0 + 6, bot = (r + 1) * rowH - 6, rh = bot - top;
          g.fillStyle = th.faint; g.textAlign = 'left'; g.fillText(lab.toUpperCase() + ' · z(saliency) per fixation', 4, y0);
          const items = list.slice(-16), bw = Math.min(26, (w - 8) / Math.max(8, items.length));
          items.forEach((f, k) => {
            const z = zmap ? zmap[Math.min(SS - 1, (f.y / DS) | 0) * SS + Math.min(SS - 1, (f.x / DS) | 0)] : 0;
            const bh = Math.max(1, (Math.max(0, Math.min(zmax, z)) / zmax) * rh);
            g.fillStyle = col; g.globalAlpha = 0.85;
            g.fillRect(4 + k * bw, bot - bh, bw - 4, bh);
          });
          g.globalAlpha = 1;
          g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(4, bot, w - 8, 1);
        });
      }
      function drawYou(now) {
        const g = mainCv.getContext('2d');
        g.drawImage(st.foveateYou ? fovCv : baseCv, 0, 0);
        if (st.showMachine && path) {
          g.setLineDash([5, 5]); drawPath(g, path.fx, path.fx.length - 1, 'rgba(185,156,255,.85)', 1, false); g.setLineDash([]);
        }
        drawPath(g, you, you.length - 1, '#4de1ff', 1);
        if (anchor) {
          const dw = Math.min(1, (now - anchor.t) / 200);
          g.strokeStyle = dw >= 1 ? '#5ef2a0' : 'rgba(255,255,255,.7)'; g.lineWidth = 2;
          g.beginPath(); g.arc(anchor.sx / anchor.n, anchor.sy / anchor.n, 14, -Math.PI / 2, -Math.PI / 2 + dw * Math.PI * 2); g.stroke();
        }
      }

      function drawFoveaView() {
        const g = mainCv.getContext('2d');
        g.drawImage(fovCv, 0, 0);
        g.strokeStyle = 'rgba(77,225,255,.9)'; g.lineWidth = 1.5;
        g.beginPath(); g.arc(fovea.x, fovea.y, 2 / (st.fov / S), 0, 7); g.stroke();
        g.beginPath(); g.moveTo(fovea.x - 6, fovea.y); g.lineTo(fovea.x + 6, fovea.y); g.moveTo(fovea.x, fovea.y - 6); g.lineTo(fovea.x, fovea.y + 6); g.stroke();
        if (st.blind) {
          const d = st.fov / S;
          g.setLineDash([3, 4]); g.strokeStyle = 'rgba(255,200,87,.55)';
          g.beginPath(); g.ellipse(fovea.x + 15 / d, fovea.y + 1.5 / d, 2.75 / d, 3.75 / d, 0, 0, 7); g.stroke(); g.setLineDash([]);
        }
      }

      /* ---------- interaction ---------- */
      U.pointer(mainCv, (p) => {
        if (p.type === 'leave') { if (st.mode === 'you') closeFix(performance.now()); return; }
        if (st.mode === 'machine') return;
        if (st.mode === 'fovea' || st.mode === 'you') {
          moved += Math.hypot(p.x - fovea.x, p.y - fovea.y);
          fovea = { x: p.x, y: p.y };
          fovDirty = true;
          if (st.mode === 'you') onGaze(p);
          else {
            if (moved > 700) ctx.discover('acuity');
            if (flags.col && st.color && moved > 200) ctx.discover('color');
            if (flags.blind && st.blind && moved > 200) ctx.discover('blindspot');
          }
        }
      });

      let lastFov = 0;
      ctx.frame(() => {
        const now = performance.now();
        if (!lev) return;
        if (fovDirty && (st.mode !== 'machine') && now - lastFov > 30) {
          fovDirty = false; lastFov = now;
          renderFovea();
          if (st.mode === 'fovea' && flags.slid && budget > 0.8) ctx.discover('budget');
        }
        if (st.mode === 'fovea') drawFoveaView();
        else if (st.mode === 'machine') drawMachine(now);
        else {
          if (anchor && now - anchor.t > 2000) closeFix(now);
          drawYou(now);
        }
      });
      ctx.on(window, 'resize', () => { drawAcuity(); drawTimeline(); drawYouPlot(); });
      setMode('fovea');
    },
  });
})();
