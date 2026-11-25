/* SPECTRA · E2 Spectral Darkroom — repair, sculpt, swap and hybridise images by editing their 2-D Fourier spectrum. */
(function () {
  const SL = window.SL, U = SL.ui, D = SL.dsp, I = SL.img, h = SL.h;
  const N = 256, C = 128, NN = N * N;

  /* ---------- Fourier helpers ---------- */
  const fwd = (img) => {
    const re = new Float64Array(NN), im = new Float64Array(NN);
    re.set(img);
    D.fft2(re, im, N, N);
    return { re, im };
  };
  /** Multiply spectrum F (unshifted) by mask M (DC-centred) and invert. Returns real image. */
  function filtered(F, M) {
    const re = new Float64Array(NN), im = new Float64Array(NN);
    for (let y = 0; y < N; y++) {
      const row = ((y + C) % N) * N;
      for (let x = 0; x < N; x++) {
        const i = y * N + x, m = M[row + ((x + C) % N)];
        re[i] = F.re[i] * m; im[i] = F.im[i] * m;
      }
    }
    D.fft2(re, im, N, N, true);
    return re;
  }
  /** Spectrum built from a magnitude source and a phase source (each optional). */
  function combine(Fm, Fp, shiftOut) {
    const re = new Float64Array(NN), im = new Float64Array(NN);
    for (let i = 0; i < NN; i++) {
      const m = Fm ? Math.hypot(Fm.re[i], Fm.im[i]) : 1;
      const p = Fp ? Math.atan2(Fp.im[i], Fp.re[i]) : 0;
      re[i] = m * Math.cos(p); im[i] = m * Math.sin(p);
    }
    D.fft2(re, im, N, N, true);
    return shiftOut ? D.shift2(re, N, N) : re;
  }
  function logMag(F) {
    const m = new Float32Array(NN);
    for (let i = 0; i < NN; i++) m[i] = Math.log1p(Math.hypot(F.re[i], F.im[i]));
    return D.shift2(m, N, N);
  }
  function psnr(a, ref) {
    let e = 0;
    for (let i = 0; i < NN; i++) { const v = a[i] < 0 ? 0 : a[i] > 1 ? 1 : a[i]; e += (v - ref[i]) ** 2; }
    return 10 * Math.log10(1 / (e / NN + 1e-12));
  }
  const loadGray = (src) => I.gray(I.grab(src.el, N, N));

  /* ---------- Spectrum painter view ---------- */
  function SpecView(opt) {
    const cv = U.canvas(8, 8, { cls: 'dr-sq' });
    const off = document.createElement('canvas');
    off.width = off.height = N;
    const v = { cv, off, hover: null, dirty: true, lm: null, lo: 0, hi: 1 };
    let last = null;
    U.pointer(cv, (p) => {
      if (p.type === 'leave') { v.hover = null; v.dirty = true; opt.onHover && opt.onHover(null); return; }
      const fx = p.u * N, fy = p.v * N;
      v.hover = { fx, fy };
      v.dirty = true;
      opt.onHover && opt.onHover({ u: Math.round(fx) - C, v: Math.round(fy) - C });
      if (p.down && opt.paint) {
        if (last) {
          const dx = fx - last.fx, dy = fy - last.fy, steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, opt.radius() * 0.4)));
          for (let s = 1; s <= steps; s++) opt.paint(last.fx + (dx * s) / steps, last.fy + (dy * s) / steps);
        } else opt.paint(fx, fy);
        last = { fx, fy };
      }
      if (p.type === 'up') { last = null; opt.onPaintEnd && opt.onPaintEnd(); }
    });
    v.setSpectrum = (lm) => {
      v.lm = lm;
      const s = Float32Array.from(lm).sort();
      v.lo = s[Math.floor(NN * 0.45)]; v.hi = s[NN - 2];
      v.dirty = true;
    };
    v.render = (M) => {
      if (!v.lm) return;
      const g = off.getContext('2d'), img = g.createImageData(N, N), d = img.data, lut = I.lut('magma');
      const sc = 255 / (v.hi - v.lo || 1);
      for (let i = 0; i < NN; i++) {
        let t = ((v.lm[i] - v.lo) * sc) | 0;
        t = t < 0 ? 0 : t > 255 ? 255 : t;
        const m = M ? M[i] : 1, k = 0.1 + 0.9 * m, w = 1 - m;
        d[i * 4] = lut[t * 3] * k + 6 * w;
        d[i * 4 + 1] = lut[t * 3 + 1] * k + 24 * w;
        d[i * 4 + 2] = lut[t * 3 + 2] * k + 34 * w;
        d[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      v.dirty = true;
    };
    v.draw = () => {
      if (!v.dirty) return;
      v.dirty = false;
      const { ctx: g, w } = U.fit(cv);
      const s = w / N;
      g.imageSmoothingEnabled = false;
      g.drawImage(off, 0, 0, w, w);
      // polar guides
      g.save();
      g.translate(w / 2, w / 2);
      g.strokeStyle = 'rgba(255,255,255,.13)'; g.lineWidth = 1; g.setLineDash([2, 4]);
      g.font = '500 9px "JetBrains Mono", monospace'; g.fillStyle = 'rgba(255,255,255,.4)';
      for (const r of [8, 16, 32, 64, 128]) {
        g.beginPath(); g.arc(0, 0, r * s, 0, Math.PI * 2); g.stroke();
        if (r < 128) g.fillText(r, r * s * 0.707 + 3, -r * s * 0.707 - 2);
      }
      g.setLineDash([]);
      g.strokeStyle = 'rgba(255,255,255,.07)';
      for (let a = 0; a < 180; a += 30) {
        const c = Math.cos((a * Math.PI) / 180), sn = Math.sin((a * Math.PI) / 180);
        g.beginPath(); g.moveTo(-c * w, -sn * w); g.lineTo(c * w, sn * w); g.stroke();
      }
      g.restore();
      g.fillStyle = 'rgba(255,255,255,.45)'; g.font = '600 10px "JetBrains Mono", monospace';
      g.fillText('u →', w - 30, w / 2 - 6); g.fillText('v ↓', w / 2 + 6, 16);
      // cursor + mirrored ghost
      if (v.hover) {
        const x = v.hover.fx * s, y = v.hover.fy * s, mx = w - x, my = w - y;
        const r = opt.paint ? Math.max(2, opt.radius() * s) : 5;
        g.strokeStyle = '#fff'; g.lineWidth = 1.4;
        g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke();
        g.setLineDash([3, 3]); g.strokeStyle = 'rgba(77,225,255,.9)';
        g.beginPath(); g.arc(mx, my, r, 0, 7); g.stroke(); g.setLineDash([]);
        g.strokeStyle = 'rgba(77,225,255,.25)';
        g.beginPath(); g.moveTo(x, y); g.lineTo(mx, my); g.stroke();
        const u = Math.round(v.hover.fx) - C, vv = Math.round(v.hover.fy) - C;
        const txt = `(${u}, ${vv})  ρ ${Math.hypot(u, vv).toFixed(1)}  θ ${Math.round((Math.atan2(-vv, u) * 180) / Math.PI)}°`;
        g.font = '600 10.5px "JetBrains Mono", monospace';
        const tw = g.measureText(txt).width + 12;
        g.fillStyle = 'rgba(6,7,12,.78)'; g.fillRect(8, w - 28, tw, 20);
        g.fillStyle = '#9ff3ff'; g.fillText(txt, 14, w - 14);
      }
    };
    return v;
  }

  /* ---------- Grating inset: "this point is this wave" ---------- */
  function GratingView() {
    const cv = U.canvas(N, N, { cls: 'dr-sq' });
    const tags = h('div.dr-wtags');
    let key = '';
    const set = (F, u, v) => {
      const k = u + ',' + v + (F ? '' : '-');
      if (k === key) return;
      key = k;
      const g = cv.getContext('2d'), img = g.createImageData(N, N), d = img.data, lut = I.lut('ice');
      let amp = 1, ph = 0;
      if (F) {
        const idx = ((v + N) % N) * N + ((u + N) % N);
        amp = Math.hypot(F.re[idx], F.im[idx]); ph = Math.atan2(F.im[idx], F.re[idx]);
      }
      const w = (2 * Math.PI) / N;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const c = Math.cos(w * (u * x + v * y) + ph), t = Math.round(127.5 + 127.5 * c) * 3, i = (y * N + x) * 4;
        d[i] = lut[t]; d[i + 1] = lut[t + 1]; d[i + 2] = lut[t + 2]; d[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const rho = Math.hypot(u, v);
      tags.innerHTML = '';
      tags.append(
        h('span', null, `ρ ${rho.toFixed(1)}`),
        h('span', null, `θ ${Math.round((Math.atan2(-v, u) * 180) / Math.PI)}°`),
        h('span', null, rho ? `λ ${(N / rho).toFixed(1)}px` : 'DC'),
        h('span', null, `|F| ${(2 * amp / NN).toFixed(3)}`));
    };
    return { cv, tags, set };
  }

  /* ---------- Small line plot ---------- */
  function plotProfile(cv, ys, color) {
    const { ctx: g, w, h: H } = U.fit(cv);
    g.clearRect(0, 0, w, H);
    let mx = 0;
    for (const y of ys) mx = Math.max(mx, Math.abs(y));
    g.strokeStyle = 'rgba(255,255,255,.12)';
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(w, H / 2); g.stroke();
    g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, H); g.stroke();
    U.line(g, ys, 4, w - 4, 8, H - 8, -mx, mx, color, 1.6);
    g.fillStyle = 'rgba(255,255,255,.4)'; g.font = '500 9px "JetBrains Mono", monospace';
    g.fillText('h[x, 0]', 6, 12);
  }

  /* =================================================================== */
  (SL.lab || ((d) => (SL.labs = SL.labs || []).push(d)))({
    id: 'darkroom',
    side: 'eye',
    code: 'E2',
    title: 'Spectral Darkroom',
    tagline: 'Repair photos by editing their waves.',
    syllabus: ['VIP M2 §2–3, §7, §9–11'],
    concepts: [
      { key: 'gratings', label: 'Every dot is a wave', line: 'Each point (u,v) of the spectrum is one grating: distance from centre = spatial frequency, angle = orientation, value = amplitude & phase.', hint: 'Hover the spectrum', math: ['fourier'] },
      { key: 'symmetry', label: 'Conjugate symmetry', line: 'A real image has F(−u,−v) = F*(u,v): every wave lives at two mirrored points, so every edit must be mirrored too.', hint: 'Paint on the spectrum', math: ['fourier'] },
      { key: 'notch', label: 'Notch filter', line: 'Periodic interference is a few bright spikes in frequency; zeroing just those spikes removes it while barely touching the photo.', hint: 'Repair: erase the bright spikes', math: ['filter', 'noise'] },
      { key: 'ringing', label: 'Gibbs ringing', line: 'A brick-wall low-pass is a sinc-like kernel in space, so sharp edges grow ripples; a Gaussian cutoff does not ring.', hint: 'Sculpt: tiny ideal low-pass', math: ['filter', 'fourier'] },
      { key: 'convthm', label: 'Convolution theorem', line: 'Multiplying the spectrum by H is the same as convolving the image with h = F⁻¹{H}: watch the kernel change as you reshape the mask.', hint: 'Sculpt: compare two masks', math: ['filter', 'fourier'] },
      { key: 'orient', label: 'Orientation wedge', line: 'Edges create energy perpendicular to themselves; a wedge in frequency keeps only structures of one orientation.', hint: 'Sculpt: rotate a wedge', math: ['filter', 'percept'] },
      { key: 'phase', label: 'Phase is structure', line: 'Swap magnitude and phase between two images: the result looks like the image that donated the phase. Magnitude only sets the coarse/fine mix.', hint: 'Try the Swap mode', math: ['fourier', 'percept'] },
      { key: 'hybrid', label: 'Hybrid image', line: 'Low frequencies of one image plus high frequencies of another: up close you see the fine one; step back (blur + shrink) and the coarse one takes over.', hint: 'Hybrid: step back', math: ['percept', 'filter'] },
    ],

    thumb(g, w, H, t) {
      const cx = w * 0.72, cy = H / 2, a = t * 0.45, r = H * 0.28;
      // grating on left half
      g.save();
      g.beginPath(); g.rect(0, 0, w * 0.46, H); g.clip();
      const ca = Math.cos(a), sa = Math.sin(a), k = 0.12 + 0.05 * Math.sin(t * 0.7);
      for (let y = 0; y < H; y += 3) for (let x = 0; x < w * 0.46; x += 3) {
        const v = 0.5 + 0.5 * Math.cos(k * (x * ca + y * sa) * 2);
        g.fillStyle = `rgba(77,225,255,${v * 0.75})`;
        g.fillRect(x, y, 3, 3);
      }
      g.restore();
      // spectrum on right
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.setLineDash([2, 4]);
      for (const rr of [r * 0.5, r, r * 1.5]) { g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.stroke(); }
      g.setLineDash([]);
      const d = r * (k / 0.17);
      for (const s of [1, -1]) {
        const x = cx + s * ca * d, y = cy + s * sa * d;
        const gr = g.createRadialGradient(x, y, 0, x, y, 12);
        gr.addColorStop(0, '#fff'); gr.addColorStop(0.3, 'rgba(77,225,255,.9)'); gr.addColorStop(1, 'rgba(77,225,255,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, 12, 0, 7); g.fill();
      }
      g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 3, 0, 7); g.fill();
    },

    build(ctx) {
      const { stage, rail } = ctx;
      const S = {
        mode: 'repair', A: null, B: null, idA: 'city', idB: 'text',
        damage: '2', seed: (Math.random() * 1e6) | 0, brush: 5, paintMode: 'erase',
        preset: 'ideal', r1: 40, r2: 80, ang: 30, wid: 18, invert: false, presetsSeen: new Set(),
        c1: 10, c2: 22, dist: 1, lastShare: null,
      };
      let M = new Float32Array(NN).fill(1); // DC-centred mask
      let F = null, base = null, damaged = null, result = null, resultDirty = false, hovered = new Set();
      const resultCv = U.canvas(N, N, { cls: 'dr-sq' });
      const imgCv = U.canvas(N, N, { cls: 'dr-sq' });
      let spec = null, grating = null, modeTick = null;

      /* ----- rail ----- */
      const modeSeg = U.seg({
        options: [['repair', 'Repair'], ['sculpt', 'Sculpt'], ['swap', 'Swap'], ['hybrid', 'Hybrid']],
        value: S.mode, onChange: (m) => { S.mode = m; buildMode(); },
      });
      const modeRail = h('div.dr-rail');
      const stats = h('div.stat-grid');
      rail.append(U.group('Mode', modeSeg.el), modeRail, U.group('Readout', stats));

      /* ----- common compute ----- */
      function brushAt(fx, fy) {
        const r = S.brush;
        const stamp = (cx, cy) => {
          for (let y = Math.max(0, Math.floor(cy - r - 2)); y <= Math.min(N - 1, Math.ceil(cy + r + 2)); y++)
            for (let x = Math.max(0, Math.floor(cx - r - 2)); x <= Math.min(N - 1, Math.ceil(cx + r + 2)); x++) {
              const t = D.clamp(r + 0.5 - Math.hypot(x - cx, y - cy), 0, 1), i = y * N + x;
              M[i] = S.paintMode === 'erase' ? Math.min(M[i], 1 - t) : Math.max(M[i], t);
            }
        };
        stamp(fx, fy);
        stamp(N - fx, N - fy); // conjugate mirror
        spec.render(M);
        resultDirty = true;
        ctx.discover('symmetry');
      }
      function onHover(p) {
        if (!p || !F) return;
        grating.set(F, p.u, p.v);
        if (Math.hypot(p.u, p.v) > 2) hovered.add(p.u + ',' + p.v);
        if (hovered.size > 25) ctx.discover('gratings');
      }

      /* ----- per-mode builders ----- */
      function clear(el) { el.innerHTML = ''; }
      function card(label, ...kids) { return U.card(label, ...kids); }
      function specCard(label, ...kids) { const c = U.card(label, ...kids); c.classList.add('dr-spec'); return c; }

      function buildMode() {
        clear(stage); clear(modeRail); clear(stats);
        S.lastShare = null;
        if (modeTick) { modeTick(); modeTick = null; }
        ({ repair: buildRepair, sculpt: buildSculpt, swap: buildSwap, hybrid: buildHybrid })[S.mode]();
      }

      function sourcePicker(which, label) {
        const id = which === 'A' ? S.idA : S.idB;
        const has = which === 'A' ? S.A : S.B;
        return U.imageSource({
          label, size: N, value: id, autoload: !has,
          onChange: (src) => {
            if (which === 'A') { S.A = loadGray(src); S.idA = src.id; } else { S.B = loadGray(src); S.idB = src.id; }
            onSource(which);
          },
        }).el;
      }
      let onSource = () => {};

      /* ===== REPAIR ===== */
      function buildRepair() {
        spec = SpecView({ paint: brushAt, radius: () => S.brush, onHover });
        grating = GratingView();
        const target = U.canvas(N, N, { cls: 'dr-sq' }), errCv = U.canvas(N, N, { cls: 'dr-sq' });
        stage.append(
          h('div.dr-grid3', null,
            card('Damaged', imgCv),
            specCard('Spectrum · paint to notch', spec.cv),
            card('Result', resultCv)),
          h('div.dr-grid3.dr-sub', null,
            card('Wave under cursor', grating.cv, grating.tags),
            card('Target', target),
            card('Error ×4', errCv)));
        const sP = U.stat('PSNR', 'dB', { bar: true }), sD = U.stat('Damaged', 'dB'), sR = U.stat('Bins cut', '%');
        stats.append(sP.el, sD.el, sR.el);
        const dmg = U.seg({ label: 'Interference', options: [['2', '2 waves'], ['3', '3 waves'], ['screen', 'Halftone']], value: S.damage, onChange: (v) => { S.damage = v; reset(); } });
        const brush = U.slider({ label: 'Brush', min: 1, max: 20, step: 0.5, value: S.brush, unit: 'bins', onInput: (v) => (S.brush = v) });
        const pm = U.seg({ label: 'Paint', options: [['erase', 'Notch'], ['keep', 'Restore']], value: S.paintMode, onChange: (v) => (S.paintMode = v) });
        modeRail.append(
          U.group('Photo', sourcePicker('A')),
          U.group('Damage', dmg.el, h('div.btn-row', null,
            U.button({ icon: 'dice', label: 'New damage', onClick: () => { S.seed++; reset(); } }),
            U.button({ icon: 'reset', label: 'Clear mask', kind: 'ghost', onClick: () => { M.fill(1); spec.render(M); resultDirty = true; } }))),
          U.group('Brush', pm.el, brush.el));
        let dmgPsnr = 0, best = 0;
        function reset() {
          if (!S.A) return;
          const R = D.rng(S.seed * 7919 + 1), clean = S.A;
          damaged = new Float32Array(NN);
          const waves = [];
          const k = S.damage === '3' ? 3 : S.damage === 'screen' ? 1 : 2;
          for (let j = 0; j < k; j++) {
            const rho = 22 + R() * 70, th = R() * Math.PI;
            let u = Math.round(rho * Math.cos(th)), v = Math.round(rho * Math.sin(th));
            if (Math.abs(u) < 4) u += 6; if (Math.abs(v) < 4) v += 6;
            waves.push({ u, v, a: 0.12 + R() * 0.07, p: R() * 6.28 });
          }
          const f = 2 * Math.PI / N, sf = 32 + ((R() * 3) | 0) * 4, sa = R() * 0.6;
          for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const i = y * N + x;
            let s = clean[i];
            for (const w of waves) s += w.a * Math.cos(f * (w.u * x + w.v * y) + w.p);
            if (S.damage === 'screen') {
              const xr = x * Math.cos(sa) - y * Math.sin(sa), yr = x * Math.sin(sa) + y * Math.cos(sa);
              const dot = Math.cos(f * sf * xr) * Math.cos(f * sf * yr) > 0.25 ? 1 : 0;
              s = s * (1 - 0.32 * dot) + 0.04;
            }
            damaged[i] = s;
          }
          I.draw(imgCv, damaged, N, N, { min: 0, max: 1 });
          I.draw(target, clean, N, N, { min: 0, max: 1 });
          F = fwd(damaged);
          grating.set(F, 10, -6);
          M.fill(1);
          spec.setSpectrum(logMag(F));
          spec.render(M);
          dmgPsnr = psnr(damaged, clean);
          sD.set(dmgPsnr.toFixed(1));
          best = 0;
          resultDirty = true;
        }
        onSource = reset;
        if (S.A) reset();
        modeTick = ctx.frame(() => {
          spec.draw();
          if (resultDirty && F) {
            resultDirty = false;
            result = filtered(F, M);
            I.draw(resultCv, result, N, N, { min: 0, max: 1 });
            const err = new Float32Array(NN);
            for (let i = 0; i < NN; i++) err[i] = Math.abs(D.clamp(result[i], 0, 1) - S.A[i]) * 4;
            I.draw(errCv, err, N, N, { min: 0, max: 1, cmap: 'ember' });
            const p = psnr(result, S.A);
            let cut = 0;
            for (let i = 0; i < NN; i++) cut += 1 - M[i];
            sP.set(p.toFixed(1), `${p - dmgPsnr >= 0 ? '+' : ''}${(p - dmgPsnr).toFixed(1)} dB`, (p - 12) / 26);
            sP.color(p > 28 ? 'var(--good)' : p > 20 ? 'var(--warn)' : 'var(--bad)');
            sR.set(((cut / NN) * 100).toFixed(2));
            best = Math.max(best, p);
            if (p >= Math.max(26, dmgPsnr + 9) && cut > 0) ctx.discover('notch');
          }
        });
      }

      /* ===== SCULPT ===== */
      function buildSculpt() {
        spec = SpecView({ paint: brushAt, radius: () => S.brush, onHover });
        grating = GratingView();
        const kCv = U.canvas(64, 64, { cls: 'dr-sq', pixel: true }), prof = h('canvas.dr-prof');
        stage.append(
          h('div.dr-grid3', null,
            card('Image', imgCv),
            specCard('Spectrum × mask H', spec.cv),
            card('Filtered', resultCv)),
          h('div.dr-grid3.dr-sub', null,
            card('Wave under cursor', grating.cv, grating.tags),
            card('Kernel h = F⁻¹{H}', kCv),
            card('Kernel profile', prof)));
        const sE = U.stat('Detail kept', '%', { bar: true }), sW = U.stat('Kernel', 'px');
        stats.append(sE.el, sW.el);
        const r1 = U.slider({ label: 'Radius', min: 2, max: 128, step: 1, value: S.r1, onInput: (v) => { S.r1 = v; rebuild(); if (S.preset === 'ideal' && v <= 30) ctx.discover('ringing'); } });
        const r2 = U.slider({ label: 'Outer radius', min: 4, max: 128, step: 1, value: S.r2, onInput: (v) => { S.r2 = v; rebuild(); } });
        const ang = U.slider({ label: 'Wedge angle', min: 0, max: 180, step: 1, value: S.ang, unit: '°', onInput: (v) => { S.ang = v; rebuild(); if (S.preset === 'wedge') ctx.discover('orient'); } });
        const wid = U.slider({ label: 'Wedge width', min: 3, max: 90, step: 1, value: S.wid, unit: '°', onInput: (v) => { S.wid = v; rebuild(); } });
        const inv = U.toggle({ label: 'Invert H', value: S.invert, onChange: (v) => { S.invert = v; rebuild(); } });
        const brush = U.slider({ label: 'Brush', min: 1, max: 20, step: 0.5, value: S.brush, onInput: (v) => (S.brush = v) });
        const pm = U.seg({ label: 'Paint', options: [['erase', 'Erase'], ['keep', 'Keep']], value: S.paintMode, onChange: (v) => (S.paintMode = v) });
        const showFor = () => {
          r2.el.style.display = S.preset === 'band' ? '' : 'none';
          ang.el.style.display = wid.el.style.display = S.preset === 'wedge' ? '' : 'none';
          r1.el.style.display = S.preset === 'wedge' ? 'none' : '';
        };
        const preset = U.seg({
          options: [['ideal', 'Ideal LP'], ['gauss', 'Gauss LP'], ['hp', 'High-pass'], ['band', 'Band'], ['wedge', 'Wedge']], value: S.preset, wrap: true,
          onChange: (v) => {
            S.preset = v; S.presetsSeen.add(v); showFor(); rebuild();
            if (S.presetsSeen.size >= 2) ctx.discover('convthm');
            if (v === 'ideal' && S.r1 <= 30) ctx.discover('ringing');
          },
        });
        S.presetsSeen.add(S.preset);
        modeRail.append(U.group('Photo', sourcePicker('A')), U.group('Mask H(u,v)', preset.el, r1.el, r2.el, ang.el, wid.el, inv.el), U.group('Paint the mask', pm.el, brush.el));
        showFor();
        function rebuild() {
          const sg = S.r1 * 0.6;
          for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const u = x - C, v = y - C, r = Math.hypot(u, v);
            let m;
            switch (S.preset) {
              case 'gauss': m = Math.exp((-r * r) / (2 * sg * sg)); break;
              case 'hp': m = 1 - Math.exp((-r * r) / (2 * sg * sg)); break;
              case 'band': m = D.clamp(r - S.r1 + 0.5, 0, 1) * D.clamp(S.r2 + 0.5 - r, 0, 1); break;
              case 'wedge': {
                let a = (Math.atan2(-v, u) * 180) / Math.PI; a = ((a % 180) + 180) % 180;
                const dd = Math.min(Math.abs(a - S.ang), 180 - Math.abs(a - S.ang));
                m = r < 1.5 ? 1 : D.clamp(S.wid + 0.5 - dd, 0, 1);
                break;
              }
              default: m = r <= S.r1 ? 1 : 0;
            }
            M[y * N + x] = S.invert ? 1 - m : m;
          }
          spec.render(M);
          resultDirty = true;
        }
        function load() { F = fwd(S.A); grating.set(F, 10, -6); I.draw(imgCv, S.A, N, N, { min: 0, max: 1 }); spec.setSpectrum(logMag(F)); rebuild(); }
        onSource = load;
        if (S.A) load();
        modeTick = ctx.frame(() => {
          spec.draw();
          if (resultDirty && F) {
            resultDirty = false;
            result = filtered(F, M);
            const dcKept = M[C * N + C] > 0.5;
            I.draw(resultCv, result, N, N, dcKept ? { min: 0, max: 1 } : { auto: 'pct' });
            // kernel = F⁻¹{H}
            const re = D.shift2(M, N, N), kr = new Float64Array(NN), ki = new Float64Array(NN);
            kr.set(re);
            D.fft2(kr, ki, N, N, true);
            const kc = D.shift2(kr, N, N), crop = new Float32Array(64 * 64);
            let mx = 0;
            for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
              const v = kc[(y + C - 32) * N + (x + C - 32)];
              crop[y * 64 + x] = Math.sign(v) * Math.sqrt(Math.abs(v));
              mx = Math.max(mx, Math.abs(crop[y * 64 + x]));
            }
            I.draw(kCv, crop, 64, 64, { cmap: 'signed', min: -mx, max: mx });
            const row = [];
            for (let x = C - 40; x < C + 40; x++) row.push(kc[C * N + x]);
            plotProfile(prof, row, '#4de1ff');
            // effective kernel width: radius holding 90% of |h|
            let tot = 0, acc = 0;
            for (let i = 0; i < NN; i++) tot += Math.abs(kc[i]);
            let rad = 0;
            for (rad = 0; rad < C; rad++) {
              acc = 0;
              for (let y = C - rad; y <= C + rad; y++) for (let x = C - rad; x <= C + rad; x++) acc += Math.abs(kc[y * N + x]);
              if (acc >= 0.9 * tot) break;
              if (rad > 24) { rad = '>24'; break; }
            }
            sW.set(typeof rad === 'number' ? 2 * rad + 1 : rad);
            let eK = 0, eT = 0;
            for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
              if (x === 0 && y === 0) continue;
              const i = y * N + x, p = F.re[i] ** 2 + F.im[i] ** 2, m = M[((y + C) % N) * N + ((x + C) % N)];
              eT += p; eK += p * m * m;
            }
            sE.set(((100 * eK) / eT).toFixed(1), null, eK / eT);
          }
        });
      }

      /* ===== SWAP ===== */
      function buildSwap() {
        const cvs = {};
        const L = [['A', 'A'], ['B', 'B'], ['ab', '|A| · e^{j∠B}'], ['ba', '|B| · e^{j∠A}'], ['ph', 'Phase of A only'], ['mg', 'Magnitude of A only']];
        for (const [k] of L) cvs[k] = U.canvas(N, N, { cls: 'dr-sq' });
        stage.append(
          h('div.dr-grid3', null, card('A', cvs.A), card('B', cvs.B), card('|A| · ∠B', cvs.ab)),
          h('div.dr-grid3', null, card('|B| · ∠A', cvs.ba), card('∠A only (|F| = 1)', cvs.ph), card('|A| only (phase = 0)', cvs.mg)));
        const sC = U.stat('Looks like', '', {}), sR = U.stat('corr(·, phase src)', '');
        stats.append(sC.el, sR.el);
        modeRail.append(U.group('Image A', sourcePicker('A')), U.group('Image B', sourcePicker('B')));
        let interacted = false, ready = !!(S.A && S.B);
        function corr(a, b) {
          let ma = 0, mb = 0;
          for (let i = 0; i < NN; i++) { ma += a[i]; mb += b[i]; }
          ma /= NN; mb /= NN;
          let s = 0, sa = 0, sb = 0;
          for (let i = 0; i < NN; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; }
          return s / Math.sqrt(sa * sb + 1e-12);
        }
        function go() {
          if (!S.A || !S.B) return;
          const FA = fwd(S.A), FB = fwd(S.B);
          I.draw(cvs.A, S.A, N, N, { min: 0, max: 1 });
          I.draw(cvs.B, S.B, N, N, { min: 0, max: 1 });
          const ab = combine(FA, FB), ba = combine(FB, FA);
          I.draw(cvs.ab, ab, N, N, { auto: 'pct' });
          I.draw(cvs.ba, ba, N, N, { auto: 'pct' });
          I.draw(cvs.ph, combine(null, FA), N, N, { auto: 'pct' });
          I.draw(cvs.mg, combine(FA, null, true), N, N, { auto: 'pct' });
          const cB = corr(ab, S.B), cA = corr(ab, S.A);
          sC.set(cB > cA ? 'B' : 'A', `|A|·∠B ≈ ${cB > cA ? 'B (phase)' : 'A (magnitude)'}`);
          sR.set(cB.toFixed(2), `vs mag src ${cA.toFixed(2)}`);
          if (interacted) ctx.discover('phase');
        }
        onSource = () => { if (ready) interacted = true; ready = !!(S.A && S.B); go(); };
        go();
        // having chosen this mode and looked at it for a moment counts as the experiment
        ctx.timeout(() => { if (S.mode === 'swap') { interacted = true; ctx.discover('phase'); } }, 3500);
      }

      /* ===== HYBRID ===== */
      function buildHybrid() {
        const lowCv = U.canvas(N, N, { cls: 'dr-sq' }), highCv = U.canvas(N, N, { cls: 'dr-sq' }), hybCv = U.canvas(N, N, { cls: 'dr-sq' });
        const distCv = h('canvas.dr-dist'), pyr = h('canvas.dr-pyr');
        stage.append(
          h('div.dr-grid3', null, card('A → low-pass', lowCv), card('B → high-pass', highCv), card('Hybrid = low(A) + high(B)', hybCv)),
          h('div.dr-hyb', null, card('Seen from distance', distCv), card('Stepping back', pyr)));
        const sA = U.stat('You see', '', { bar: true });
        stats.append(sA.el);
        const c1 = U.slider({ label: 'A cutoff σ', min: 3, max: 40, step: 1, value: S.c1, unit: 'cyc', onInput: (v) => { S.c1 = v; compute(); } });
        const c2 = U.slider({ label: 'B cutoff σ', min: 6, max: 80, step: 1, value: S.c2, unit: 'cyc', onInput: (v) => { S.c2 = v; compute(); } });
        const dist = U.slider({ label: 'Viewing distance', min: 1, max: 8, step: 0.1, value: S.dist, unit: '×', onInput: (v) => { S.dist = v; view(true); } });
        modeRail.append(U.group('Coarse image A', sourcePicker('A')), U.group('Fine image B', sourcePicker('B')), U.group('Cutoffs', c1.el, c2.el), U.group('Step back', dist.el));
        let low = null, high = null, hyb = null, wasB = null;
        function compute() {
          if (!S.A || !S.B) return;
          const FA = fwd(S.A), FB = fwd(S.B), Ml = new Float32Array(NN), Mh = new Float32Array(NN);
          for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const r2 = (x - C) ** 2 + (y - C) ** 2;
            Ml[y * N + x] = Math.exp(-r2 / (2 * S.c1 * S.c1));
            Mh[y * N + x] = 1 - Math.exp(-r2 / (2 * S.c2 * S.c2));
          }
          low = Float32Array.from(filtered(FA, Ml));
          high = Float32Array.from(filtered(FB, Mh));
          hyb = new Float32Array(NN);
          for (let i = 0; i < NN; i++) hyb[i] = low[i] + high[i] * 1.25;
          I.draw(lowCv, low, N, N, { min: 0, max: 1 });
          I.draw(highCv, high, N, N, { min: -0.35, max: 0.35 });
          I.draw(hybCv, hyb, N, N, { min: 0, max: 1 });
          view(false);
        }
        function gradE(a) {
          let s = 0;
          for (let y = 1; y < N; y++) for (let x = 1; x < N; x++) { const i = y * N + x; s += (a[i] - a[i - 1]) ** 2 + (a[i] - a[i - N]) ** 2; }
          return s;
        }
        const hybOff = document.createElement('canvas');
        function view(user) {
          if (!hyb) return;
          const sig = (S.dist - 1) * 0.85;
          const hb = I.blur(hyb, N, N, sig);
          I.draw(hybOff, hb, N, N, { min: 0, max: 1 });
          // who dominates perceptually? edge energy of each component after the same blur
          const eA = gradE(I.blur(low, N, N, sig)), eB = gradE(I.blur(high, N, N, sig)) * 1.5625;
          const shareB = eB / (eA + eB);
          sA.set(shareB > 0.5 ? 'B' : 'A', `fine B ${(shareB * 100).toFixed(0)}% · coarse A ${(100 - shareB * 100).toFixed(0)}%`, shareB);
          sA.color(shareB > 0.5 ? 'var(--ear)' : 'var(--eye)');
          if (user && wasB === true && shareB < 0.5) ctx.discover('hybrid');
          if (wasB === null || shareB > 0.5) wasB = shareB > 0.5 ? true : wasB;
          drawDist();
        }
        function drawDist() {
          let { ctx: g, w, h: H } = U.fit(distCv);
          g.fillStyle = '#05060a'; g.fillRect(0, 0, w, H);
          const s = Math.min(w, H) / S.dist;
          g.imageSmoothingQuality = 'high';
          g.drawImage(hybOff, (w - s) / 2, (H - s) / 2, s, s);
          ({ ctx: g, w, h: H } = U.fit(pyr));
          g.fillStyle = '#05060a'; g.fillRect(0, 0, w, H);
          const hybFull = document.createElement('canvas');
          I.draw(hybFull, hyb, N, N, { min: 0, max: 1 });
          let x = 10;
          for (const k of [1, 2, 4, 8, 16]) {
            const sz = Math.min(H - 20, w / 2.2) / k;
            g.drawImage(hybFull, x, H - 10 - sz, sz, sz);
            x += sz + 14;
          }
        }
        onSource = compute;
        compute();
        modeTick = ctx.frame(() => {});
        const ro = new ResizeObserver(() => hyb && drawDist());
        ro.observe(distCv);
        ctx.cleanup(() => ro.disconnect());
      }

      buildMode();
    },
  });
})();
