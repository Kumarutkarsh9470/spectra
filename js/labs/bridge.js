/* SPECTRA — B1 "Modulation Lab": the image-processing toolkit applied to sound, and back.
 * Sound → spectrogram (an image) → 2-D FFT (modulation spectrum) → mask → inverse → Griffin-Lim → sound.
 * Image → spectrogram → sound. Paint → spectrogram → sound.
 */
(function () {
  const SL = window.SL, D = SL.dsp, U = SL.ui, h = SL.h, I = SL.img, A = SL.audio;
  const SR = 16000, NFFT = 512, HOP = 128, B = NFFT / 2 + 1, ROWS = 256; // 256 rows × 31.25 Hz = 0–8 kHz

  /* ---------- chunked (non-blocking) fast Griffin-Lim ---------- */
  function glAsync(mag, T, { iters = 32, phase = null, length, onProgress } = {}) {
    const N = T * B, re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const ph = phase ? phase[i] : Math.random() * 2 * Math.PI;
      re[i] = mag[i] * Math.cos(ph); im[i] = mag[i] * Math.sin(ph);
    }
    const L = length ?? (T - 1) * HOP, S = { re, im, T, B, n: NFFT, hop: HOP, type: 'hann' };
    let pRe = null, pIm = null, it = 0, cancelled = false;
    const promise = new Promise((resolve) => {
      const step = () => {
        if (cancelled) return;
        const t0 = performance.now();
        while (it < iters && performance.now() - t0 < 28) {
          const P = D.stft(D.istft(S, L), NFFT, HOP);
          for (let i = 0; i < N; i++) {
            let ar = P.re[i], ai = P.im[i];
            if (pRe) { const tr = ar + 0.99 * (ar - pRe[i]), ti = ai + 0.99 * (ai - pIm[i]); pRe[i] = ar; pIm[i] = ai; ar = tr; ai = ti; }
            const a = Math.hypot(ar, ai) || 1e-12;
            re[i] = (mag[i] * ar) / a; im[i] = (mag[i] * ai) / a;
          }
          if (!pRe) { pRe = P.re.slice(); pIm = P.im.slice(); }
          it++;
        }
        onProgress && onProgress(iters ? it / iters : 1);
        if (it < iters) setTimeout(step, 0);
        else resolve(D.istft(S, L));
      };
      setTimeout(step, 0);
    });
    return { promise, cancel() { cancelled = true; } };
  }

  /** [t*B + k] layout → display layout [(rows-1-k)*T + t] (low frequency at the bottom). */
  function toDisplay(src, T, stride, rows, f = (v) => v) {
    const out = new Float32Array(T * rows);
    for (let t = 0; t < T; t++) for (let k = 0; k < rows; k++) out[(rows - 1 - k) * T + t] = f(src[t * stride + k]);
    return out;
  }
  function specDb(x) {
    const S = D.stft(x, NFFT, HOP), T = S.T, db = new Float32Array(T * B);
    for (let i = 0; i < db.length; i++) db[i] = 10 * Math.log10(S.re[i] ** 2 + S.im[i] ** 2 + 1e-10);
    return { T, img: toDisplay(db, T, B, ROWS) };
  }
  const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };

  /* ---------- a spectrogram card: pixel canvas + overlay (axes, playhead, cursor) ---------- */
  function specCard(label, cls = '') {
    const cv = U.canvas(10, 10, { cls: 'br-spec ' + cls });
    const ov = h('canvas.br-ov');
    const card = U.card(label, h('div.br-specwrap', null, cv, ov));
    const api = {
      card, cv, ov, T: 0, dur: 0, head: -1, extra: null,
      draw(img, T, opt = {}) {
        api.T = T; api.dur = ((T - 1) * HOP) / SR;
        const mx = opt.max ?? maxOf(img);
        I.draw(cv, img, T, ROWS, { cmap: opt.cmap || 'magma', min: opt.min ?? mx - (opt.range ?? 75), max: mx });
      },
      overlay() {
        const { ctx: g, w, h: H } = U.fit(ov);
        g.clearRect(0, 0, w, H);
        g.font = '500 9.5px "JetBrains Mono", monospace';
        for (const k of [2, 4, 6]) {
          const y = H - (k / 8) * H;
          g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(24, y, w - 24, 1);
          g.fillStyle = 'rgba(255,255,255,.55)'; g.fillText(k + 'k', 4, y + 3);
        }
        if (api.dur) { g.fillStyle = 'rgba(255,255,255,.45)'; g.textAlign = 'right'; g.fillText(api.dur.toFixed(1) + ' s', w - 6, H - 6); g.textAlign = 'left'; }
        if (api.extra) api.extra(g, w, H);
        if (api.head >= 0) {
          const x = api.head * w;
          const grd = g.createLinearGradient(x - 30, 0, x, 0);
          grd.addColorStop(0, 'rgba(185,156,255,0)'); grd.addColorStop(1, 'rgba(185,156,255,.25)');
          g.fillStyle = grd; g.fillRect(x - 30, 0, 30, H);
          g.fillStyle = '#fff'; g.fillRect(x - 0.75, 0, 1.5, H);
        }
      },
    };
    return api;
  }

  SL.lab({
    id: 'bridge', side: 'bridge', code: 'B1',
    title: 'Modulation Lab',
    tagline: 'See a sound. Hear an image.',
    syllabus: ['SAP M1', 'VIP M2'],
    concepts: [
      { key: 'modspec', label: 'Modulation spectrum', math: ['fourier'], hint: 'Filter the modulation plane',
        line: 'A spectrogram is an image, so its 2-D Fourier transform is the modulation spectrum: x = how fast loudness changes, y = how finely the spectrum ripples.' },
      { key: 'syllable', label: 'Syllable rhythm', math: ['filter', 'percept'], hint: 'Temporal low-pass ≤ 8 Hz, listen',
        line: 'Keep only temporal modulations below ~8 Hz (the syllable rate) and speech blurs in time yet stays largely intelligible.' },
      { key: 'spectral', label: 'Pitch is a ripple', math: ['filter', 'fourier'], hint: 'Spectral low-pass, then listen',
        line: 'Harmonics form a fine ripple across frequency; low-pass the spectral modulations and the pitch dissolves into a whispery envelope.' },
      { key: 'phase', label: 'Missing phase', math: ['fourier'], hint: 'Compare both phase modes',
        line: 'A magnitude spectrogram has no phase; Griffin-Lim iterates to a consistent one, but the original phase still sounds cleaner.' },
      { key: 'same2d', label: 'Orientation = glide', math: ['fourier', 'filter'], hint: 'Play a sweep wedge',
        line: 'Rising and falling glides are oriented edges in the spectrogram; a wedge in the 2-D spectrum keeps one, exactly like orientation filtering in images.' },
      { key: 'imgsound', label: 'Pictures are sounds', math: ['fourier', 'percept'], hint: 'Play a picture',
        line: 'Any picture can be a spectrogram: rows become frequencies, columns become time, and the image re-appears when the sound is analysed.' },
      { key: 'drawsound', label: 'Harmonic fusion', math: ['fourier', 'percept'], hint: 'Paint with the harmonic brush',
        line: 'Lines at f, 2f, 3f… fuse into one pitched note: the ear hears a harmonic comb as a single voice, not a chord.' },
    ],
    thumb(g, w, H, t) {
      // a gliding harmonic stack, scanned by a playhead, over a faint 2-D grating
      g.globalAlpha = 0.18;
      for (let x = 0; x < w; x += 6) {
        const v = Math.sin(x * 0.12 + t * 0.8);
        g.fillStyle = `rgba(185,156,255,${0.2 + 0.2 * v})`; g.fillRect(x, 0, 3, H);
      }
      g.globalAlpha = 1;
      const f0 = (x) => 0.07 + 0.03 * Math.sin(x / 60 + t * 0.9);
      for (let m = 1; m <= 7; m++) {
        g.beginPath();
        for (let x = 0; x <= w; x += 3) { const y = H - 8 - m * f0(x) * H * 1.6; x ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.strokeStyle = `hsla(${265 - m * 12}, 90%, ${72 - m * 3}%, ${1 - m * 0.1})`;
        g.lineWidth = 2.2 - m * 0.18; g.shadowColor = '#b99cff'; g.shadowBlur = 8; g.stroke();
      }
      g.shadowBlur = 0;
      const px = ((t * 0.25) % 1) * w;
      g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(px, 0, 1.5, H);
    },

    build(ctx) {
      const th = U.theme();
      let mode = 'm1';
      let playing = null; // {pane, handle, card(s)}
      let glJob = null;
      ctx.cleanup(() => glJob && glJob.cancel());

      /* =================== stage scaffolding =================== */
      const tabs = U.seg({
        options: [['m1', '<b>Sound → Image</b><small>filter the modulation spectrum</small>'], ['m2', '<b>Image → Sound</b><small>play a picture</small>'], ['m3', '<b>Draw a sound</b><small>paint a spectrogram</small>']],
        value: 'm1', onChange: (v) => setMode(v),
      });
      tabs.el.classList.add('br-tabs');
      const pane1 = h('div.br-pane'), pane2 = h('div.br-pane'), pane3 = h('div.br-pane');
      ctx.stage.append(tabs.el, pane1, pane2, pane3);
      const rail1 = h('div.br-rail'), rail2 = h('div.br-rail'), rail3 = h('div.br-rail');
      ctx.rail.append(rail1, rail2, rail3);
      const progBar = () => { const el = h('div.br-prog', null, h('i')); return { el, set(f) { el.firstChild.style.width = f * 100 + '%'; el.classList.toggle('busy', f > 0 && f < 1); } }; };

      function stopPlay() { A.stop(); if (playing) playing.cards.forEach((c) => (c.head = -1)); playing = null; }
      function playOn(x, cards, pane) {
        stopPlay();
        const handle = A.play(x, SR, { onEnd: () => { if (playing && playing.handle === handle) { cards.forEach((c) => (c.head = -1)); playing = null; } } });
        playing = { handle, cards, pane, dur: x.length / SR };
      }

      /* =================== MODE 1 · Sound → Image =================== */
      const m1 = { x: null, S: null, mag: null, T: 0, W: 256, H: ROWS, F: null, mean: 0, paint: null, preset: 'pass', cut: { tlp: 6, thp: 6, slp: 3 },
        out: null, outLog: null, version: 0, cache: {}, phase: 'orig', played: { orig: false, gl: false }, brush: 'off', size: 8, userFiltered: false, zoom: 4 };
      const flow = h('div.br-flow', null, ['STFT', 'log |·|', '2-D FFT', '× mask', '2-D IFFT', 'exp', '+ phase', 'ISTFT'].map((s, i) => h('span', { style: { '--i': i } }, s)));
      const modCv = U.canvas(10, 10, { cls: 'br-mod' });
      const modOv = h('canvas.br-ov');
      const modCard = U.card('2-D FFT of the spectrogram', h('div.br-modwrap', null, modCv, modOv));
      const sIn = specCard('Spectrogram · in'), sOut = specCard('Spectrogram · filtered');
      pane1.append(flow, h('div.br-m1', null, modCard, h('div.br-stack', null, sIn.card, sOut.card)));

      const src = U.audioSource({ sr: SR, maxSec: 4, maxUploadSec: 4, onAudio: (x) => loadSound(x) });
      ctx.cleanup(() => src.stop());
      const presetSeg = U.seg({
        label: 'Mask', wrap: true, value: 'pass',
        options: [['pass', 'All'], ['tlp', 'Slow only'], ['thp', 'Fast only'], ['slp', 'Smooth spectrum'], ['rise', '↗ Rising'], ['fall', '↘ Falling']],
        onChange: (v) => { m1.preset = v; syncCut(); if (v !== 'pass') { m1.userFiltered = true; ctx.discover('modspec'); } applyFilter(); },
      });
      const cutSlider = U.slider({ label: 'Cut-off', min: 0.5, max: 32, log: true, step: 0.25, value: 6, unit: 'Hz',
        onInput: (v) => { if (m1.cut[m1.preset] !== undefined) m1.cut[m1.preset] = v; scheduleFilter(); } });
      function syncCut() {
        const p = m1.preset, show = p === 'tlp' || p === 'thp' || p === 'slp';
        cutSlider.el.style.display = show ? '' : 'none';
        if (!show) return;
        const spectral = p === 'slp';
        const inp = cutSlider.el.querySelector('input');
        // rebuild slider range for the unit in play
        const ns = U.slider({ label: spectral ? 'Cut-off (spectral)' : 'Cut-off (temporal)', min: spectral ? 0.25 : 0.5, max: spectral ? 16 : 32, log: true, step: 0.25,
          value: m1.cut[p], unit: spectral ? 'cyc/kHz' : 'Hz', onInput: (v) => { m1.cut[p] = v; scheduleFilter(); } });
        cutSlider.el.replaceWith(ns.el);
        cutSlider.el = ns.el;
        void inp;
      }
      const brushSeg = U.seg({ label: 'Paint on the plane', value: 'off', options: [['off', 'Off'], ['erase', 'Erase'], ['restore', 'Restore']], onChange: (v) => (m1.brush = v) });
      const zoomSeg = U.seg({ label: 'Temporal zoom', value: 4, options: [[1, '1×'], [2, '2×'], [4, '4×'], [8, '8×']], onChange: (v) => { m1.zoom = v; if (m1.F) drawMod(); } });
      const sizeSlider = U.slider({ label: 'Brush', min: 2, max: 30, step: 1, value: 8, fmt: (v) => v + ' px', onInput: (v) => (m1.size = v) });
      const bReset = U.button({ icon: 'reset', label: 'Clear paint', onClick: () => { if (m1.paint) m1.paint.fill(1); applyFilter(); } });
      const phaseSeg = U.seg({ label: 'Phase', value: 'orig', options: [['orig', 'Original phase'], ['gl', 'Griffin-Lim']], onChange: (v) => (m1.phase = v) });
      const prog1 = progBar();
      const bPlayIn = U.button({ icon: 'play', label: 'Original', onClick: () => m1.x && playOn(m1.x, [sIn], 'm1') });
      const bPlayOut = U.button({ icon: 'play', label: 'Filtered', kind: 'primary', onClick: () => playFiltered() });
      const bStop1 = U.button({ icon: 'stop', title: 'Stop', onClick: stopPlay });
      const sKeep = U.stat('Modulation energy kept', '%', { bar: true }), sGrid = U.stat('Plane', '');
      rail1.append(
        U.group('Sound', src.el),
        U.group('Modulation filter', presetSeg.el, cutSlider.el, zoomSeg.el, brushSeg.el, sizeSlider.el, bReset),
        U.group('Back to sound', phaseSeg.el, h('div.btn-row', null, bPlayIn, bPlayOut, bStop1), prog1.el),
        U.group('', h('div.stat-grid', null, sKeep.el, sGrid.el)),
      );
      syncCut();

      function loadSound(x) {
        stopPlay();
        if (glJob) glJob.cancel();
        const S = D.stft(x, NFFT, HOP), T = S.T, mag = D.stftMag(S);
        const mx = maxOf(mag), eps = mx * 1e-4 + 1e-9;
        const logImg = new Float32Array(T * ROWS);
        for (let t = 0; t < T; t++) for (let k = 0; k < ROWS; k++) logImg[t * ROWS + k] = Math.log(mag[t * B + k] + eps);
        const W = T <= 256 ? 256 : 512, H = ROWS;
        const G = new Float64Array(W * H);
        let mean = 0;
        for (let u = 0; u < W; u++) {
          const tt = (u * (T - 1)) / (W - 1), t0 = Math.floor(tt), t1 = Math.min(T - 1, t0 + 1), f = tt - t0;
          for (let k = 0; k < H; k++) { const v = logImg[t0 * ROWS + k] * (1 - f) + logImg[t1 * ROWS + k] * f; G[k * W + u] = v; mean += v; }
        }
        mean /= W * H;
        for (let i = 0; i < G.length; i++) G[i] -= mean;
        const Fi = new Float64Array(W * H);
        D.fft2(G, Fi, W, H);
        Object.assign(m1, { x, S, mag, T, W, H, F: { re: G, im: Fi }, mean, logImg, eps, paint: new Float32Array(W * H).fill(1) });
        // grid timing: the 2-D FFT's horizontal bin = 1 / (W · Δt_grid) Hz
        m1.dtGrid = ((T - 1) * HOP) / SR / (W - 1);
        m1.ftRes = 1 / (W * m1.dtGrid);
        sGrid.set(`${W}×${H}`, `Δ ${m1.ftRes.toFixed(2)} Hz · 0.125 cyc/kHz`);
        const disp = toDisplay(logImg, T, ROWS, ROWS);
        sIn.draw(disp, T, { range: 9.2 });
        applyFilter();
      }

      function maskAt(u, v) {
        const W = m1.W, H = m1.H;
        const fu = u < W / 2 ? u : u - W, fv = v < H / 2 ? v : v - H;
        if (fu === 0 && fv === 0) return 1;
        const ft = Math.abs(fu) * m1.ftRes, fsm = Math.abs(fv) / 8;
        switch (m1.preset) {
          case 'tlp': return 1 / (1 + Math.pow(ft / m1.cut.tlp, 8));
          case 'thp': return fu === 0 ? 1 : 1 - 1 / (1 + Math.pow(ft / m1.cut.thp, 8));
          case 'slp': return 1 / (1 + Math.pow(fsm / m1.cut.slp, 8));
          case 'rise':
          case 'fall': {
            if (Math.abs(fu) <= 1 || Math.abs(fv) <= 1) return 1;
            const s2 = (2 * fu * fv) / (fu * fu + fv * fv); // sin 2θ
            return 0.5 - 0.5 * Math.tanh(3 * (m1.preset === 'rise' ? s2 : -s2));
          }
          default: return 1;
        }
      }
      let ftm = null;
      function scheduleFilter() { clearTimeout(ftm); ftm = setTimeout(() => ctx.alive && applyFilter(), 50); }
      ctx.cleanup(() => clearTimeout(ftm));
      function applyFilter() {
        if (!m1.F) return;
        const { W, H, T, F } = m1;
        const M = new Float32Array(W * H), re = new Float64Array(W * H), im = new Float64Array(W * H);
        let eAll = 0, eKeep = 0;
        for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
          const i = v * W + u;
          const su = (u + W / 2) % W, sv = (v + H / 2) % H; // shifted coords of this bin
          const m = maskAt(u, v) * m1.paint[sv * W + su];
          M[i] = m;
          re[i] = F.re[i] * m; im[i] = F.im[i] * m;
          if (i) { const p = F.re[i] ** 2 + F.im[i] ** 2; eAll += p; eKeep += p * m * m; }
        }
        m1.M = M;
        D.fft2(re, im, W, H, true);
        const outLog = new Float32Array(T * ROWS);
        for (let t = 0; t < T; t++) {
          const uu = (t * (W - 1)) / (T - 1 || 1), u0 = Math.floor(uu), u1 = Math.min(W - 1, u0 + 1), f = uu - u0;
          for (let k = 0; k < ROWS; k++) outLog[t * ROWS + k] = re[k * W + u0] * (1 - f) + re[k * W + u1] * f + m1.mean;
        }
        m1.outLog = outLog;
        const out = new Float32Array(T * B);
        for (let t = 0; t < T; t++) {
          for (let k = 0; k < ROWS; k++) out[t * B + k] = Math.max(0, Math.exp(outLog[t * ROWS + k]) - m1.eps);
          out[t * B + ROWS] = m1.mag[t * B + ROWS];
        }
        m1.out = out;
        m1.version++;
        m1.cache = {};
        sOut.draw(toDisplay(outLog, T, ROWS, ROWS), T, { range: 9.2, max: maxOf(m1.logImg) });
        sKeep.set((100 * eKeep / (eAll || 1)).toFixed(0), undefined, eKeep / (eAll || 1));
        drawMod();
      }
      const lutA = I.lut('aurora');
      function drawMod() {
        const { W, H, F, M } = m1;
        const cw = Math.max(16, Math.round(W / m1.zoom)), x0 = (W - cw) / 2; // visible shifted columns [x0, x0+cw)
        if (modCv.width !== cw || modCv.height !== H) { modCv.width = cw; modCv.height = H; }
        const g = modCv.getContext('2d'), img = g.createImageData(cw, H), d = img.data;
        const L = new Float32Array(W * H);
        let mx = -Infinity;
        for (let i = 0; i < W * H; i++) { L[i] = Math.log10(F.re[i] ** 2 + F.im[i] ** 2 + 1e-9); if (i && L[i] > mx) mx = L[i]; }
        const mn = mx - 6;
        for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
          const i = v * W + u, su = (u + W / 2) % W, sv = (v + H / 2) % H;
          if (su < x0 || su >= x0 + cw) continue;
          const y = H - 1 - sv, o = (y * cw + su - x0) * 4; // display: +spectral modulation up
          let c = Math.round(D.clamp((L[i] - mn) / (mx - mn), 0, 1) * 255);
          const m = M[i], dim = 0.16 + 0.84 * m;
          const hatch = m < 0.5 && ((su + y) & 7) === 0;
          d[o] = hatch ? 120 : lutA[c * 3] * dim; d[o + 1] = hatch ? 90 : lutA[c * 3 + 1] * dim; d[o + 2] = hatch ? 160 : lutA[c * 3 + 2] * dim; d[o + 3] = 255;
        }
        g.putImageData(img, 0, 0);
      }
      // modulation-plane overlay: axes, ticks, brush cursor
      let cursor = null;
      function drawModOverlay() {
        const { ctx: g, w, h: Hh } = U.fit(modOv);
        g.clearRect(0, 0, w, Hh);
        if (!m1.F) return;
        const cx = w / 2, cy = Hh / 2;
        g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, cy); g.lineTo(w, cy); g.moveTo(cx, 0); g.lineTo(cx, Hh); g.stroke();
        g.font = '500 9.5px "JetBrains Mono", monospace'; g.fillStyle = 'rgba(255,255,255,.6)';
        const ftMax = ((m1.W / 2) * m1.ftRes) / m1.zoom;
        for (const f of [1, 2, 4, 8, 16, 32, 64]) {
          if (f < ftMax / 9) continue;
          if (f > ftMax * 0.95) continue;
          for (const s of [-1, 1]) { const x = cx + (s * f / ftMax) * (w / 2); g.fillRect(x, cy - 3, 1, 6); g.textAlign = 'center'; g.fillText((s * f) + '', x, cy + 14); }
        }
        for (const f of [4, 8, 12]) for (const s of [-1, 1]) { const y = cy - (s * f / 16) * (Hh / 2); g.fillRect(cx - 3, y, 6, 1); g.textAlign = 'left'; g.fillText((s * f) + '', cx + 6, y + 3); }
        const narrow = w < 520;
        g.textAlign = 'right'; g.fillStyle = th.bridge; g.fillText(narrow ? 'Hz →' : 'temporal modulation (Hz) →', w - 8, cy - 8);
        g.textAlign = 'left'; g.fillText(narrow ? '↑ cyc/kHz' : '↑ spectral modulation (cyc/kHz)', cx + 8, 14);
        if (m1.preset === 'tlp' || m1.preset === 'thp') {
          const x = (m1.cut[m1.preset] / ftMax) * (w / 2);
          g.setLineDash([4, 4]); g.strokeStyle = th.warn; g.beginPath(); g.moveTo(cx - x, 0); g.lineTo(cx - x, Hh); g.moveTo(cx + x, 0); g.lineTo(cx + x, Hh); g.stroke(); g.setLineDash([]);
        } else if (m1.preset === 'slp') {
          const y = (m1.cut.slp / 16) * (Hh / 2);
          g.setLineDash([4, 4]); g.strokeStyle = th.warn; g.beginPath(); g.moveTo(0, cy - y); g.lineTo(w, cy - y); g.moveTo(0, cy + y); g.lineTo(w, cy + y); g.stroke(); g.setLineDash([]);
        }
        if (cursor && m1.brush !== 'off') {
          const r = ((m1.size * m1.zoom) / m1.W) * w;
          g.strokeStyle = m1.brush === 'erase' ? th.bad : th.good; g.lineWidth = 1.5;
          g.beginPath(); g.ellipse(cursor.u * w, cursor.v * Hh, r, (m1.size / m1.H) * Hh, 0, 0, 7); g.stroke();
          g.beginPath(); g.ellipse((1 - cursor.u) * w, (1 - cursor.v) * Hh, r, (m1.size / m1.H) * Hh, 0, 0, 7); g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]);
        }
      }
      U.pointer(modOv, (p) => {
        cursor = p.type === 'leave' ? null : p;
        if (!m1.F || m1.brush === 'off') return;
        if ((p.type === 'down' || p.type === 'move') && p.down) {
          const { W, H } = m1, su = W / 2 + (p.u - 0.5) * (W / m1.zoom), sy = p.v * H, sv = H - 1 - sy, r = m1.size;
          const val = m1.brush === 'erase' ? 0 : 1;
          const stamp = (cu, cv) => {
            for (let dv = -r; dv <= r; dv++) for (let du = -r; du <= r; du++) {
              if (du * du + dv * dv > r * r) continue;
              const uu = Math.round(cu + du), vv = Math.round(cv + dv);
              if (uu < 0 || vv < 0 || uu >= W || vv >= H) continue;
              const i = vv * W + uu;
              if (uu === W / 2 && vv === H / 2) continue; // keep DC
              m1.paint[i] = val;
            }
          };
          stamp(su, sv);
          stamp((W - su) % W, (H - sv) % H); // conjugate symmetry keeps the result real
          m1.userFiltered = true;
          scheduleFilter();
        }
        if (p.type === 'up') ctx.discover('modspec');
      });
      modOv.classList.add('paintable');

      async function playFiltered() {
        if (!m1.out) return;
        const key = m1.phase;
        const markPlayed = () => {
          m1.played[key] = true;
          if (m1.played.orig && m1.played.gl) ctx.discover('phase');
          if (m1.preset === 'tlp' && m1.cut.tlp <= 8) ctx.discover('syllable');
          if (m1.preset === 'slp' && m1.cut.slp <= 4) ctx.discover('spectral');
          if (m1.preset === 'rise' || m1.preset === 'fall') ctx.discover('same2d');
        };
        if (m1.cache[key]) { playOn(m1.cache[key], [sOut], 'm1'); markPlayed(); return; }
        if (glJob) glJob.cancel();
        const ver = m1.version;
        let y;
        if (key === 'orig') {
          const { S, out, T } = m1, re = new Float32Array(T * B), im = new Float32Array(T * B);
          for (let i = 0; i < re.length; i++) { const a = Math.hypot(S.re[i], S.im[i]) || 1e-12; re[i] = (out[i] * S.re[i]) / a; im[i] = (out[i] * S.im[i]) / a; }
          y = D.istft({ re, im, T, B, n: NFFT, hop: HOP, type: 'hann' }, m1.x.length);
        } else {
          prog1.set(0.001);
          glJob = glAsync(m1.out, m1.T, { iters: 32, length: m1.x.length, onProgress: (f) => prog1.set(f) });
          y = await glJob.promise;
          glJob = null;
          if (!ctx.alive || ver !== m1.version) return;
        }
        y = D.normalize(y, 0.9);
        m1.cache[key] = y;
        prog1.set(0);
        playOn(y, [sOut], 'm1');
        markPlayed();
      }

      /* =================== MODE 2 · Image → Sound =================== */
      const m2 = { el: null, dur: 3, range: 50, invert: false, iters: 16, img: null, mag: null, T: 0, audio: null, version: 0 };
      const pic = specCard('The picture, read as a spectrogram', 'tall');
      const heard = specCard('What the sound looks like when analysed', 'tall');
      pane2.append(h('div.grid2.br-m2', null, pic.card, heard.card));
      const imgSrc = U.imageSource({ scenes: ['city', 'market', 'text', 'zone'], value: 'text', size: 512, onChange: (s) => { m2.el = s.el; m2.text = null; rebuild2(); } });
      const txt = h('input.br-text', { type: 'text', placeholder: 'type a word…', maxLength: 18, spellcheck: false });
      const bTxt = U.button({ label: 'Aa', title: 'Turn your text into sound', onClick: () => useText() });
      ctx.on(txt, 'keydown', (e) => { if (e.key === 'Enter') useText(); });
      function useText() {
        m2.text = (txt.value || 'HELLO').trim().slice(0, 18) || 'HELLO';
        rebuild2();
      }
      /** Text rendered at exactly the spectrogram's aspect (T × 256) so nothing gets cropped. */
      function textCanvas(s, T) {
        const cv = document.createElement('canvas'), W = T * 2, H = ROWS * 2;
        cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
        let fs = H * 0.62;
        g.font = `800 ${fs}px "Space Grotesk", Arial, sans-serif`;
        while (g.measureText(s).width > W * 0.92 && fs > 20) { fs -= 4; g.font = `800 ${fs}px "Space Grotesk", Arial, sans-serif`; }
        g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s, W / 2, H * 0.53);
        return cv;
      }
      const durS = U.slider({ label: 'Duration', min: 1, max: 6, step: 0.5, value: 3, unit: 's', onInput: (v) => { m2.dur = v; rebuild2(); } });
      const rangeS = U.slider({ label: 'Brightness → loudness range', min: 20, max: 80, step: 5, value: 50, unit: 'dB', onInput: (v) => { m2.range = v; rebuild2(); } });
      const invT = U.toggle({ label: 'Invert (dark = loud)', value: false, onChange: (v) => { m2.invert = v; rebuild2(); } });
      const itSeg = U.seg({ label: 'Phase', value: 16, options: [[0, 'Random'], [16, 'GL ×16'], [48, 'GL ×48']], onChange: (v) => { m2.iters = v; m2.audio = null; } });
      const prog2 = progBar();
      const bPlay2 = U.button({ icon: 'play', label: 'Play the picture', kind: 'primary', onClick: () => play2() });
      const bStop2 = U.button({ icon: 'stop', title: 'Stop', onClick: stopPlay });
      rail2.append(
        U.group('Picture', imgSrc.el, h('div.br-textrow', null, txt, bTxt)),
        U.group('Mapping', durS.el, rangeS.el, invT.el, itSeg.el),
        U.group('Listen', h('div.btn-row', null, bPlay2, bStop2), prog2.el),
      );
      let rb2 = null;
      function rebuild2() {
        clearTimeout(rb2);
        rb2 = setTimeout(() => {
          if (!ctx.alive || (!m2.el && !m2.text)) return;
          const T = Math.round((m2.dur * SR) / HOP) + 1;
          const gray = I.gray(I.grab(m2.text ? textCanvas(m2.text, T) : m2.el, T, ROWS));
          const disp = new Float32Array(T * ROWS), mag = new Float32Array(T * B);
          for (let y = 0; y < ROWS; y++) for (let t = 0; t < T; t++) {
            let g = gray[y * T + t];
            if (m2.invert) g = 1 - g;
            disp[y * T + t] = g;
            mag[t * B + (ROWS - 1 - y)] = g > 0.04 ? Math.pow(10, ((g - 1) * m2.range) / 20) : 0;
          }
          Object.assign(m2, { img: disp, mag, T, audio: null });
          m2.version++;
          pic.draw(disp, T, { min: 0, max: 1, cmap: 'magma' });
          heard.T = 0; heard.dur = 0;
          const hc = heard.cv.getContext('2d'); hc.fillStyle = '#05060a'; hc.fillRect(0, 0, heard.cv.width, heard.cv.height);
          heard.extra = (g, w, H) => { g.fillStyle = 'rgba(255,255,255,.35)'; g.font = '500 11px "JetBrains Mono", monospace'; g.textAlign = 'center'; g.fillText('▶ play to hear it, then see it come back', w / 2, H / 2); g.textAlign = 'left'; };
        }, 60);
      }
      ctx.cleanup(() => clearTimeout(rb2));
      async function play2() {
        if (!m2.mag) return;
        if (!m2.audio) {
          if (glJob) glJob.cancel();
          const ver = m2.version;
          prog2.set(0.001);
          glJob = glAsync(m2.mag, m2.T, { iters: m2.iters, onProgress: (f) => prog2.set(f) });
          const y = await glJob.promise;
          glJob = null;
          if (!ctx.alive || ver !== m2.version) return;
          m2.audio = D.normalize(y, 0.9);
          const S = specDb(m2.audio);
          heard.extra = null;
          heard.draw(S.img, S.T, { range: 60 });
          prog2.set(0);
        }
        playOn(m2.audio, [pic, heard], 'm2');
        ctx.discover('imgsound');
      }

      /* =================== MODE 3 · Draw a sound =================== */
      const m3 = { T: Math.round((3 * SR) / HOP) + 1, P: null, brush: 'harm', size: 3, usedHarm: false, audio: null, version: 0, last: null };
      m3.P = new Float32Array(m3.T * ROWS);
      const paintCard = specCard('Paint a spectrogram · time →, frequency ↑', 'paint');
      pane3.append(paintCard.card);
      const brushSeg3 = U.seg({ label: 'Brush', value: 'harm', wrap: true,
        options: [['tone', '— Tone'], ['harm', '≡ Harmonics'], ['noise', '░ Noise'], ['erase', '⌫ Erase']],
        onChange: (v) => (m3.brush = v) });
      const size3 = U.slider({ label: 'Brush size', min: 1, max: 10, step: 1, value: 3, fmt: (v) => v + ' px', onInput: (v) => (m3.size = v) });
      const prog3 = progBar();
      const bPlay3 = U.button({ icon: 'play', label: 'Play drawing', kind: 'primary', onClick: () => play3() });
      const bStop3 = U.button({ icon: 'stop', title: 'Stop', onClick: stopPlay });
      const bEx = U.button({ icon: 'dice', label: 'Example', onClick: () => { example(); } });
      const bClr = U.button({ icon: 'eraser', label: 'Clear', onClick: () => { m3.P.fill(0); touched3(); } });
      rail3.append(
        U.group('Brush', brushSeg3.el, size3.el, h('div.btn-row', null, bEx, bClr)),
        U.group('Listen', h('div.btn-row', null, bPlay3, bStop3), prog3.el),
      );
      // splat a soft dot at fractional (t, row-from-bottom k)
      function splat(t, k, sx, sy, amp, erase) {
        const { T, P } = m3;
        const r = Math.ceil(Math.max(sx, sy) * 2.5);
        for (let dt = -r; dt <= r; dt++) {
          const tt = Math.round(t) + dt;
          if (tt < 0 || tt >= T) continue;
          for (let dk = -r; dk <= r; dk++) {
            const kk = Math.round(k) + dk;
            if (kk < 1 || kk >= ROWS) continue;
            const w = Math.exp(-((tt - t) ** 2) / (2 * sx * sx) - ((kk - k) ** 2) / (2 * sy * sy));
            const i = (ROWS - 1 - kk) * T + tt;
            P[i] = erase ? P[i] * (1 - w) : Math.max(P[i], amp * w);
          }
        }
      }
      function brushAt(t, k) {
        const s = m3.size;
        if (m3.brush === 'tone') splat(t, k, s * 0.9, Math.max(0.6, s * 0.35), 1);
        else if (m3.brush === 'harm') {
          const k0 = Math.max(2.5, k);
          for (let m = 1; m * k0 < ROWS - 1; m++) splat(t, m * k0, s * 0.9, 0.7, Math.pow(m, -0.55));
          m3.usedHarm = true;
        } else if (m3.brush === 'noise') {
          for (let j = 0; j < 10; j++) splat(t + (Math.random() - 0.5) * s * 2, k + (Math.random() - 0.5) * s * 10, 1, 1.2, 0.25 + Math.random() * 0.35);
        } else splat(t, k, s * 1.5, s * 1.5, 0, true);
      }
      U.pointer(paintCard.ov, (p) => {
        const t = p.u * m3.T, k = (1 - p.v) * ROWS;
        m3.hover = p.type === 'leave' ? null : { t, k };
        if ((p.type === 'down' || p.type === 'move') && p.down) {
          const L = m3.last;
          if (L && p.type === 'move') {
            const n = Math.max(1, Math.ceil(Math.hypot(t - L.t, k - L.k)));
            for (let i = 1; i <= n; i++) brushAt(L.t + ((t - L.t) * i) / n, L.k + ((k - L.k) * i) / n);
          } else brushAt(t, k);
          m3.last = { t, k };
          touched3();
        }
        if (p.type === 'up') m3.last = null;
      });
      paintCard.ov.classList.add('paintable');
      function touched3() { m3.audio = null; m3.version++; redraw3 = true; }
      let redraw3 = true;
      paintCard.extra = (g, w, H) => {
        const hv = m3.hover;
        if (!hv) return;
        const x = (hv.t / m3.T) * w, y = H - (hv.k / ROWS) * H;
        g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1;
        if (m3.brush === 'harm') {
          const k0 = Math.max(2.5, hv.k);
          g.setLineDash([2, 3]);
          for (let m = 1; m * k0 < ROWS; m++) { const yy = H - ((m * k0) / ROWS) * H; g.beginPath(); g.moveTo(x - 14, yy); g.lineTo(x + 14, yy); g.stroke(); }
          g.setLineDash([]);
          g.fillStyle = th.bridge; g.font = '600 10px "JetBrains Mono", monospace';
          g.fillText(Math.round(k0 * 31.25) + ' Hz', x + 18, y + 3);
        } else {
          g.beginPath(); g.arc(x, y, Math.max(3, (m3.size / m3.T) * w * 2), 0, 7); g.stroke();
          g.fillStyle = th.bridge; g.font = '600 10px "JetBrains Mono", monospace';
          g.fillText(Math.round(hv.k * 31.25) + ' Hz', x + 12, y + 3);
        }
      };
      function example() {
        m3.P.fill(0);
        const T = m3.T, fr = (s) => (s * SR) / HOP;
        // a sung note with vibrato
        for (let t = fr(0.15); t < fr(1.35); t += 0.5) {
          const f0 = 196 * (1 + 0.025 * Math.sin(2 * Math.PI * 5.5 * (t * HOP) / SR)) * (1 + 0.1 * (t - fr(0.15)) / fr(1.2));
          const k0 = f0 / 31.25;
          for (let m = 1; m * k0 < ROWS - 1; m++) splat(t, m * k0, 0.8, 0.6, Math.pow(m, -0.6));
        }
        // a rising whistle
        for (let t = fr(1.55); t < fr(2.3); t += 0.5) splat(t, (1000 + 2200 * ((t - fr(1.55)) / fr(0.75)) ** 1.5) / 31.25, 0.8, 0.6, 0.9);
        // a noise burst ("sh")
        for (let j = 0; j < 900; j++) splat(fr(2.45) + Math.random() * fr(0.35), (2500 + Math.random() * 4000) / 31.25, 1, 1.2, 0.2 + Math.random() * 0.3);
        void T;
        touched3();
      }
      async function play3() {
        if (!m3.audio) {
          if (glJob) glJob.cancel();
          const ver = m3.version, T = m3.T, mag = new Float32Array(T * B);
          for (let t = 0; t < T; t++) for (let k = 0; k < ROWS; k++) mag[t * B + k] = Math.pow(m3.P[(ROWS - 1 - k) * T + t], 1.5);
          prog3.set(0.001);
          glJob = glAsync(mag, T, { iters: 24, onProgress: (f) => prog3.set(f) });
          const y = await glJob.promise;
          glJob = null;
          if (!ctx.alive || ver !== m3.version) return;
          m3.audio = D.normalize(y, 0.9);
          prog3.set(0);
        }
        playOn(m3.audio, [paintCard], 'm3');
        if (m3.usedHarm) ctx.discover('drawsound');
      }
      example();

      /* =================== mode switching & frame loop =================== */
      function setMode(v) {
        mode = v;
        stopPlay();
        [['m1', pane1, rail1], ['m2', pane2, rail2], ['m3', pane3, rail3]].forEach(([id, p, r]) => {
          p.style.display = id === v ? '' : 'none';
          r.style.display = id === v ? '' : 'none';
        });
        if (v === 'm2' && !m2.img && (m2.el || m2.text)) rebuild2();
      }
      setMode('m1');

      ctx.frame(() => {
        if (playing && playing.handle.playing) {
          const f = playing.handle.t / playing.dur;
          playing.cards.forEach((c) => (c.head = f));
        }
        if (mode === 'm1') { drawModOverlay(); sIn.overlay(); sOut.overlay(); }
        else if (mode === 'm2') { pic.overlay(); heard.overlay(); }
        else {
          if (redraw3) { redraw3 = false; I.draw(paintCard.cv, m3.P, m3.T, ROWS, { cmap: 'magma', min: 0, max: 1 }); paintCard.T = m3.T; paintCard.dur = ((m3.T - 1) * HOP) / SR; }
          paintCard.overlay();
        }
      });
    },
  });
})();
