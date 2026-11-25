/* SPECTRA · E3 CT Scanner — projections, sinogram, projection-slice theorem, (filtered) backprojection, dose. */
(function () {
  const SL = window.SL, U = SL.ui, D = SL.dsp, I = SL.img, h = SL.h;
  const N = 128, C = 64, NN = N * N, PAD = 256, RMAX = C - 1;

  /* ---------- Phantoms ---------- */
  const SHEPP = [ // [value, a, b, x0, y0, phi°]  (modified Shepp–Logan, Toft)
    [1, 0.69, 0.92, 0, 0, 0], [-0.8, 0.6624, 0.874, 0, -0.0184, 0], [-0.2, 0.11, 0.31, 0.22, 0, -18], [-0.2, 0.16, 0.41, -0.22, 0, 18],
    [0.1, 0.21, 0.25, 0, 0.35, 0], [0.1, 0.046, 0.046, 0, 0.1, 0], [0.1, 0.046, 0.046, 0, -0.1, 0], [0.1, 0.046, 0.023, -0.08, -0.605, 0],
    [0.1, 0.023, 0.023, 0, -0.606, 0], [0.1, 0.023, 0.046, 0.06, -0.605, 0],
  ];
  const BONE = [
    [0.25, 0.86, 0.62, 0, 0, 0], [-0.2, 0.26, 0.34, -0.36, 0.1, 10], [-0.2, 0.26, 0.34, 0.36, 0.1, -10],
    [0.9, 0.11, 0.11, 0, -0.42, 0], [-0.5, 0.045, 0.045, 0, -0.42, 0],
    [0.75, 0.09, 0.09, -0.7, -0.1, 0], [0.75, 0.09, 0.09, 0.7, -0.1, 0],
    [0.22, 0.07, 0.07, 0.28, 0.25, 0], [0.12, 0.035, 0.035, -0.12, -0.15, 0],
  ];
  function ellipses(list) {
    const f = new Float32Array(NN);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const X = (x + 0.25 + sx * 0.5 - C) / C, Y = -(y + 0.25 + sy * 0.5 - C) / C;
        for (const [v, a, b, x0, y0, ph] of list) {
          const p = (ph * Math.PI) / 180, dx = X - x0, dy = Y - y0;
          const xr = dx * Math.cos(p) + dy * Math.sin(p), yr = -dx * Math.sin(p) + dy * Math.cos(p);
          if ((xr / a) ** 2 + (yr / b) ** 2 <= 1) acc += v;
        }
      }
      f[y * N + x] = Math.max(0, acc / 4);
    }
    return f;
  }
  function textPhantom() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
    g.fillStyle = 'rgb(40,40,40)'; g.beginPath(); g.arc(C, C, 58, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 52px "Space Grotesk", Arial, sans-serif'; g.fillText('CT', C, C - 8);
    g.font = 'bold 15px "JetBrains Mono", monospace'; g.fillText('SPECTRA', C, C + 32);
    const d = g.getImageData(0, 0, N, N).data, f = new Float32Array(NN);
    for (let i = 0; i < NN; i++) f[i] = d[i * 4] / 255;
    return f;
  }
  function drawPhantom() {
    const f = new Float32Array(NN);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x + 0.5 - C, y + 0.5 - C) < 54) f[y * N + x] = 0.15;
    return f;
  }
  function maskCircle(f) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x + 0.5 - C, y + 0.5 - C) > RMAX) f[y * N + x] = 0;
    return f;
  }

  /* ---------- Radon transform & filtered backprojection ---------- */
  function project(f, th, out) {
    const c = Math.cos(th), s = Math.sin(th);
    for (let i = 0; i < N; i++) {
      const si = i - C + 0.5;
      let sum = 0;
      for (let j = 0; j < N; j++) {
        const t = j - C + 0.5;
        const x = C + si * c - t * s - 0.5, y = C + si * s + t * c - 0.5;
        const x0 = Math.floor(x), y0 = Math.floor(y);
        if (x0 < 0 || y0 < 0 || x0 >= N - 1 || y0 >= N - 1) continue;
        const fx = x - x0, fy = y - y0, k = y0 * N + x0;
        sum += (f[k] * (1 - fx) + f[k + 1] * fx) * (1 - fy) + (f[k + N] * (1 - fx) + f[k + N + 1] * fx) * fy;
      }
      out[i] = sum;
    }
    return out;
  }
  const filterCache = {};
  function rampFilter(type) {
    if (type === 'none') return null;
    if (filterCache[type]) return filterCache[type];
    const re = new Float64Array(PAD), im = new Float64Array(PAD);
    re[0] = 0.25;
    for (let n = 1; n < PAD / 2; n++) { const v = n % 2 ? -1 / (Math.PI * Math.PI * n * n) : 0; re[n] = v; re[PAD - n] = v; }
    D.fft(re, im);
    const H = new Float64Array(PAD);
    for (let k = 0; k < PAD; k++) {
      const fk = Math.min(k, PAD - k) / (PAD / 2);
      let w = 1;
      if (type === 'shepp') w = fk ? Math.sin((Math.PI * fk) / 2) / ((Math.PI * fk) / 2) : 1;
      if (type === 'hann') w = 0.5 + 0.5 * Math.cos(Math.PI * fk);
      H[k] = re[k] * w;
    }
    return (filterCache[type] = H);
  }
  function applyFilter(p, H) {
    if (!H) return p;
    const re = new Float64Array(PAD), im = new Float64Array(PAD);
    for (let i = 0; i < N; i++) re[i] = p[i];
    D.fft(re, im);
    for (let k = 0; k < PAD; k++) { re[k] *= H[k]; im[k] *= H[k]; }
    D.fft(re, im, true);
    const q = new Float32Array(N);
    for (let i = 0; i < N; i++) q[i] = re[i];
    return q;
  }
  function backproject(rec, q, th, scale) {
    const c = Math.cos(th), s = Math.sin(th);
    for (let y = 0; y < N; y++) {
      const yy = y + 0.5 - C;
      for (let x = 0; x < N; x++) {
        const xx = x + 0.5 - C;
        if (xx * xx + yy * yy > RMAX * RMAX) continue;
        const sv = xx * c + yy * s + C - 0.5, i0 = Math.floor(sv), f = sv - i0;
        const a = i0 >= 0 && i0 < N ? q[i0] : 0, b = i0 + 1 >= 0 && i0 + 1 < N ? q[i0 + 1] : 0;
        rec[y * N + x] += (a + (b - a) * f) * scale;
      }
    }
  }

  const fmtN = (v) => (v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k' : Math.round(v) + '');

  /* =================================================================== */
  (SL.lab || ((d) => (SL.labs = SL.labs || []).push(d)))({
    id: 'ct',
    side: 'eye',
    code: 'E3',
    title: 'CT Scanner',
    tagline: 'See inside with nothing but shadows.',
    syllabus: ['VIP M2 §4, §11', 'VIP M1 §5'],
    concepts: [
      { key: 'sinogram', label: 'Sinogram', line: 'A single point at (x, y) lands on detector s = x·cosθ + y·sinθ, so in the sinogram every point traces its own sinusoid.', hint: 'Hover the phantom after a scan', math: ['sampling', 'fourier'] },
      { key: 'projslice', label: 'Projection-slice', line: 'The 1-D Fourier transform of a projection at angle θ equals the line through the 2-D spectrum at the same angle: the two curves overlap.', hint: 'Hover the 2-D spectrum', math: ['fourier'] },
      { key: 'blur', label: 'Backprojection blurs', line: 'Smearing projections back without filtering gives the true image convolved with 1/r: radial lines oversample the spectrum centre by 1/|ρ|.', hint: 'Set the filter to none', math: ['filter', 'sampling'] },
      { key: 'ramp', label: 'Ramp filter', line: 'Multiplying each projection’s spectrum by |ρ| undoes the 1/|ρ| oversampling, so filtered backprojection is sharp.', hint: 'Go from no filter to a ramp', math: ['filter', 'fourier'] },
      { key: 'streaks', label: 'Too few views', line: 'With few angles the spectrum is sampled by sparse spokes; the gaps between them alias into streaks radiating from edges.', hint: 'Scan with ≤ 30 views', math: ['sampling'] },
      { key: 'limited', label: 'Missing wedge', line: 'If the gantry cannot rotate through 180°, a wedge of the spectrum is never measured and edges along those directions vanish.', hint: 'Shrink the angular coverage', math: ['sampling', 'fourier'] },
      { key: 'noise', label: 'Dose vs noise', line: 'Fewer photons mean Poisson noise on every ray; the ramp filter boosts high frequencies, so low-dose scans come out grainy.', hint: 'Scan at very low dose', math: ['noise', 'filter'] },
    ],

    thumb(g, w, H, t) {
      const cx = w * 0.3, cy = H / 2, R = H * 0.34, th = t * 0.8;
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
      g.beginPath(); g.arc(cx, cy, R * 1.25, 0, 7); g.stroke();
      g.fillStyle = 'rgba(200,220,240,.25)'; g.beginPath(); g.ellipse(cx, cy, R * 0.6, R * 0.8, 0, 0, 7); g.fill();
      g.fillStyle = 'rgba(77,225,255,.6)'; g.beginPath(); g.arc(cx + R * 0.25, cy - R * 0.2, R * 0.16, 0, 7); g.fill();
      const c = Math.cos(th), s = Math.sin(th);
      for (let k = -5; k <= 5; k++) {
        const o = (k / 5) * R;
        g.strokeStyle = `rgba(77,225,255,${0.12 + 0.1 * (5 - Math.abs(k)) / 5})`;
        g.beginPath(); g.moveTo(cx + o * c + s * R * 1.25, cy + o * s - c * R * 1.25); g.lineTo(cx + o * c - s * R * 1.25, cy + o * s + c * R * 1.25); g.stroke();
      }
      // sinogram trace
      const x0 = w * 0.58, x1 = w * 0.94;
      g.fillStyle = 'rgba(255,255,255,.03)'; g.fillRect(x0, H * 0.1, x1 - x0, H * 0.8);
      const prog = (th % (Math.PI * 2)) / (Math.PI * 2);
      g.strokeStyle = '#4de1ff'; g.lineWidth = 2; g.beginPath();
      for (let i = 0; i <= 60 * prog; i++) {
        const a = (i / 60) * Math.PI * 2, y = H * 0.1 + (i / 60) * H * 0.8;
        const x = (x0 + x1) / 2 + Math.cos(a - 0.7) * (x1 - x0) * 0.3;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    },

    build(ctx) {
      const { stage, rail } = ctx;
      const S = { preset: 'shepp', K: 180, cov: 180, filter: 'ramlak', dose: 1e5, speed: 2, brush: 6, dens: 0.8, scanning: true, userScan: false };
      let phantom = null, Fmag = null, maxP = 1, win = [0, 0.5];
      let sino = null, rec = null, done = 0, acc = 0, lastProj = new Float32Array(N), hoverPt = null, sliceAngle = null, psMoves = 0;
      let recDirty = true, sinoDirty = true, statTick = 0;
      const offPh = document.createElement('canvas'), offSino = document.createElement('canvas'), offRec = document.createElement('canvas'), offF = document.createElement('canvas');
      const offK = document.createElement('canvas');
      offK.width = offK.height = 256;

      /* ----- stage ----- */
      const gantry = h('canvas.ct-sq'), sinoCv = h('canvas.ct-sq'), recCv = h('canvas.ct-sq');
      const phCv = h('canvas.ct-sq.ct-paint'), fCv = h('canvas.ct-sq'), plotCv = h('canvas.ct-sq'), kCv = h('canvas.ct-sq');
      stage.append(
        h('div.ct-top', null,
          U.card('Gantry', gantry),
          U.card('Sinogram  s → · θ ↓', sinoCv),
          U.card('Reconstruction', recCv)),
        h('div.ct-bot', null,
          U.card('Phantom · draw', phCv),
          U.card('2-D spectrum · slice θ', fCv),
          U.card('Projection ↔ slice', plotCv, h('div.legend.ct-leg', null, h('span', null, h('i', { style: { background: 'var(--eye)' } }), 'slice of 2-D FFT'), h('span', null, h('i', { style: { background: 'var(--ear)' } }), 'FFT of projection'))),
          U.card('k-space coverage', kCv)));

      /* ----- rail ----- */
      const sViews = U.stat('Views', ''), sPsnr = U.stat('PSNR', 'dB', { bar: true }), sDose = U.stat('Photons', ''), sRmse = U.stat('Error', '%');
      const preset = U.seg({ options: [['shepp', 'Shepp–Logan'], ['bone', 'Bone + tumour'], ['text', 'Text'], ['draw', 'Draw']], value: S.preset, wrap: true, onChange: (v) => { S.preset = v; loadPhantom(); restart(); } });
      const dens = U.slider({ label: 'Brush density', min: 0, max: 1, step: 0.05, value: S.dens, onInput: (v) => (S.dens = v) });
      const brush = U.slider({ label: 'Brush size', min: 1, max: 16, step: 0.5, value: S.brush, unit: 'px', onInput: (v) => (S.brush = v) });
      const views = U.slider({ label: 'Views', min: 8, max: 360, step: 1, value: S.K, log: true, fmt: (v) => Math.round(v), onInput: (v) => { S.K = Math.round(v); restart(); } });
      const cov = U.slider({ label: 'Angular coverage', min: 30, max: 180, step: 5, value: S.cov, unit: '°', onInput: (v) => { S.cov = v; restart(); } });
      const dose = U.slider({ label: 'Photons per ray', min: 30, max: 1e6, step: 1, value: S.dose, log: true, fmt: fmtN, onInput: (v) => { S.dose = v; restart(); } });
      const filt = U.seg({
        label: 'Filter', options: [['none', 'None'], ['ramlak', 'Ram-Lak'], ['shepp', 'Shepp-L'], ['hann', 'Hann']], value: S.filter,
        onChange: (v) => {
          const prev = S.filter;
          S.filter = v; rebuildRec();
          if (done >= S.K * 0.9) {
            if (v === 'none') ctx.discover('blur');
            if (prev === 'none' && v !== 'none') ctx.discover('ramp');
          }
        },
      });
      const speed = U.slider({ label: 'Speed', min: 0.25, max: 12, step: 0.25, value: S.speed, unit: 'views/frame', onInput: (v) => (S.speed = v) });
      const bScan = U.button({ icon: 'stop', label: 'Pause', kind: 'primary', onClick: () => { if (done >= S.K) { restart(); return; } S.scanning = !S.scanning; S.userScan = true; paintScan(); } });
      const paintScan = () => {
        bScan.innerHTML = '';
        const lab = done >= S.K ? 'Rescan' : S.scanning ? 'Pause' : 'Scan';
        bScan.append(U.icon(done >= S.K ? 'reset' : S.scanning ? 'stop' : 'play', 16), h('span', null, lab));
      };
      rail.append(
        U.group('Scan', h('div.btn-row', null, bScan,
          U.button({ icon: 'spark', label: 'Instant', onClick: () => { S.userScan = true; while (done < S.K) acquire(); finish(); } }),
          U.button({ icon: 'reset', kind: 'ghost', title: 'Reset', onClick: () => restart() })), speed.el),
        U.group('Acquisition', views.el, cov.el, dose.el),
        U.group('Reconstruction', filt.el),
        U.group('Phantom', preset.el, brush.el, dens.el),
        U.group('Readout', h('div.stat-grid', null, sViews.el, sPsnr.el, sDose.el, sRmse.el)));

      /* ----- phantom ----- */
      function loadPhantom() {
        phantom = maskCircle(S.preset === 'shepp' ? ellipses(SHEPP) : S.preset === 'bone' ? ellipses(BONE) : S.preset === 'text' ? textPhantom() : drawPhantom());
        phantomChanged();
      }
      function phantomChanged() {
        let mx = 0;
        for (let i = 0; i < NN; i++) mx = Math.max(mx, phantom[i]);
        win = S.preset === 'shepp' ? [0, 0.5] : [0, Math.max(0.3, mx)];
        I.draw(offPh, phantom, N, N, { min: win[0], max: win[1] });
        // 2-D spectrum (log magnitude, DC centred)
        const re = new Float64Array(NN), im = new Float64Array(NN);
        re.set(phantom);
        D.fft2(re, im, N, N);
        const m = new Float32Array(NN);
        for (let i = 0; i < NN; i++) m[i] = Math.log10(1e-3 + Math.hypot(re[i], im[i]));
        Fmag = D.shift2(m, N, N);
        const srt = Float32Array.from(Fmag).sort();
        I.draw(offF, Fmag, N, N, { cmap: 'magma', min: srt[Math.floor(NN * 0.4)], max: srt[NN - 1] });
        maxP = 1e-6;
        const tmp = new Float32Array(N);
        for (let a = 0; a < 8; a++) { project(phantom, (a * Math.PI) / 8, tmp); for (const v of tmp) maxP = Math.max(maxP, v); }
      }

      /* ----- scan engine ----- */
      const angle = (k) => ((k * S.cov) / S.K) * (Math.PI / 180);
      function restart() {
        sino = new Float32Array(S.K * N);
        rec = new Float32Array(NN);
        done = 0; acc = 0;
        offSino.width = N; offSino.height = S.K;
        const g = offSino.getContext('2d');
        g.fillStyle = '#04060b'; g.fillRect(0, 0, N, S.K);
        const k = offK.getContext('2d');
        k.globalCompositeOperation = 'source-over';
        k.fillStyle = '#000'; k.fillRect(0, 0, 256, 256);
        S.scanning = true;
        recDirty = sinoDirty = true;
        paintScan();
      }
      function acquire() {
        const k = done, th = angle(k), p = project(phantom, th, new Float32Array(N));
        const att = 3.2 / maxP, I0 = S.dose;
        for (let i = 0; i < N; i++) {
          const counts = D.poisson(I0 * Math.exp(-att * p[i]));
          p[i] = -Math.log(Math.max(counts, 0.5) / I0) / att;
        }
        sino.set(p, k * N);
        lastProj = p;
        backproject(rec, applyFilter(p, rampFilter(S.filter)), th, (S.cov * Math.PI) / 180 / S.K);
        // sinogram row
        const g = offSino.getContext('2d'), row = g.createImageData(N, 1), lut = I.lut('ice');
        for (let i = 0; i < N; i++) {
          const t = Math.max(0, Math.min(255, ((p[i] / (maxP * 1.05)) * 255) | 0)) * 3;
          row.data[i * 4] = lut[t]; row.data[i * 4 + 1] = lut[t + 1]; row.data[i * 4 + 2] = lut[t + 2]; row.data[i * 4 + 3] = 255;
        }
        g.putImageData(row, 0, k);
        // k-space spoke
        const kc = offK.getContext('2d');
        kc.globalCompositeOperation = 'lighter';
        kc.strokeStyle = `rgba(77,225,255,${Math.min(0.9, 24 / S.K + 0.1)})`; kc.lineWidth = 1.4;
        kc.beginPath(); kc.moveTo(128 - Math.cos(th) * 128, 128 - Math.sin(th) * 128); kc.lineTo(128 + Math.cos(th) * 128, 128 + Math.sin(th) * 128); kc.stroke();
        done++;
        recDirty = sinoDirty = true;
      }
      function rebuildRec() {
        rec = new Float32Array(NN);
        const H = rampFilter(S.filter);
        for (let k = 0; k < done; k++) backproject(rec, applyFilter(sino.subarray(k * N, k * N + N), H), angle(k), (S.cov * Math.PI) / 180 / S.K);
        recDirty = true;
        updateStats();
      }
      function finish() {
        S.scanning = false;
        paintScan();
        updateStats();
        if (!S.userScan) return;
        if (S.K <= 30 && S.filter !== 'none') ctx.discover('streaks');
        if (S.cov <= 120) ctx.discover('limited');
        if (S.dose <= 3000 && S.filter !== 'none') ctx.discover('noise');
        if (S.filter === 'none') ctx.discover('blur');
      }
      function updateStats() {
        sViews.set(`${done}/${S.K}`, `${S.cov}° · Δθ ${(S.cov / S.K).toFixed(2)}°`);
        sDose.set(fmtN(S.dose * N * done), `${fmtN(S.dose)} / ray`);
        if (!done) { sPsnr.set('—', '', 0); sRmse.set('—'); return; }
        // least-squares fit a·rec + b → phantom inside the field of view
        let n = 0, sr = 0, sf = 0, srr = 0, srf = 0, fmin = Infinity, fmax = -Infinity;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          if (Math.hypot(x + 0.5 - C, y + 0.5 - C) > RMAX - 2) continue;
          const i = y * N + x, r = rec[i], f = phantom[i];
          n++; sr += r; sf += f; srr += r * r; srf += r * f;
          if (f < fmin) fmin = f; if (f > fmax) fmax = f;
        }
        const a = (n * srf - sr * sf) / (n * srr - sr * sr || 1e-12), b = (sf - a * sr) / n;
        let e = 0;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          if (Math.hypot(x + 0.5 - C, y + 0.5 - C) > RMAX - 2) continue;
          const i = y * N + x;
          e += (a * rec[i] + b - phantom[i]) ** 2;
        }
        const mse = e / n, range = fmax - fmin || 1, p = 10 * Math.log10((range * range) / (mse + 1e-12));
        sPsnr.set(p.toFixed(1), S.filter === 'none' ? 'unfiltered BP' : 'filtered BP', (p - 10) / 25);
        sPsnr.color(p > 24 ? 'var(--good)' : p > 17 ? 'var(--warn)' : 'var(--bad)');
        sRmse.set(((Math.sqrt(mse) / range) * 100).toFixed(1));
      }

      /* ----- interaction ----- */
      let painting = false;
      U.pointer(phCv, (p) => {
        const x = p.u * N, y = p.v * N;
        if (p.type === 'leave') { hoverPt = null; return; }
        hoverPt = { x, y };
        if (p.down) {
          painting = true;
          const r = S.brush;
          for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(N - 1, Math.ceil(y + r)); yy++)
            for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(N - 1, Math.ceil(x + r)); xx++) {
              const t = D.clamp(r + 0.5 - Math.hypot(xx + 0.5 - x, yy + 0.5 - y), 0, 1);
              if (t > 0 && Math.hypot(xx + 0.5 - C, yy + 0.5 - C) <= RMAX) phantom[yy * N + xx] = phantom[yy * N + xx] * (1 - t) + S.dens * t;
            }
          I.draw(offPh, phantom, N, N, { min: win[0], max: win[1] });
        } else if (done >= S.K * 0.5) ctx.discover('sinogram');
        if (p.type === 'up' && painting) { painting = false; phantomChanged(); S.userScan = true; restart(); }
      });
      U.pointer(fCv, (p) => {
        if (p.type === 'leave') { sliceAngle = null; return; }
        sliceAngle = Math.atan2(p.v - 0.5, p.u - 0.5);
        if (done > 0 && ++psMoves > 12) ctx.discover('projslice');
      });

      /* ----- drawing ----- */
      const th = U.theme();
      function drawGantry(t) {
        const { ctx: g, w } = U.fit(gantry);
        g.clearRect(0, 0, w, w);
        const cx = w / 2, cy = w / 2, R = w * 0.28, sc = (2 * R) / N, off = w * 0.08;
        const k = Math.max(0, done - 1), thv = done ? angle(k) : (t * 0.2) % Math.PI;
        const c = Math.cos(thv), s = Math.sin(thv);
        // gantry ring
        g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = w * 0.06;
        g.beginPath(); g.arc(cx, cy, R + off, 0, 7); g.stroke();
        g.strokeStyle = 'rgba(77,225,255,.25)'; g.lineWidth = 1;
        g.beginPath(); g.arc(cx, cy, R + off - w * 0.03, 0, 7); g.stroke();
        g.beginPath(); g.arc(cx, cy, R + off + w * 0.03, 0, 7); g.stroke();
        // coverage arc
        g.strokeStyle = 'rgba(77,225,255,.7)'; g.lineWidth = 3;
        g.beginPath(); g.arc(cx, cy, R + off + w * 0.03, Math.PI / 2, Math.PI / 2 + (S.cov * Math.PI) / 180 * (done / S.K)); g.stroke();
        // patient
        g.save(); g.beginPath(); g.arc(cx, cy, R, 0, 7); g.clip();
        g.imageSmoothingEnabled = true;
        g.drawImage(offPh, cx - R, cy - R, 2 * R, 2 * R);
        g.restore();
        // rays (parallel beam): along d = (−sinθ, cosθ), offset s along n = (cosθ, sinθ)
        const L = R + off;
        for (let r = 0; r < 25; r++) {
          const i = Math.round((r / 24) * (N - 1)), sv = (i - C + 0.5) * sc;
          const tr = done ? Math.exp((-3.2 * lastProj[i]) / maxP) : 1;
          g.strokeStyle = `rgba(77,225,255,${0.05 + 0.4 * tr})`; g.lineWidth = 1;
          g.beginPath();
          g.moveTo(cx + sv * c + s * L, cy + sv * s - c * L);
          g.lineTo(cx + sv * c - s * L, cy + sv * s + c * L);
          g.stroke();
        }
        // source bar (at −d) and detector bar (at +d)
        const bar = (dist, col, wdt) => {
          g.strokeStyle = col; g.lineWidth = wdt; g.lineCap = 'round';
          g.beginPath();
          g.moveTo(cx - R * c + s * dist, cy - R * s - c * dist);
          g.lineTo(cx + R * c + s * dist, cy + R * s - c * dist);
          g.stroke();
        };
        g.shadowColor = '#4de1ff'; g.shadowBlur = 16;
        bar(L, '#bff6ff', 5);
        g.shadowBlur = 0;
        bar(-L, 'rgba(255,255,255,.35)', 7);
        // projection profile on the detector
        if (done) {
          g.beginPath();
          for (let i = 0; i < N; i++) {
            const sv = (i - C + 0.5) * sc, hgt = (lastProj[i] / maxP) * w * 0.07;
            const x = cx + sv * c - s * (L + 6 + hgt), y = cy + sv * s + c * (L + 6 + hgt);
            i ? g.lineTo(x, y) : g.moveTo(x, y);
          }
          g.strokeStyle = th.ear; g.lineWidth = 1.6; g.stroke();
        }
        g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '600 10px "JetBrains Mono", monospace';
        g.fillText(`θ ${((thv * 180) / Math.PI).toFixed(1)}°`, 10, w - 12);
      }
      function drawSino() {
        const { ctx: g, w, h: H } = U.fit(sinoCv);
        g.imageSmoothingEnabled = false;
        g.drawImage(offSino, 0, 0, w, H);
        if (done < S.K) {
          const y = (done / S.K) * H;
          g.strokeStyle = 'rgba(77,225,255,.8)'; g.lineWidth = 1;
          g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
        }
        if (hoverPt) {
          g.strokeStyle = th.ear; g.lineWidth = 2; g.setLineDash([4, 3]);
          g.beginPath();
          for (let k = 0; k < S.K; k++) {
            const a = angle(k), sv = (hoverPt.x - C) * Math.cos(a) + (hoverPt.y - C) * Math.sin(a);
            const x = ((sv + C) / N) * w, y = ((k + 0.5) / S.K) * H;
            k ? g.lineTo(x, y) : g.moveTo(x, y);
          }
          g.stroke(); g.setLineDash([]);
        }
      }
      function drawRec() {
        if (recDirty) {
          recDirty = false;
          if (S.filter === 'none') I.draw(offRec, rec, N, N, { auto: 'pct' });
          else I.draw(offRec, rec, N, N, { min: win[0], max: win[1] });
        }
        const { ctx: g, w } = U.fit(recCv);
        g.clearRect(0, 0, w, w);
        g.imageSmoothingEnabled = true;
        g.drawImage(offRec, 0, 0, w, w);
        g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '600 10px "JetBrains Mono", monospace';
        g.fillText(S.filter === 'none' ? 'BP' : 'FBP', 10, w - 12);
      }
      function drawPh() {
        const { ctx: g, w } = U.fit(phCv);
        g.clearRect(0, 0, w, w);
        g.drawImage(offPh, 0, 0, w, w);
        g.strokeStyle = 'rgba(255,255,255,.12)'; g.setLineDash([3, 4]);
        g.beginPath(); g.arc(w / 2, w / 2, (RMAX / N) * w, 0, 7); g.stroke(); g.setLineDash([]);
        if (hoverPt) {
          g.strokeStyle = th.ear; g.lineWidth = 1.5;
          g.beginPath(); g.arc((hoverPt.x / N) * w, (hoverPt.y / N) * w, Math.max(3, (S.brush / N) * w), 0, 7); g.stroke();
        }
      }
      function drawSlice() {
        const a = sliceAngle ?? (done ? angle(done - 1) : 0);
        // 2-D spectrum with the slice line
        let { ctx: g, w } = U.fit(fCv);
        g.imageSmoothingEnabled = false;
        g.drawImage(offF, 0, 0, w, w);
        const c = Math.cos(a), s = Math.sin(a);
        g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.shadowColor = th.eye; g.shadowBlur = 8;
        g.beginPath(); g.moveTo(w / 2 - c * w, w / 2 - s * w); g.lineTo(w / 2 + c * w, w / 2 + s * w); g.stroke();
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '600 10px "JetBrains Mono", monospace';
        g.fillText(`θ ${(((a * 180) / Math.PI + 360) % 360).toFixed(0)}°`, 10, w - 12);
        // curves: |FFT(p_θ)| vs 2-D spectrum sampled along the line
        const p = project(phantom, a, new Float32Array(N)), re = new Float64Array(N), im = new Float64Array(N);
        re.set(p);
        D.fft(re, im);
        const one = [], two = [];
        for (let r = 0; r < C; r++) {
          const k = (r + N) % N;
          one.push(Math.log10(1e-3 + Math.hypot(re[k], im[k])));
          const fx = C + r * c, fy = C + r * s, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
          const at = (x, y) => Fmag[D.clamp(y, 0, N - 1) * N + D.clamp(x, 0, N - 1)];
          two.push((at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty);
        }
        let lo = Infinity, hi = -Infinity;
        for (const v of one.concat(two)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        ({ ctx: g, w } = U.fit(plotCv));
        const H = plotCv.getBoundingClientRect().height;
        g.clearRect(0, 0, w, H);
        g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
        for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, (H * i) / 4); g.lineTo(w, (H * i) / 4); g.stroke(); }
        U.line(g, two, 6, w - 6, 26, H - 18, lo, hi, th.eye, 3);
        g.setLineDash([4, 3]);
        U.line(g, one, 6, w - 6, 26, H - 18, lo, hi, th.ear, 1.6);
        g.setLineDash([]);
        g.fillStyle = 'rgba(255,255,255,.4)'; g.font = '500 9px "JetBrains Mono", monospace';
        g.fillText('0', 6, H - 5); g.fillText('ρ →', w - 26, H - 5); g.fillText('log|F|', 6, 38);
      }
      function drawK() {
        const { ctx: g, w } = U.fit(kCv);
        g.fillStyle = '#04060b'; g.fillRect(0, 0, w, w);
        g.drawImage(offK, 0, 0, w, w);
        g.strokeStyle = 'rgba(255,255,255,.14)'; g.setLineDash([2, 4]);
        for (const r of [0.25, 0.5]) { g.beginPath(); g.arc(w / 2, w / 2, r * w, 0, 7); g.stroke(); }
        g.setLineDash([]);
        g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '600 10px "JetBrains Mono", monospace';
        g.fillText(`${done} spokes`, 10, w - 12);
      }

      /* ----- loop ----- */
      ctx.frame((t) => {
        if (!phantom) return;
        if (S.scanning && done < S.K) {
          acc += S.speed;
          let n = 0;
          while (acc >= 1 && done < S.K && n < 24) { acquire(); acc--; n++; }
          if (done >= S.K) finish();
          if (++statTick % 6 === 0) updateStats();
        }
        drawGantry(t); drawSino(); drawRec(); drawPh(); drawSlice(); drawK();
      });

      loadPhantom();
      restart();
      updateStats();
    },
  });
})();
