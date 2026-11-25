/* SPECTRA — A3 "The Wire": a century of telephone speech coding.
 * Linear PCM → G.711 μ-law → G.726-style ADPCM → LPC-10-style vocoder, all written from scratch.
 */
(function () {
  const SL = window.SL, D = SL.dsp, U = SL.ui, h = SL.h, I = SL.img, A = SL.audio;
  const SR = 16000;

  const ERAS = [
    { id: 'pcm', year: '1937', name: 'Linear PCM', sub: 'sample + round', nominal: 256 },
    { id: 'mulaw', year: '1972', name: 'G.711 μ-law', sub: 'log companding', nominal: 64 },
    { id: 'adpcm', year: '1990', name: 'G.726 ADPCM', sub: 'code the surprise', nominal: 32 },
    { id: 'lpc', year: '1984', name: 'LPC-10 vocoder', sub: 'send the model', nominal: 2.4 },
  ];

  /* ====================== codecs ====================== */
  const down = (x, fs) => (fs === SR ? Float32Array.from(x) : D.resample(x, SR, fs));
  const lpCache = {};
  function up(y, fs, L) {
    let z = y;
    if (fs !== SR) {
      z = D.resample(y, fs, SR); // linear interpolation leaves images above fs/2 …
      const hlp = lpCache[fs] || (lpCache[fs] = D.firLowpass((0.5 * fs) / SR * 0.96, 81));
      z = D.convolve(z, hlp); // … so an anti-imaging low-pass removes them
    }
    const out = new Float32Array(L);
    out.set(z.subarray(0, Math.min(L, z.length)));
    return out;
  }

  function codePCM(x, p) {
    const xs = down(x, p.fs), q = new Float32Array(xs.length);
    for (let i = 0; i < xs.length; i++) q[i] = D.quantize(D.clamp(xs[i], -1, 1), p.bits);
    return { y: up(q, p.fs, x.length), kbps: (p.fs * p.bits) / 1000, xs, fs: p.fs };
  }

  const muQ = (v, mu, bits) => (mu < 0.5 ? D.quantize(v, bits) : D.muLawInv(D.quantize(D.muLaw(v, mu), bits), mu));
  function codeMu(x, p) {
    const fs = 8000, xs = down(x, fs), q = new Float32Array(xs.length);
    for (let i = 0; i < xs.length; i++) q[i] = muQ(D.clamp(xs[i], -1, 1), p.mu, p.bits);
    return { y: up(q, fs, x.length), kbps: 8 * p.bits, xs, fs };
  }

  function jayant(b) {
    if (b === 2) return [0.8, 1.6];
    if (b === 3) return [0.9, 0.9, 1.25, 1.75];
    if (b === 4) return [0.9, 0.9, 0.9, 0.9, 1.2, 1.6, 2.0, 2.4];
    const half = 2 ** (b - 1);
    return Array.from({ length: half }, (_, i) => (i < half / 2 ? 0.9 : 1.2 + (i - half / 2) * 0.2));
  }
  /** Backward-adaptive 10th-order predictor refit every 10 ms from the last 256 samples of `hist`. */
  function fitPredictor(hist, n, order) {
    const s = Math.max(0, n - 256), seg = hist.subarray(s, n);
    if (seg.length < 32 || D.rms(seg) < 1e-4) return new Float64Array(order + 1);
    const { a } = D.lpc(seg, order, { preemph: 0, win: 'hamming' });
    for (let k = 1; k <= order; k++) a[k] *= Math.pow(0.97, k); // bandwidth expansion keeps it tame
    return a;
  }
  function codeADPCM(x, p) {
    const fs = 8000, xs = down(x, fs), N = xs.length, b = p.bits, half = 2 ** (b - 1), M = jayant(b);
    const order = 10, hop = 80;
    const dec = new Float32Array(N), res = new Float32Array(N);
    let aDec = new Float64Array(order + 1), aEnc = aDec, step = 0.02;
    for (let n = 0; n < N; n++) {
      if (n % hop === 0 && n >= 32) {
        aDec = fitPredictor(dec, n, order);
        aEnc = p.cheat ? fitPredictor(xs, n, order) : aDec;
      }
      const hEnc = p.cheat ? xs : dec;
      let pe = 0, pd = 0;
      for (let k = 1; k <= order && n - k >= 0; k++) { pe += aEnc[k] * hEnc[n - k]; pd += aDec[k] * dec[n - k]; }
      const d = xs[n] - pe;
      res[n] = d;
      const idx = D.clamp(Math.floor(d / step), -half, half - 1);
      dec[n] = D.clamp(pd + (idx + 0.5) * step, -1.5, 1.5);
      step = D.clamp(step * M[idx >= 0 ? idx : -idx - 1], 2e-4, 0.6);
    }
    return { y: up(dec, fs, x.length), kbps: 8 * b, xs, res, fs };
  }

  const stepUp = (k, p) => {
    const a = new Float64Array(p + 1), t = new Float64Array(p + 1);
    a[0] = 1;
    for (let i = 1; i <= p; i++) {
      t.set(a);
      a[i] = k[i];
      for (let j = 1; j < i; j++) a[j] = t[j] - k[i] * t[i - j];
    }
    return a;
  };
  const larBits = (order, lb) => Array.from({ length: order }, (_, i) => Math.max(1, lb - Math.floor(i / 4)));
  function codeLPC(x, p) {
    const fs = 8000, xs = down(x, fs), N = xs.length, order = p.order, F = Math.round((p.frameMs * fs) / 1000);
    const pre = new Float32Array(N);
    for (let n = 0; n < N; n++) pre[n] = xs[n] - (n ? 0.9375 * xs[n - 1] : 0);
    const Wa = 2 * F, w = D.win('hamming', Wa, false);
    let w2 = 0;
    for (let i = 0; i < Wa; i++) w2 += w[i] * w[i];
    const alloc = larBits(order, p.larBits);
    const bitsPerFrame = alloc.reduce((s, v) => s + v, 0) + 6 + 1 + 5;
    let peak = 0;
    for (let n = 0; n < N; n++) peak = Math.max(peak, Math.abs(xs[n]));
    const frames = [];
    const segP = new Float32Array(Wa), segX = new Float32Array(Wa);
    for (let s = 0; s < N; s += F) {
      const c0 = s + (F >> 1) - (Wa >> 1);
      for (let i = 0; i < Wa; i++) { const j = c0 + i; segP[i] = j >= 0 && j < N ? pre[j] : 0; segX[i] = j >= 0 && j < N ? xs[j] : 0; }
      const L = D.lpc(segP, order, { preemph: 0, win: 'hamming' });
      // quantise reflection coefficients as log-area ratios
      const kq = new Float64Array(order + 1);
      for (let i = 1; i <= order; i++) {
        const k = D.clamp(L.k[i] || 0, -0.995, 0.995), lar = Math.log((1 + k) / (1 - k)), R = i <= 2 ? 6 : 3;
        const lq = D.quantize(D.clamp(lar / R, -1, 0.9999), alloc[i - 1]) * R;
        kq[i] = Math.tanh(lq / 2);
      }
      const eRms = Math.sqrt(Math.max(L.err, 0) / w2);
      const gdb = D.clamp(Math.round((20 * Math.log10(eRms + 1e-9) + 80) / 2.5) * 2.5 - 80, -80, -2.5);
      const pt = D.pitch(segX, fs, 60, 400);
      const voiced = pt.conf > 0.5 && pt.f0 > 0 && Math.sqrt(pt.energy) > peak * 0.02;
      const pIdx = voiced ? Math.round((Math.log(pt.f0 / 50) / Math.log(8)) * 63) : 0;
      const f0q = 50 * Math.pow(8, D.clamp(pIdx, 0, 63) / 63);
      frames.push({ s, kq, g: Math.pow(10, gdb / 20), voiced, f0: voiced ? f0q : 0 });
    }
    // synthesis: excitation → 1/A(z) → de-emphasis
    const y = new Float32Array(N), hist = new Float64Array(order + 1), R = D.rng(5);
    let ctr = 0, prevG = 0;
    for (const fr of frames) {
      const a = stepUp(fr.kq, order);
      const voiced = p.excite !== 'whisper' && fr.voiced;
      const period = voiced ? fs / (p.excite === 'mono' ? 110 : fr.f0) : 0;
      for (let i = 0; i < F && fr.s + i < N; i++) {
        const g = prevG + (fr.g - prevG) * (i / F);
        let e = 0;
        if (voiced) { ctr += 1; if (ctr >= period) { ctr -= period; e = Math.sqrt(period); } }
        else e = D.gauss(R);
        let out = g * e;
        for (let k = 1; k <= order; k++) out += a[k] * hist[k];
        out = D.clamp(out, -4, 4);
        for (let k = order; k > 1; k--) hist[k] = hist[k - 1];
        hist[1] = out;
        y[fr.s + i] = out;
      }
      prevG = fr.g;
    }
    for (let n = 1; n < N; n++) y[n] += 0.9375 * y[n - 1];
    const gx = D.rms(xs), gy = D.rms(y) || 1;
    for (let n = 0; n < N; n++) y[n] = D.clamp((y[n] * gx) / gy, -1, 1);
    return { y: up(y, fs, x.length), kbps: bitsPerFrame / (F / fs) / 1000, xs, fs, frames, alloc, bitsPerFrame, frameMs: (F / fs) * 1000 };
  }

  /* ====================== measures ====================== */
  function lsd(a, b) {
    const Sa = D.stft(a, 512, 128), Sb = D.stft(b, 512, 128), B = Sa.B;
    let tot = 0, cnt = 0, maxE = 0, maxP = 0;
    for (let i = 0; i < Sa.re.length; i++) maxP = Math.max(maxP, Sa.re[i] ** 2 + Sa.im[i] ** 2);
    const floor = maxP * 1e-6 + 1e-12; // 60 dB below the loudest bin
    const E = new Float32Array(Sa.T);
    for (let t = 0; t < Sa.T; t++) {
      let e = 0;
      for (let k = 0; k < B; k++) e += Sa.re[t * B + k] ** 2 + Sa.im[t * B + k] ** 2;
      E[t] = e; maxE = Math.max(maxE, e);
    }
    for (let t = 0; t < Sa.T; t++) {
      if (E[t] < maxE * 1e-4) continue;
      let s = 0;
      for (let k = 1; k < B; k++) {
        const i = t * B + k;
        const pa = Math.max(floor, Sa.re[i] ** 2 + Sa.im[i] ** 2), pb = Math.max(floor, Sb.re[i] ** 2 + Sb.im[i] ** 2);
        s += (10 * Math.log10(pa / pb)) ** 2;
      }
      tot += Math.sqrt(s / (B - 1)); cnt++;
    }
    return cnt ? tot / cnt : 0;
  }
  /** dB spectrogram laid out for drawing: row 0 = top (high freq). */
  function specImage(x) {
    const S = D.stft(x, 512, 128), T = S.T, B = S.B, img = new Float32Array(T * B);
    for (let t = 0; t < T; t++) for (let k = 0; k < B; k++) {
      const i = t * B + k;
      img[(B - 1 - k) * T + t] = 10 * Math.log10(S.re[i] ** 2 + S.im[i] ** 2 + 1e-10);
    }
    return { img, T, B };
  }

  /* ====================== lab ====================== */
  SL.lab({
    id: 'codec', side: 'ear', code: 'A3',
    title: 'The Wire',
    tagline: 'Squeeze a voice through a century of telephone.',
    syllabus: ['SAP M6', 'SAP M4'],
    concepts: [
      { key: 'sixdb', label: '6 dB per bit', math: ['quant'], hint: 'Step the bits at 16 kHz',
        line: 'Every extra bit halves the quantiser step and buys ≈ 6.02 dB of SNR (6.02b + 1.76 dB for a full-scale sine).' },
      { key: 'nyquist', label: 'Nyquist bites', math: ['sampling', 'fourier'], hint: 'Try a 4 kHz sample rate',
        line: 'Sampling at 4 kHz keeps only content below 2 kHz; /s/ and /ʃ/ live higher, so fricatives vanish.' },
      { key: 'mulaw', label: 'μ-law companding', math: ['quant', 'percept'], hint: 'Sweep μ from 0 to 255',
        line: 'μ-law spends fine steps on quiet samples and coarse ones on loud samples, so 8 bits sound like ~13 linear bits.' },
      { key: 'adpcm', label: 'Code the surprise', math: ['predict', 'quant'], hint: 'ADPCM at 4 bits',
        line: 'The prediction error has a far smaller spread than the signal, so ADPCM hits toll quality at 32 kbps, half of G.711.' },
      { key: 'decoded', label: 'Predict from decoded', math: ['predict'], hint: 'Let the encoder cheat',
        line: 'If the encoder predicts from the original but the decoder only has decoded samples, their predictions drift and errors pile up.' },
      { key: 'vocoder', label: 'Send the model', math: ['predict', 'filter'], hint: 'Pick the 1984 vocoder',
        line: 'An LPC vocoder sends no waveform: just reflection coefficients, pitch, voicing and gain, ≈ 54 bits per 22.5 ms = 2.4 kbps.' },
      { key: 'snrlies', label: 'SNR lies', math: ['percept', 'noise'], hint: 'Listen to the vocoder',
        line: 'The vocoder scores ≈ 0 dB SNR yet stays intelligible: waveform SNR cannot judge a codec that throws phase away.' },
    ],
    thumb(g, w, H, t) {
      const bits = 1 + (Math.floor(t * 0.7) % 5), L = 2 ** bits, cy = H / 2, amp = H * 0.36;
      g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 1.2; g.beginPath();
      for (let x = 0; x <= w; x += 2) { const v = Math.sin(x / 22 + t * 1.5) * Math.sin(x / 71 + t * 0.4); x ? g.lineTo(x, cy - v * amp) : g.moveTo(x, cy - v * amp); }
      g.stroke();
      g.strokeStyle = '#ff5fa2'; g.lineWidth = 2; g.shadowColor = '#ff5fa2'; g.shadowBlur = 8; g.beginPath();
      for (let x = 0; x <= w; x += 6) {
        const v = Math.sin(x / 22 + t * 1.5) * Math.sin(x / 71 + t * 0.4);
        const q = (Math.floor(((v + 1) / 2) * L - 1e-9) + 0.5) / L * 2 - 1;
        const y = cy - q * amp;
        x ? (g.lineTo(x, y), g.lineTo(x + 6, y)) : g.moveTo(x, y);
      }
      g.stroke(); g.shadowBlur = 0;
      g.fillStyle = '#ff5fa2'; g.font = '600 11px "JetBrains Mono", monospace'; g.fillText(bits + ' bit', 10, 18);
    },

    build(ctx) {
      const th = U.theme();
      const st = {
        x: null, era: 'pcm', r: null, specX: null, specY: null, err: null,
        pcm: { fs: 16000, bits: 8 }, mulaw: { mu: 255, bits: 8 }, adpcm: { bits: 4, cheat: false },
        lpc: { frameMs: 22.5, order: 10, larBits: 5, excite: 'normal' },
        metrics: null, view: [0, 1], playing: null, needle: 0.5, userTouched: false,
        bitsTried: new Set(), muLow: false, muHigh: false,
      };

      /* ---------- era selector ---------- */
      const eraBtns = ERAS.map((e) => {
        const kb = h('span.cx-era-kb', null, fmtK(e.nominal));
        const b = h('button.cx-era', { type: 'button' },
          h('div.cx-era-year', null, e.year), h('div.cx-era-name', null, e.name), h('div.cx-era-sub', null, e.sub),
          h('div.cx-era-foot', null, kb, h('span.cx-era-unit', null, 'kbps')),
          h('i.cx-era-bar', { style: { '--w': (Math.log(e.nominal / 0.5) / Math.log(1024)) * 100 + '%' } }));
        b._e = e; b._kb = kb;
        b.addEventListener('click', () => { st.userTouched = true; setEra(e.id); });
        return b;
      });
      const eras = h('div.cx-eras', null, eraBtns);

      /* ---------- stage ---------- */
      const gaugeCv = h('canvas.cx-gauge');
      const qCv = h('canvas.cx-q');
      const qLabel = h('div.card-label', null, 'Quantiser');
      const waveCv = h('canvas.cx-wave');
      const specA = U.canvas(10, 10, { cls: 'cx-spec' }), specB = U.canvas(10, 10, { cls: 'cx-spec' });
      const ovA = h('canvas.cx-ov'), ovB = h('canvas.cx-ov');
      const gaugeCard = U.card('Bit-rate', gaugeCv);
      const qCard = h('div.card', null, qLabel, qCv);
      const waveCard = U.card('Waveform · drag to pan · wheel to zoom', waveCv,
        h('div.legend.cx-legend', null, h('span', null, h('i', { style: { background: 'rgba(255,255,255,.45)' } }), 'original'),
          h('span', null, h('i', { style: { background: th.ear } }), 'decoded'), h('span', null, h('i', { style: { background: th.warn } }), 'error')));
      const specCardA = U.card('Original', h('div.cx-specwrap', null, specA, ovA));
      const specCardB = U.card('Decoded', h('div.cx-specwrap', null, specB, ovB));
      ctx.stage.append(eras, h('div.cx-top', null, gaugeCard, qCard), waveCard, h('div.grid2', null, specCardA, specCardB));

      /* ---------- rail ---------- */
      const src = U.audioSource({ sr: SR, maxSec: 4, onAudio: (y) => { st.x = y; st.specX = specImage(y); st.view = [0, 1]; recompute(); } });
      const paramsBox = h('div.cx-params');
      const paramGroup = U.group('Codec', paramsBox);

      const loopT = U.toggle({ label: 'Loop', value: false });
      const bOrig = U.button({ icon: 'play', label: 'Original', onClick: () => play('orig') });
      const bDec = U.button({ icon: 'play', label: 'Decoded', kind: 'primary', onClick: () => play('dec') });
      const bErr = U.button({ icon: 'play', label: 'Error', onClick: () => play('err') });
      const bAB = U.button({ label: 'A ⇄ B', title: 'Swap original/decoded at the same moment', onClick: () => {
        const p = st.playing;
        const which = p && p.which === 'dec' ? 'orig' : 'dec';
        play(which, p ? curTime() : 0);
      } });
      const bStop = U.button({ icon: 'stop', title: 'Stop', onClick: () => { A.stop(); st.playing = null; } });
      const listen = U.group('Listen', h('div.btn-row', null, bOrig, bDec, bErr), h('div.btn-row', null, bAB, bStop), loopT.el);

      const sKb = U.stat('Bit-rate', 'kbps'), sRatio = U.stat('Squeeze', '×');
      const sSnr = U.stat('SNR', 'dB', { bar: true }), sSeg = U.stat('segSNR', 'dB', { bar: true }), sLsd = U.stat('Spectral dist.', 'dB', { bar: true });
      const sTheory = U.stat('Theory', 'dB');
      const quality = U.group('Quality', h('div.stat-grid', null, sKb.el, sRatio.el, sSnr.el, sSeg.el, sLsd.el, sTheory.el));
      ctx.rail.append(U.group('Voice', src.el), paramGroup, listen, quality);
      ctx.cleanup(() => src.stop());

      /* ---------- params per era ---------- */
      function buildParams() {
        paramsBox.innerHTML = '';
        const touch = () => { st.userTouched = true; };
        if (st.era === 'pcm') {
          const fsSeg = U.seg({ label: 'Sample rate', options: [[16000, '16 kHz'], [8000, '8 kHz'], [4000, '4 kHz']], value: st.pcm.fs,
            onChange: (v) => { touch(); st.pcm.fs = v; if (v === 4000) st.wantNyq = true; recompute(); } });
          const bits = U.slider({ label: 'Bits / sample', min: 1, max: 16, step: 1, value: st.pcm.bits, fmt: (v) => v + ' b',
            onInput: (v) => { touch(); st.pcm.bits = v; if (st.pcm.fs === 16000) st.bitsTried.add(v); recompute(); } });
          paramsBox.append(fsSeg.el, bits.el);
        } else if (st.era === 'mulaw') {
          const mu = U.slider({ label: 'μ  (0 = uniform)', min: 0, max: 255, step: 1, value: st.mulaw.mu, fmt: (v) => Math.round(v),
            onInput: (v) => { touch(); st.mulaw.mu = v; if (v < 5) st.muLow = true; if (v > 150) st.muHigh = true; recompute(); } });
          const bits = U.slider({ label: 'Bits / sample', min: 2, max: 8, step: 1, value: st.mulaw.bits, fmt: (v) => v + ' b',
            onInput: (v) => { touch(); st.mulaw.bits = v; recompute(); } });
          paramsBox.append(mu.el, bits.el, h('div.hint', null, '8 kHz · telephone band'));
        } else if (st.era === 'adpcm') {
          const bits = U.seg({ label: 'Bits / sample', options: [[2, '2 · 16k'], [3, '3 · 24k'], [4, '4 · 32k'], [5, '5 · 40k']], value: st.adpcm.bits,
            onChange: (v) => { touch(); st.adpcm.bits = v; recompute(); } });
          const cheat = U.toggle({ label: 'Encoder predicts from original', value: st.adpcm.cheat,
            onChange: (v) => { touch(); st.adpcm.cheat = v; if (v) st.wantCheat = true; recompute(); } });
          paramsBox.append(bits.el, cheat.el, h('div.hint', null, 'order-10 predictor · refit every 10 ms · Jayant step'));
        } else {
          const fr = U.slider({ label: 'Frame', min: 15, max: 30, step: 2.5, value: st.lpc.frameMs, unit: 'ms',
            onInput: (v) => { touch(); st.lpc.frameMs = v; recompute(); } });
          const ord = U.slider({ label: 'Order', min: 4, max: 16, step: 1, value: st.lpc.order, fmt: (v) => 'p = ' + v,
            onInput: (v) => { touch(); st.lpc.order = v; recompute(); } });
          const lb = U.slider({ label: 'LAR bits (k₁…k₄)', min: 2, max: 7, step: 1, value: st.lpc.larBits, fmt: (v) => v + ' b',
            onInput: (v) => { touch(); st.lpc.larBits = v; recompute(); } });
          const ex = U.seg({ label: 'Excitation', options: [['normal', 'Pitch'], ['mono', 'Monotone'], ['whisper', 'Whisper']], value: st.lpc.excite,
            onChange: (v) => { touch(); st.lpc.excite = v; recompute(); } });
          paramsBox.append(fr.el, ord.el, lb.el, ex.el);
        }
      }
      function setEra(id) {
        st.era = id;
        eraBtns.forEach((b) => b.classList.toggle('on', b._e.id === id));
        buildParams();
        qLabel.textContent = id === 'adpcm' ? 'Signal vs prediction error' : id === 'lpc' ? 'One frame on the wire' : id === 'mulaw' ? 'Companded quantiser' : 'Quantiser';
        recompute();
      }

      /* ---------- compute ---------- */
      let tm = null;
      function recompute() {
        clearTimeout(tm);
        tm = setTimeout(() => { if (ctx.alive) run(); }, 40);
      }
      ctx.cleanup(() => clearTimeout(tm));
      function run() {
        if (!st.x) return;
        const x = st.x;
        const r = st.era === 'pcm' ? codePCM(x, st.pcm) : st.era === 'mulaw' ? codeMu(x, st.mulaw) : st.era === 'adpcm' ? codeADPCM(x, st.adpcm) : codeLPC(x, st.lpc);
        st.r = r;
        // SNR is measured against the band-limited input (coding noise only); spectral distance against the full input.
        const ref = r.fs < SR ? up(down(x, r.fs), r.fs, x.length) : x;
        st.err = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++) st.err[i] = ref[i] - r.y[i];
        st.specY = specImage(r.y);
        const snr = D.snr(ref, r.y), seg = D.segSNR(ref, r.y, 320), ld = lsd(x, r.y);
        st.metrics = { snr, seg, ld };
        st.cache = {};
        const eb = eraBtns.find((b) => b._e.id === st.era);
        eb._kb.textContent = fmtK(r.kbps);
        sKb.set(fmtK(r.kbps));
        sRatio.set((256 / r.kbps).toFixed(r.kbps > 64 ? 1 : 0), 'vs 16 kHz · 16 bit');
        sSnr.set(snr.toFixed(1), r.fs < SR ? `vs ${r.fs / 2000} kHz band` : 'full band', snr / 50); sSnr.color(qualCol(snr / 35));
        sSeg.set(seg.toFixed(1), undefined, (seg + 10) / 45); sSeg.color(qualCol((seg + 5) / 35));
        sLsd.set(ld.toFixed(1), 'lower is better', 1 - ld / 20); sLsd.color(qualCol(1 - ld / 14));
        if (st.era === 'pcm' || st.era === 'mulaw') {
          const bits = st[st.era].bits, sig = D.rms(r.xs);
          sTheory.set((6.02 * bits + 4.77 + 20 * Math.log10(sig + 1e-9)).toFixed(1), st.era === 'pcm' ? '6.02b + 4.77 + 20log σ' : 'uniform, same bits');
        } else if (st.era === 'adpcm') {
          let vx = 0, vr = 0;
          for (let i = 0; i < r.xs.length; i++) { vx += r.xs[i] ** 2; vr += r.res[i] ** 2; }
          sTheory.set((10 * Math.log10(vx / (vr || 1e-12))).toFixed(1), 'prediction gain Gp');
        } else sTheory.set('—', 'no waveform sent');
        drawSpecs();
        drawQ();
        checkDiscoveries();
      }
      function checkDiscoveries() {
        if (!st.userTouched) return;
        if (st.bitsTried.size >= 3) ctx.discover('sixdb');
        if (st.era === 'pcm' && st.pcm.fs === 4000 && st.wantNyq) ctx.discover('nyquist');
        if (st.era === 'mulaw' && st.muLow && st.muHigh) ctx.discover('mulaw');
        if (st.era === 'adpcm' && st.adpcm.bits <= 4 && !st.adpcm.cheat && st.metrics.seg > 8) ctx.discover('adpcm');
        if (st.era === 'adpcm' && st.adpcm.cheat && st.wantCheat) ctx.discover('decoded');
        if (st.era === 'lpc') ctx.discover('vocoder');
      }

      /* ---------- playback ---------- */
      function sig(which) { return which === 'orig' ? st.x : which === 'dec' ? st.r.y : st.err; }
      function curTime() {
        const p = st.playing;
        if (!p || !p.handle.playing) return 0;
        return (p.off + p.handle.t) % (st.x.length / SR);
      }
      function play(which, offSec = 0) {
        if (!st.x || !st.r) return;
        const s = sig(which), off = Math.max(0, Math.min(s.length - 1, Math.floor(offSec * SR)));
        let seg;
        if (off > 0) { seg = new Float32Array(s.length); seg.set(s.subarray(off)); seg.set(s.subarray(0, off), s.length - off); if (!loopT.value) seg = seg.subarray(0, s.length - off); }
        else seg = s;
        const handle = A.play(seg, SR, { loop: loopT.value, onEnd: () => { if (st.playing && st.playing.handle === handle) st.playing = null; } });
        st.playing = { which, off: off / SR, handle };
        if (which === 'dec' && st.era === 'lpc') ctx.discover('snrlies');
      }

      /* ---------- drawing ---------- */
      function drawSpec(cv, S) {
        if (!S) return;
        let mx = -Infinity;
        for (let i = 0; i < S.img.length; i++) if (S.img[i] > mx) mx = S.img[i];
        I.draw(cv, S.img, S.T, S.B, { cmap: 'magma', min: mx - 75, max: mx });
      }
      function drawSpecs() { drawSpec(specA, st.specX); drawSpec(specB, st.specY); }
      function drawOverlay(cv, isDec) {
        const { ctx: g, w, h: H } = U.fit(cv);
        g.clearRect(0, 0, w, H);
        g.font = '500 9.5px "JetBrains Mono", monospace'; g.fillStyle = 'rgba(255,255,255,.55)';
        for (const k of [2, 4, 6]) { const y = H - (k / 8) * H; g.fillText(k + 'k', 4, y + 3); g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(22, y, w - 22, 1); g.fillStyle = 'rgba(255,255,255,.55)'; }
        if (isDec && st.r && st.r.fs < SR) {
          const y = H - (st.r.fs / 2 / 8000) * H;
          g.setLineDash([5, 4]); g.strokeStyle = th.warn; g.lineWidth = 1.2; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.setLineDash([]);
          g.fillStyle = th.warn; g.textAlign = 'right'; g.fillText('Nyquist ' + st.r.fs / 2000 + ' kHz', w - 6, y - 5); g.textAlign = 'left';
        }
        if (st.playing && st.playing.handle.playing && st.x) {
          const x = (curTime() / (st.x.length / SR)) * w;
          g.fillStyle = '#fff'; g.fillRect(x - 0.5, 0, 1.5, H);
        }
      }

      function drawWave() {
        const { ctx: g, w, h: H } = U.fit(waveCv);
        g.clearRect(0, 0, w, H);
        if (!st.x || !st.r) return;
        const x = st.x, y = st.r.y, e = st.err, N = x.length;
        const v0 = Math.floor(st.view[0] * N), v1 = Math.max(v0 + 8, Math.floor(st.view[1] * N));
        const top = 8, mainH = H * 0.7, cy = top + mainH / 2, amp = mainH / 2 - 4;
        const ey0 = top + mainH + 10, eH = H - ey0 - 6, ecy = ey0 + eH / 2;
        g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(0, cy, w, 1); g.fillRect(0, ecy, w, 1);
        const spp = (v1 - v0) / w;
        const env = (arr, cyy, a, col, fill) => {
          if (spp > 2) {
            g.beginPath();
            const mins = [];
            for (let px = 0; px < w; px++) {
              const s = v0 + Math.floor(px * spp), e2 = Math.min(N, v0 + Math.floor((px + 1) * spp));
              let mn = 1e9, mx = -1e9;
              for (let i = s; i < e2; i++) { const v = arr[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
              if (mn > mx) { mn = mx = 0; }
              px ? g.lineTo(px, cyy - mx * a) : g.moveTo(px, cyy - mx * a);
              mins.push(mn);
            }
            for (let px = w - 1; px >= 0; px--) g.lineTo(px, cyy - mins[px] * a);
            g.closePath();
            g.fillStyle = fill; g.fill();
          } else {
            g.beginPath();
            for (let i = v0; i <= v1 && i < N; i++) { const px = (i - v0) / spp; const py = cyy - arr[i] * a; i > v0 ? g.lineTo(px, py) : g.moveTo(px, py); }
            g.strokeStyle = col; g.lineWidth = 1.5; g.stroke();
            if (spp < 0.25) for (let i = v0; i <= v1 && i < N; i++) { g.fillStyle = col; g.fillRect((i - v0) / spp - 1.5, cyy - arr[i] * a - 1.5, 3, 3); }
          }
        };
        env(x, cy, amp, 'rgba(255,255,255,.55)', 'rgba(255,255,255,.22)');
        env(y, cy, amp, th.ear, 'rgba(255,95,162,.55)');
        let em = 0;
        for (let i = 0; i < N; i++) em = Math.max(em, Math.abs(e[i]));
        const eg = em > 0 ? Math.max(1, Math.min(4096, 2 ** Math.floor(Math.log2(0.9 / em)))) : 1;
        env(e, ecy, (eH / 2) * eg, th.warn, 'rgba(255,200,87,.6)');
        g.font = '500 9.5px "JetBrains Mono", monospace'; g.fillStyle = 'rgba(255,255,255,.4)';
        g.fillText(eg > 1 ? `error ×${eg}` : 'error', 6, ey0 + 9);
        const t0 = v0 / SR, t1 = v1 / SR;
        g.textAlign = 'right'; g.fillText(`${(t0 * 1000).toFixed(0)}–${(t1 * 1000).toFixed(0)} ms`, w - 6, H - 4); g.textAlign = 'left';
        if (st.playing && st.playing.handle.playing) {
          const ps = curTime() * SR;
          if (ps >= v0 && ps <= v1) { g.fillStyle = '#fff'; g.fillRect((ps - v0) / spp, 0, 1.5, H); }
        }
      }
      // pan / zoom
      let drag = null;
      U.pointer(waveCv, (p) => {
        if (p.type === 'down') drag = { u: p.u, view: st.view.slice() };
        else if (p.type === 'move' && drag && p.down) {
          const span = drag.view[1] - drag.view[0], d = (drag.u - p.u) * span;
          const a = D.clamp(drag.view[0] + d, 0, 1 - span);
          st.view = [a, a + span];
        } else if (p.type === 'up') drag = null;
      });
      ctx.on(waveCv, 'wheel', (e) => {
        e.preventDefault();
        const r = waveCv.getBoundingClientRect(), u = (e.clientX - r.left) / r.width;
        const [a, b] = st.view, span = b - a, c = a + u * span;
        const ns = D.clamp(span * Math.pow(1.0015, e.deltaY), 64 / (st.x ? st.x.length : 1e5), 1);
        let na = c - u * ns;
        na = D.clamp(na, 0, 1 - ns);
        st.view = [na, na + ns];
      }, { passive: false });
      ctx.on(waveCv, 'dblclick', () => (st.view = [0, 1]));

      function drawQ() {
        const { ctx: g, w, h: H } = U.fit(qCv);
        g.clearRect(0, 0, w, H);
        const r = st.r;
        if (!r) return;
        g.font = '500 9.5px "JetBrains Mono", monospace';
        if (st.era === 'lpc') return drawPacket(g, w, H, r);
        const pad = 26, x0 = pad, x1 = w - 10, y0 = 30, y1 = H - 22;
        const X = (v) => x0 + ((v + 1) / 2) * (x1 - x0), Y = (v) => y1 - ((v + 1) / 2) * (y1 - y0);
        const hist = (arr, scale = 1) => {
          const nb = 121, hh = new Float32Array(nb);
          for (let i = 0; i < arr.length; i++) { const b = Math.floor(((D.clamp(arr[i] * scale, -1, 0.9999) + 1) / 2) * nb); hh[b]++; }
          let m = 0;
          for (const v of hh) m = Math.max(m, v);
          return Array.from(hh, (v) => Math.sqrt(v / (m || 1)));
        };
        g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(X(-1), Y(0)); g.lineTo(X(1), Y(0)); g.moveTo(X(0), Y(-1)); g.lineTo(X(0), Y(1)); g.stroke();
        if (st.era === 'adpcm') {
          const hx = hist(r.xs), hr = hist(r.res);
          const bw = (x1 - x0) / hx.length;
          hx.forEach((v, i) => { g.fillStyle = 'rgba(255,255,255,.2)'; g.fillRect(x0 + i * bw, y1 - v * (y1 - y0), bw - 0.5, v * (y1 - y0)); });
          hr.forEach((v, i) => { g.fillStyle = 'rgba(255,95,162,.65)'; g.fillRect(x0 + i * bw + bw * 0.2, y1 - v * (y1 - y0), bw * 0.6, v * (y1 - y0)); });
          g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText('signal', x0, y0 - 8);
          g.fillStyle = th.ear; g.fillText('prediction error', x0 + 60, y0 - 8);
          g.fillStyle = 'rgba(255,255,255,.4)'; g.textAlign = 'center'; g.fillText('amplitude', (x0 + x1) / 2, H - 6); g.textAlign = 'left';
          return;
        }
        const hx = hist(r.xs), bw = (x1 - x0) / hx.length;
        hx.forEach((v, i) => { g.fillStyle = 'rgba(255,95,162,.16)'; g.fillRect(x0 + i * bw, y1 - v * (y1 - y0), bw - 0.5, v * (y1 - y0)); });
        const bits = st[st.era].bits, mu = st.era === 'mulaw' ? st.mulaw.mu : 0;
        g.beginPath();
        const n = 900;
        for (let i = 0; i <= n; i++) {
          const v = -1 + (2 * i) / n, q = st.era === 'mulaw' ? muQ(v, mu, bits) : D.quantize(v, bits);
          i ? g.lineTo(X(v), Y(q)) : g.moveTo(X(v), Y(q));
        }
        g.strokeStyle = th.ear; g.lineWidth = 1.6; g.shadowColor = th.ear; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
        g.fillStyle = 'rgba(255,255,255,.45)';
        g.fillText('in →', x1 - 30, Y(0) + 12);
        g.fillText('out', X(0) + 5, y0 + 2);
        g.fillStyle = th.ear; g.textAlign = 'right';
        g.fillText(`${2 ** bits} levels`, x1, y0 - 8); g.textAlign = 'left';
        g.fillStyle = 'rgba(255,255,255,.4)'; g.fillText('sample histogram', x0, y0 - 8);
      }
      function drawPacket(g, w, H, r) {
        const x0 = 12, x1 = w - 12;
        const parts = r.alloc.map((b, i) => ({ b, lab: 'k' + (i + 1), col: `hsl(${330 - i * 9},85%,${62 - i * 2}%)` }));
        parts.push({ b: 6, lab: 'F0', col: '#4de1ff' }, { b: 1, lab: 'V', col: '#ffc857' }, { b: 5, lab: 'G', col: '#5ef2a0' });
        const tot = parts.reduce((s, p) => s + p.b, 0);
        let x = x0;
        const by = 34, bh = 26;
        g.fillStyle = 'rgba(255,255,255,.5)';
        g.fillText(`${tot} bits  /  ${r.frameMs.toFixed(1)} ms frame`, x0, by - 10);
        for (const p of parts) {
          const ww = ((x1 - x0) * p.b) / tot;
          g.fillStyle = p.col; g.globalAlpha = 0.85; g.fillRect(x + 0.5, by, ww - 1, bh); g.globalAlpha = 1;
          for (let k = 1; k < p.b; k++) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x + (ww * k) / p.b, by + 4, 1, bh - 8); }
          if (ww > 16) { g.fillStyle = '#0a0b10'; g.font = '700 9px "JetBrains Mono", monospace'; g.textAlign = 'center'; g.fillText(p.lab, x + ww / 2, by + bh / 2 + 3); g.textAlign = 'left'; }
          x += ww;
        }
        // pitch / voicing track
        g.font = '500 9.5px "JetBrains Mono", monospace';
        const ty0 = by + bh + 26, ty1 = H - 18, fr = r.frames, n = fr.length;
        g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText('F0 per frame', x0, ty0 - 8);
        const fy = (f) => ty1 - (Math.log(f / 50) / Math.log(8)) * (ty1 - ty0);
        for (const f of [100, 200, 400]) { g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(x0 + 34, fy(f), x1 - x0 - 34, 1); g.fillStyle = 'rgba(255,255,255,.35)'; g.fillText(f + '', x0, fy(f) + 3); }
        const bw = (x1 - x0 - 34) / n;
        fr.forEach((f, i) => {
          const xx = x0 + 34 + i * bw;
          if (f.voiced && st.lpc.excite !== 'whisper') {
            const f0 = st.lpc.excite === 'mono' ? 110 : f.f0;
            g.fillStyle = '#4de1ff'; g.fillRect(xx, fy(f0) - 1.5, Math.max(1.5, bw - 0.5), 3);
          } else if (f.g > 0.002) { g.fillStyle = 'rgba(255,200,87,.35)'; g.fillRect(xx, ty1 - 4, Math.max(1, bw - 0.5), 4); }
        });
        g.fillStyle = 'rgba(255,200,87,.7)'; g.textAlign = 'right'; g.fillText('▬ noise frames', x1, ty0 - 8); g.textAlign = 'left';
      }

      function drawGauge(dt) {
        const { ctx: g, w, h: H } = U.fit(gaugeCv);
        g.clearRect(0, 0, w, H);
        const target = st.r ? D.clamp(Math.log(st.r.kbps / 0.5) / Math.log(1024), 0, 1) : 0.5;
        st.needle += (target - st.needle) * Math.min(1, dt * 5);
        const cx = w / 2, R = Math.min(w * 0.36, H * 0.5), cy = 16 + R;
        const a0 = Math.PI * 0.85, a1 = Math.PI * 2.15, ang = (t) => a0 + (a1 - a0) * t;
        g.lineCap = 'round';
        g.lineWidth = 12; g.strokeStyle = 'rgba(255,255,255,.06)';
        g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
        const grd = g.createLinearGradient(cx - R, 0, cx + R, 0);
        grd.addColorStop(0, '#5ef2a0'); grd.addColorStop(0.5, '#b99cff'); grd.addColorStop(1, '#ff5fa2');
        g.strokeStyle = grd; g.shadowColor = th.ear; g.shadowBlur = 14;
        g.beginPath(); g.arc(cx, cy, R, a0, ang(st.needle)); g.stroke(); g.shadowBlur = 0;
        g.lineCap = 'butt';
        g.font = '500 9.5px "JetBrains Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
        [0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512].forEach((v, i) => {
          const a = ang(i / 10), c = Math.cos(a), s = Math.sin(a);
          g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 1;
          g.beginPath(); g.moveTo(cx + c * (R - 12), cy + s * (R - 12)); g.lineTo(cx + c * (R - 18), cy + s * (R - 18)); g.stroke();
          g.fillStyle = 'rgba(255,255,255,.4)'; g.fillText(v < 1 ? '.5' : v, cx + c * (R - 30), cy + s * (R - 30));
        });
        // era markers
        ERAS.forEach((e) => {
          const a = ang(Math.log(e.nominal / 0.5) / Math.log(1024)), c = Math.cos(a), s = Math.sin(a);
          const on = e.id === st.era;
          g.fillStyle = on ? '#fff' : 'rgba(255,255,255,.35)';
          g.beginPath(); g.arc(cx + c * (R + 14), cy + s * (R + 14), on ? 3.5 : 2.5, 0, 7); g.fill();
        });
        // needle
        const a = ang(st.needle);
        g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * 18, cy + Math.sin(a) * 18); g.lineTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6)); g.stroke();
        g.fillStyle = th.ear; g.beginPath(); g.arc(cx, cy, 5, 0, 7); g.fill();
        const kb = st.r ? st.r.kbps : 0;
        const fsz = Math.max(20, R * 0.26);
        g.fillStyle = th.ink; g.font = `600 ${fsz}px "JetBrains Mono", monospace`;
        g.fillText(fmtK(kb), cx, cy + R * 0.3);
        g.fillStyle = th.dim; g.font = '500 10.5px "JetBrains Mono", monospace';
        g.fillText('kbit / s', cx, cy + R * 0.3 + fsz * 0.85);
        g.textBaseline = 'alphabetic'; g.textAlign = 'left';
      }

      ctx.frame((t, dt) => {
        drawGauge(dt);
        drawWave();
        drawOverlay(ovA, false);
        drawOverlay(ovB, true);
      });
      let lastW = 0;
      ctx.frame(() => { const w = qCv.getBoundingClientRect().width; if (w !== lastW) { lastW = w; drawQ(); } });

      setEra('pcm');
    },
  });

  function fmtK(v) { return v >= 100 ? Math.round(v) + '' : v >= 10 ? v.toFixed(0) : v.toFixed(1); }
  function qualCol(f) {
    f = Math.max(0, Math.min(1, f));
    return `hsl(${Math.round(f * 140)}, 85%, 62%)`;
  }
})();
