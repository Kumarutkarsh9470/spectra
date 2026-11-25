/* SPECTRA · A1 Voice Space — live/clip spectrogram, LPC envelope, z-plane poles, vowel chart quest. */
(function () {
  const SL = window.SL, D = SL.dsp, U = SL.ui, h = SL.h;
  const SR = 16000, HOP = 80, ROWS = 256, LIVE_COLS = 480, LPC_N = 512, PITCH_N = 640, NF = 2048;
  const FC = ['#ffffff', '#7cf3ff', '#b8ff8a']; // F1, F2, F3

  /* ---------- helpers ---------- */
  function frameAt(x, center, L) {
    const f = new Float32Array(L), s = center - (L >> 1);
    for (let i = 0; i < L; i++) { const j = s + i; f[i] = j >= 0 && j < x.length ? x[j] : 0; }
    return f;
  }
  const bufs = {};
  function fftBuf(n) { return bufs[n] || (bufs[n] = { re: new Float64Array(n), im: new Float64Array(n) }); }

  /** One spectrogram column: ROWS dB values spanning 0..8 kHz. */
  function column(x, center, L, type, out) {
    const n = Math.max(512, D.nextPow2(L)), { re, im } = fftBuf(n), w = D.win(type, L, false);
    re.fill(0); im.fill(0);
    const s = center - (L >> 1);
    let ws = 0;
    for (let i = 0; i < L; i++) { const j = s + i; re[i] = j >= 0 && j < x.length ? x[j] * w[i] : 0; ws += w[i]; }
    D.fft(re, im);
    const norm = 4 / (ws * ws || 1), B = n / 2;
    for (let r = 0; r < ROWS; r++) {
      const b0 = Math.floor((r / ROWS) * B), b1 = Math.max(b0 + 1, Math.floor(((r + 1) / ROWS) * B));
      let m = 0;
      for (let b = b0; b < b1; b++) { const p = re[b] * re[b] + im[b] * im[b]; if (p > m) m = p; }
      out[r] = 10 * Math.log10(m * norm + 1e-14);
    }
  }

  /** Full analysis of one instant. */
  function analyze(x, center, P) {
    const L = P.L, fr = frameAt(x, center, L);
    const re = new Float64Array(NF), im = new Float64Array(NF), w = D.win(P.type, L, false);
    let ws = 0;
    for (let i = 0; i < L; i++) { re[i] = (fr[i] - 0.97 * (i ? fr[i - 1] : 0)) * w[i]; ws += w[i]; }
    D.fft(re, im);
    const spec = new Float32Array(NF / 2 + 1), norm = 4 / (ws * ws || 1);
    for (let k = 0; k <= NF / 2; k++) spec[k] = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) * norm + 1e-14);
    const lf = frameAt(x, center, LPC_N), lp = D.lpc(lf, P.order);
    const env = D.lpcEnvelope(lp.a, lp.g / Math.sqrt(LPC_N * 0.4), 513);
    const pi = D.pitch(frameAt(x, center, PITCH_N), SR, 60, 420);
    const rms = D.rms(lf);
    const poles = D.lpcPoles(lp.a);
    const forms = D.formants(lp.a, SR, { minF: 200, maxBw: 500 });
    return { spec, env, f0: pi.f0, conf: pi.conf, rms, poles, forms };
  }

  /* ---------- lab ---------- */
  SL.lab({
    id: 'voice', side: 'ear', code: 'A1',
    title: 'Voice Space',
    tagline: 'Your voice, decoded live.',
    syllabus: ['SAP M1 spectrogram', 'SAP M3 source–filter', 'SAP M5 LPC'],
    concepts: [
      { key: 'tradeoff', label: 'Time ↔ frequency', line: 'Short windows resolve time but smear frequency; long windows resolve harmonics but blur events (Δt·Δf ≥ const).', hint: 'Try both extreme windows', math: ['fourier', 'sampling'] },
      { key: 'leakage', label: 'Leakage', line: 'A rectangular window’s hard edges spray energy into tall sidelobes; tapered windows trade a wider main lobe for far less leakage.', hint: 'Use a hard-edged window', math: ['fourier', 'filter'] },
      { key: 'harmonics', label: 'Harmonics ≠ formants', line: 'Narrowband analysis shows harmonics at k·F0 from the source; the peaks of their envelope are the formants of the tract.', hint: 'Long window on a vowel', math: ['fourier'] },
      { key: 'lpcorder', label: 'LPC order', line: 'Too few poles miss formants; too many chase single harmonics. Rule of thumb: p ≈ 2 + fs/1000.', hint: 'Sweep the LPC order', math: ['predict'] },
      { key: 'poles', label: 'Poles = formants', line: 'Each formant is a conjugate pole pair of 1/A(z): its angle gives frequency, its closeness to the circle gives a narrow bandwidth.', hint: 'Click a pole', math: ['predict', 'filter'] },
      { key: 'vowelspace', label: 'Vowel space', line: 'Vowels are points in F1–F2 space: F1 rises as the jaw opens, F2 rises as the tongue moves forward.', hint: 'Hit a quest vowel', math: ['percept'] },
      { key: 'pitch', label: 'Pitch is the source', line: 'F0 glides while the formants stay put: pitch belongs to the vocal folds, vowel quality to the tract.', hint: 'Glide your pitch', math: ['predict', 'percept'] },
    ],
    build,
    thumb(g, w, H, t) {
      const f1 = 0.28 + 0.12 * Math.sin(t * 0.9), f2 = 0.62 + 0.18 * Math.sin(t * 0.6 + 1);
      const step = 5;
      for (let x = 0; x < w; x += step) {
        const tt = t * 1.2 - x / w * 3;
        const f0 = 0.055 + 0.012 * Math.sin(tt);
        for (let k = 1; k * f0 < 1; k++) {
          const y = k * f0, e = Math.exp(-((y - f1) ** 2) / 0.006) + 0.8 * Math.exp(-((y - f2) ** 2) / 0.008) + 0.15;
          g.fillStyle = SL.img.cmapCss('magma', Math.min(1, e * (0.55 + 0.45 * Math.sin(tt * 2 + x * 0.05) ** 2)));
          g.fillRect(x, H - 8 - y * (H - 16), step - 1, 2);
        }
      }
      [f1, f2].forEach((f, i) => {
        g.fillStyle = FC[i]; g.shadowColor = FC[i]; g.shadowBlur = 8;
        g.beginPath(); g.arc(w - 18, H - 8 - f * (H - 16), 3, 0, 7); g.fill();
      });
      g.shadowBlur = 0;
    },
  });

  function build(ctx) {
    const th = U.theme();
    const S = {
      mode: 'clip', winMs: 25, type: 'hann', range: 70, cmap: 'magma', order: 18,
      clip: null, cursor: 0.45, play: null, playOff: 0, scrubbed: false,
      mic: null, live: { db: new Float32Array(LIVE_COLS * ROWS).fill(-140), tr: new Array(LIVE_COLS).fill(null), head: 0, peak: -40 },
      cur: null, curKey: '', selPole: null,
      seenShort: false, seenLong: false, seenLow: false, seenHigh: false, touchedWin: false,
      f0hist: [], trail: [],
      quest: { target: 4, hold: 0, score: 0, flash: 0 }, vScale: 1,
    };
    const P = () => ({ L: Math.max(32, Math.round((S.winMs * SR) / 1000)), type: S.type, order: S.order });

    /* ---------- stage ---------- */
    const cvSpec = U.canvas(10, 10, { cls: 'vs-spec' });
    const cvF0 = U.canvas(10, 10, { cls: 'vs-f0' });
    const cvSp = U.canvas(10, 10, { cls: 'vs-panel' });
    const cvZ = U.canvas(10, 10, { cls: 'vs-panel' });
    const cvV = U.canvas(10, 10, { cls: 'vs-panel' });
    const live = h('div.vs-live', null, h('i'), 'LIVE');
    const specCard = U.card('Spectrogram · 0–8 kHz · scrub ⇄ · click ▶', h('div.vs-spec-wrap', null, cvSpec, live), cvF0,
      h('div.legend.vs-legend', null,
        h('span', null, h('i', { style: { background: FC[0] } }), 'F1'),
        h('span', null, h('i', { style: { background: FC[1] } }), 'F2'),
        h('span', null, h('i', { style: { background: FC[2] } }), 'F3'),
        h('span', null, h('i', { style: { background: th.warn } }), 'F0')));
    specCard.classList.add('vs-spec-card');
    ctx.stage.append(specCard,
      h('div.vs-row', null,
        U.card('Spectrum · LPC envelope', cvSp),
        U.card('z-plane · 1/A(z)', cvZ),
        U.card('Vowel space · F1 × F2', cvV)));

    /* ---------- rail ---------- */
    const modeSeg = U.seg({
      label: 'Input', options: [['clip', 'Clip'], ['live', '● Live mic']], value: 'clip',
      onChange: (v) => setMode(v),
    });
    const src = U.audioSource({
      label: 'Clip', sr: SR, maxSec: 4,
      onAudio: (x) => { setMode('clip', true); loadClip(x); },
    });
    const bPlay = U.button({ icon: 'play', label: 'Play', kind: 'primary', onClick: () => togglePlay() });
    ctx.rail.append(U.group('Input', modeSeg.el, src.el, h('div.btn-row', null, bPlay)));

    const sWin = U.slider({
      label: 'Window', min: 4, max: 64, step: 1, value: S.winMs, log: true, unit: 'ms', fmt: (v) => Math.round(v),
      onInput: (v) => {
        S.winMs = v; S.touchedWin = true;
        if (v <= 8) S.seenShort = true;
        if (v >= 40) S.seenLong = true;
        if (S.seenShort && S.seenLong) ctx.discover('tradeoff');
        dirtySpec();
      },
    });
    const sType = U.seg({
      label: 'Shape', options: [['rect', 'Rect'], ['hann', 'Hann'], ['hamming', 'Hamming']], value: S.type,
      onChange: (v) => { S.type = v; if (v === 'rect') ctx.discover('leakage'); dirtySpec(); },
    });
    const sOrd = U.slider({
      label: 'LPC order p', min: 2, max: 40, step: 2, value: S.order, fmt: (v) => Math.round(v),
      onInput: (v) => {
        S.order = v;
        if (v <= 6) S.seenLow = true;
        if (v >= 30) S.seenHigh = true;
        if (S.seenLow && S.seenHigh) ctx.discover('lpcorder');
        dirtyTracks();
      },
    });
    ctx.rail.append(U.group('Analysis', sWin.el, sType.el, sOrd.el));

    const sRange = U.slider({ label: 'Dynamic range', min: 30, max: 100, step: 1, value: S.range, unit: 'dB', onInput: (v) => { S.range = v; S.imgDirty = true; } });
    const sMap = U.seg({ label: 'Colour', options: [['magma', 'Magma'], ['viridis', 'Viridis'], ['ice', 'Ice'], ['gray', 'Gray']], value: S.cmap, onChange: (v) => { S.cmap = v; S.imgDirty = true; } });
    ctx.rail.append(U.group('Display', sRange.el, sMap.el));

    const stF0 = U.stat('F0', 'Hz'), stF1 = U.stat('F1', 'Hz'), stF2 = U.stat('F2', 'Hz'), stV = U.stat('Voicing', '%', { bar: true });
    stF0.color(th.warn); stF1.color(FC[0]); stF2.color(FC[1]);
    ctx.rail.append(U.group('Now', h('div.stat-grid', null, stF0.el, stV.el, stF1.el, stF2.el)));

    const qIpa = h('div.vs-q-ipa'), qWord = h('div.vs-q-word'), qScore = h('div.vs-q-score');
    const sScale = U.slider({ label: 'Speaker scale', min: 0.8, max: 1.4, step: 0.01, value: 1, fmt: (v) => '×' + v.toFixed(2), onInput: (v) => (S.vScale = v) });
    const bSkip = U.button({ icon: 'dice', label: 'Next', kind: 'ghost', onClick: () => nextTarget() });
    ctx.rail.append(U.group('Vowel quest', h('div.vs-quest', null, qIpa, h('div', null, qWord, qScore), bSkip), sScale.el));
    function paintQuest() {
      const v = SL.audio.VOWELS[S.quest.target];
      qIpa.textContent = v.ipa; qWord.textContent = v.word; qScore.textContent = '★ ' + S.quest.score;
    }
    function nextTarget() {
      let n;
      do n = (Math.random() * SL.audio.VOWELS.length) | 0; while (n === S.quest.target);
      S.quest.target = n; S.quest.hold = 0; paintQuest();
    }
    paintQuest();

    /* ---------- clip ---------- */
    const off = document.createElement('canvas'), og = off.getContext('2d');
    let specTimer = null, trackTimer = null;
    function dirtySpec() { clearTimeout(specTimer); specTimer = setTimeout(() => { computeClipSpec(); }, 60); S.curKey = ''; }
    function dirtyTracks() { clearTimeout(trackTimer); trackTimer = setTimeout(() => startTracks(), 80); S.curKey = ''; }
    ctx.cleanup(() => { clearTimeout(specTimer); clearTimeout(trackTimer); });

    function loadClip(x) {
      if (S.play) { S.play.stop(); S.play = null; }
      const T = Math.floor(x.length / HOP) + 1;
      S.clip = { x, T, db: null, max: -20, tr: new Array(T).fill(undefined), job: 0, dur: x.length / SR };
      S.cursor = Math.min(S.cursor, S.clip.dur * 0.98);
      computeClipSpec();
      startTracks();
    }
    function computeClipSpec() {
      const c = S.clip;
      if (!c) return;
      const { L, type } = P(), col = new Float32Array(ROWS), db = new Float32Array(c.T * ROWS);
      let mx = -200;
      for (let t = 0; t < c.T; t++) {
        column(c.x, t * HOP, L, type, col);
        for (let r = 0; r < ROWS; r++) { db[t * ROWS + r] = col[r]; if (col[r] > mx) mx = col[r]; }
      }
      c.db = db; c.max = mx; S.imgDirty = true;
    }
    function startTracks() { if (S.clip) { S.clip.tr.fill(undefined); S.clip.job = 0; } }
    function stepTracks(budgetMs) {
      const c = S.clip;
      if (!c || c.job >= c.T) return;
      const t0 = performance.now(), p = P();
      let pk = 0;
      for (let i = 0; i < c.x.length; i++) pk = Math.max(pk, Math.abs(c.x[i]));
      while (c.job < c.T && performance.now() - t0 < budgetMs) {
        const t = c.job;
        const lf = frameAt(c.x, t * HOP, LPC_N), rms = D.rms(lf);
        if (rms < pk * 0.02) c.tr[t] = null;
        else {
          const lp = D.lpc(lf, p.order), fm = D.formants(lp.a, SR, { minF: 200, maxBw: 500 });
          const pi = D.pitch(frameAt(c.x, t * HOP, PITCH_N), SR, 60, 420);
          const vo = pi.conf > 0.55;
          c.tr[t] = { f: vo ? fm.slice(0, 3).map((q) => q.f) : [], f0: vo ? pi.f0 : 0 };
        }
        c.job += 2;
      }
    }
    function renderClipImage() {
      const c = S.clip;
      if (!c || !c.db) return;
      if (off.width !== c.T || off.height !== ROWS) { off.width = c.T; off.height = ROWS; }
      const img = og.createImageData(c.T, ROWS), d = img.data, lut = SL.img.lut(S.cmap);
      const bot = c.max - S.range, sc = 255 / S.range;
      for (let t = 0; t < c.T; t++) for (let r = 0; r < ROWS; r++) {
        let v = ((c.db[t * ROWS + r] - bot) * sc) | 0;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        const o = ((ROWS - 1 - r) * c.T + t) * 4;
        d[o] = lut[v * 3]; d[o + 1] = lut[v * 3 + 1]; d[o + 2] = lut[v * 3 + 2]; d[o + 3] = 255;
      }
      og.putImageData(img, 0, 0);
    }
    function renderLiveImage() {
      const Lv = S.live;
      if (off.width !== LIVE_COLS || off.height !== ROWS) { off.width = LIVE_COLS; off.height = ROWS; }
      const img = og.createImageData(LIVE_COLS, ROWS), d = img.data, lut = SL.img.lut(S.cmap);
      const bot = Lv.peak - S.range, sc = 255 / S.range;
      for (let c = 0; c < LIVE_COLS; c++) {
        const src = ((Lv.head + c) % LIVE_COLS) * ROWS;
        for (let r = 0; r < ROWS; r++) {
          let v = ((Lv.db[src + r] - bot) * sc) | 0;
          v = v < 0 ? 0 : v > 255 ? 255 : v;
          const o = ((ROWS - 1 - r) * LIVE_COLS + c) * 4;
          d[o] = lut[v * 3]; d[o + 1] = lut[v * 3 + 1]; d[o + 2] = lut[v * 3 + 2]; d[o + 3] = 255;
        }
      }
      og.putImageData(img, 0, 0);
    }

    /* ---------- playback ---------- */
    function paintPlay() {
      const on = !!(S.play && S.play.playing);
      bPlay.innerHTML = '';
      bPlay.append(U.icon(on ? 'stop' : 'play', 16), h('span', null, on ? 'Stop' : 'Play'));
      bPlay.disabled = S.mode !== 'clip';
    }
    function playFrom(t0) {
      if (!S.clip) return;
      t0 = Math.max(0, Math.min(S.clip.dur - 0.05, t0));
      S.play = SL.audio.play(S.clip.x.subarray(Math.floor(t0 * SR)), SR, { onEnd: () => { S.play = null; paintPlay(); } });
      S.playOff = t0;
      paintPlay();
    }
    function togglePlay() {
      if (S.play && S.play.playing) { S.play.stop(); S.play = null; paintPlay(); return; }
      playFrom(0);
    }

    /* ---------- mode ---------- */
    async function setMode(m, silent) {
      if (m === S.mode && !(m === 'live' && !S.mic)) { if (silent) modeSeg.set(m, true); return; }
      if (m === 'live') {
        if (S.play) { S.play.stop(); S.play = null; }
        try {
          S.mic = await SL.audio.mic();
          if (!ctx.alive) return;
          S.mode = 'live';
          S.live.db.fill(-140); S.live.tr.fill(null);
        } catch (e) {
          U.toast({ title: 'Mic unavailable', line: 'Serve over https or localhost and allow access.', color: '#ff6b6b', icon: 'mic' });
          modeSeg.set('clip', true);
          return;
        }
      } else {
        SL.audio.stopMic(); S.mic = null; S.mode = 'clip';
      }
      modeSeg.set(S.mode, true);
      ctx.root.classList.toggle('vs-is-live', S.mode === 'live');
      S.curKey = ''; S.imgDirty = true; S.trail = [];
      paintPlay();
    }
    ctx.cleanup(() => { if (S.play) S.play.stop(); });
    paintPlay();

    /* ---------- spectrogram pointer (scrub / click-to-play) ---------- */
    U.pointer(cvSpec, (p) => {
      if (S.mode !== 'clip' || !S.clip) return;
      const t = Math.max(0, Math.min(1, p.u)) * S.clip.dur;
      if (p.type === 'down') { playFrom(t); S.scrubbed = true; }
      else if (p.type === 'move' && !(S.play && S.play.playing)) { S.cursor = t; S.scrubbed = true; }
    });

    /* ---------- z-plane pointer ---------- */
    U.pointer(cvZ, (p) => {
      if (p.type !== 'down' || !S.cur) return;
      const r = cvZ.getBoundingClientRect(), cx = r.width / 2, cy = r.height / 2, R = Math.min(r.width, r.height) * 0.4;
      const mx = p.u * r.width, my = p.v * r.height;
      let best = null, bd = 18;
      for (const z of S.cur.poles) {
        const d = Math.hypot(cx + z.re * R - mx, cy - z.im * R - my);
        if (d < bd) { bd = d; best = z; }
      }
      if (best) {
        const rad = Math.hypot(best.re, best.im), ang = Math.abs(Math.atan2(best.im, best.re));
        S.selPole = { f: (ang * SR) / (2 * Math.PI), bw: (-Math.log(rad) * SR) / Math.PI, r: rad, sign: Math.sign(best.im) || 1, ang, t: 4 };
        ctx.discover('poles');
      } else S.selPole = null;
    });

    /* ---------- per-frame ---------- */
    let lastLiveT = 0;
    ctx.frame((t, dt) => {
      const p = P();
      // --- acquire analysis frame
      if (S.mode === 'live' && S.mic) {
        const m = S.mic, need = Math.ceil((1400 * m.sr) / SR);
        const raw = Float32Array.from(m.frame(Math.min(need, m.analyser.fftSize)));
        const x = D.resample(raw, m.sr, SR);
        const center = x.length - 530;
        const Lv = S.live, col = new Float32Array(ROWS);
        column(x, center, p.L, p.type, col);
        let mx = -200;
        for (let r = 0; r < ROWS; r++) mx = Math.max(mx, col[r]);
        Lv.peak = Math.max(mx, Lv.peak - 0.08, -60);
        Lv.db.set(col, Lv.head * ROWS);
        S.cur = analyze(x, center, p);
        const voiced = S.cur.conf > 0.55 && S.cur.rms > 0.004;
        const silent = S.cur.rms < 0.002;
        Lv.tr[Lv.head] = silent ? null : { f: voiced ? S.cur.forms.slice(0, 3).map((q) => q.f) : [], f0: voiced ? S.cur.f0 : 0 };
        Lv.head = (Lv.head + 1) % LIVE_COLS;
        S.cur.voiced = voiced; S.cur.silent = silent;
        renderLiveImage();
        trackPitch(voiced, S.cur.f0, t);
      } else if (S.clip) {
        stepTracks(5);
        if (S.imgDirty) { renderClipImage(); S.imgDirty = false; }
        if (S.play && S.play.playing) { S.cursor = S.playOff + S.play.t; S.scrubbed = true; }
        const fi = Math.max(0, Math.min(S.clip.T - 1, Math.round((S.cursor * SR) / HOP)));
        const key = fi + '|' + p.L + p.type + p.order + '|' + S.clip.x.length;
        if (key !== S.curKey) {
          S.cur = analyze(S.clip.x, fi * HOP, p);
          let pk = 0;
          for (let i = 0; i < S.clip.x.length; i += 7) pk = Math.max(pk, Math.abs(S.clip.x[i]));
          S.cur.silent = S.cur.rms < pk * 0.02;
          S.cur.voiced = !S.cur.silent && S.cur.conf > 0.55;
          S.curKey = key;
          if (S.scrubbed) trackPitch(S.cur.voiced, S.cur.f0, t);
        }
      }
      if (S.cur && S.touchedWin && S.winMs >= 30 && S.cur.voiced) ctx.discover('harmonics');
      updateStats();
      drawSpec(t);
      drawF0();
      drawSpectrum();
      drawZ(t, dt);
      drawVowel(t, dt);
    });

    function trackPitch(voiced, f0, t) {
      if (voiced && f0 > 0) S.f0hist.push({ t, f0 });
      while (S.f0hist.length && t - S.f0hist[0].t > 4) S.f0hist.shift();
      if (S.f0hist.length > 8) {
        let a = Infinity, b = 0;
        for (const q of S.f0hist) { a = Math.min(a, q.f0); b = Math.max(b, q.f0); }
        if (b / a > 1.35) ctx.discover('pitch');
      }
    }

    function updateStats() {
      const c = S.cur;
      if (!c || c.silent) { stF0.set('—'); stF1.set('—'); stF2.set('—'); stV.set('0', '', 0); return; }
      stF0.set(c.voiced ? Math.round(c.f0) : '—');
      stF1.set(c.forms[0] ? Math.round(c.forms[0].f) : '—');
      stF2.set(c.forms[1] ? Math.round(c.forms[1].f) : '—');
      const v = Math.max(0, Math.min(1, c.conf));
      stV.set(Math.round(v * 100), '', v);
    }

    /* ---------- drawing ---------- */
    function freqGrid(g, x0, x1, y0, y1, vertical) {
      g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
      g.fillStyle = 'rgba(255,255,255,.4)'; g.font = '500 9.5px "JetBrains Mono", monospace';
      for (let f = 1000; f < 8000; f += 1000) {
        g.beginPath();
        if (vertical) { const y = y1 - ((y1 - y0) * f) / 8000; g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.fillText(f / 1000 + 'k', x0 + 4, y - 3); }
        else { const x = x0 + ((x1 - x0) * f) / 8000; g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); g.fillText(f / 1000 + 'k', x + 3, y1 - 4); }
      }
    }

    function trackEntries() {
      if (S.mode === 'live') {
        const Lv = S.live, out = [];
        for (let c = 0; c < LIVE_COLS; c++) out.push(Lv.tr[(Lv.head + c) % LIVE_COLS]);
        return out;
      }
      return S.clip ? S.clip.tr : [];
    }

    function drawSpec(t) {
      const { ctx: g, w, h: H } = U.fit(cvSpec);
      g.fillStyle = '#05060a'; g.fillRect(0, 0, w, H);
      if (off.width > 1 && (S.clip || S.mode === 'live')) { g.imageSmoothingEnabled = true; g.drawImage(off, 0, 0, w, H); }
      freqGrid(g, 0, w, 0, H, true);
      // formant overlays
      const tr = trackEntries(), n = tr.length;
      for (let i = 0; i < n; i++) {
        const e = tr[i];
        if (!e) continue;
        const x = ((i + 0.5) / n) * w;
        for (let k = 0; k < e.f.length; k++) {
          const y = H - (e.f[k] / 8000) * H;
          g.fillStyle = FC[k]; g.globalAlpha = 0.85;
          g.fillRect(x - 1, y - 1, 2.2, 2.2);
        }
      }
      g.globalAlpha = 1;
      // cursor / playhead
      if (S.mode === 'clip' && S.clip) {
        const x = (S.cursor / S.clip.dur) * w;
        const playing = S.play && S.play.playing;
        g.strokeStyle = playing ? th.ear : 'rgba(255,255,255,.75)'; g.lineWidth = playing ? 2 : 1;
        g.shadowColor = th.ear; g.shadowBlur = playing ? 12 : 0;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.shadowBlur = 0;
        g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '500 10px "JetBrains Mono", monospace';
        g.fillText(S.cursor.toFixed(2) + ' s', Math.min(w - 50, x + 6), 14);
        g.fillText(S.winMs.toFixed(0) + ' ms ' + S.type, w - 110, H - 8);
      } else if (S.mode === 'live') {
        g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '500 10px "JetBrains Mono", monospace';
        g.fillText(S.winMs.toFixed(0) + ' ms ' + S.type, w - 110, H - 8);
      }
    }

    function drawF0() {
      const { ctx: g, w, h: H } = U.fit(cvF0);
      g.fillStyle = '#05060a'; g.fillRect(0, 0, w, H);
      const lo = Math.log(60), hi = Math.log(420), Y = (f) => H - 6 - ((Math.log(f) - lo) / (hi - lo)) * (H - 12);
      g.strokeStyle = 'rgba(255,255,255,.06)'; g.fillStyle = 'rgba(255,255,255,.35)'; g.font = '500 9px "JetBrains Mono", monospace';
      for (const f of [100, 200, 400]) { const y = Y(f); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.fillText(f, 4, y - 2); }
      g.fillText('F0 Hz', w - 40, 11);
      const tr = trackEntries(), n = tr.length;
      g.fillStyle = th.warn; g.shadowColor = th.warn; g.shadowBlur = 6;
      for (let i = 0; i < n; i++) {
        const e = tr[i];
        if (!e || !e.f0) continue;
        g.beginPath(); g.arc(((i + 0.5) / n) * w, Y(e.f0), 1.6, 0, 7); g.fill();
      }
      g.shadowBlur = 0;
      if (S.mode === 'clip' && S.clip) {
        const x = (S.cursor / S.clip.dur) * w;
        g.strokeStyle = 'rgba(255,255,255,.4)'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      }
    }

    function drawSpectrum() {
      const { ctx: g, w, h: H } = U.fit(cvSp);
      g.clearRect(0, 0, w, H);
      const L = 30, R = w - 10, T = 30, B = H - 22;
      const c = S.cur;
      g.strokeStyle = 'rgba(255,255,255,.07)'; g.fillStyle = 'rgba(255,255,255,.4)'; g.font = '500 9.5px "JetBrains Mono", monospace';
      for (let f = 0; f <= 8000; f += 2000) { const x = L + ((R - L) * f) / 8000; g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke(); g.fillText(f ? f / 1000 + 'k' : '0', x - 6, H - 8); }
      if (!c) return;
      if (c.silent) {
        g.fillStyle = 'rgba(255,255,255,.25)'; g.font = '500 11px "JetBrains Mono", monospace'; g.textAlign = 'center';
        g.fillText('· silence ·', (L + R) / 2, (T + B) / 2); g.textAlign = 'left';
        return;
      }
      let mx = -200;
      for (let k = 0; k < c.spec.length; k++) mx = Math.max(mx, c.spec[k]);
      const top = mx + 6, bot = top - 80, Y = (v) => B - ((v - bot) / (top - bot)) * (B - T);
      for (let d = 0; d <= 80; d += 20) { const y = Y(top - d); g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke(); g.fillText(d ? '-' + d : '0', 2, y + 3); }
      // spectrum (filled)
      const n = c.spec.length;
      g.beginPath(); g.moveTo(L, B);
      for (let k = 0; k < n; k += 1) g.lineTo(L + ((R - L) * k) / (n - 1), Math.min(B, Y(c.spec[k])));
      g.lineTo(R, B); g.closePath();
      const grd = g.createLinearGradient(0, T, 0, B);
      grd.addColorStop(0, 'rgba(160,166,187,.35)'); grd.addColorStop(1, 'rgba(160,166,187,.02)');
      g.fillStyle = grd; g.fill();
      g.beginPath();
      for (let k = 0; k < n; k++) { const x = L + ((R - L) * k) / (n - 1), y = Math.min(B, Y(c.spec[k])); k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = 'rgba(210,214,228,.7)'; g.lineWidth = 1; g.stroke();
      // harmonic markers
      if (c.voiced && c.f0 > 0) {
        g.strokeStyle = th.warn; g.globalAlpha = 0.55; g.lineWidth = 1;
        for (let k = 1; k * c.f0 < 8000; k++) { const x = L + ((R - L) * k * c.f0) / 8000; g.beginPath(); g.moveTo(x, T - 8); g.lineTo(x, T - 2); g.stroke(); }
        g.globalAlpha = 1;
      }
      // LPC envelope, aligned to spectrum peak
      if (!c.silent) {
        let em = -200;
        for (let k = 0; k < c.env.length; k++) em = Math.max(em, c.env[k]);
        const off2 = mx + 3 - em;
        g.beginPath();
        for (let k = 0; k < c.env.length; k++) { const x = L + ((R - L) * k) / (c.env.length - 1), y = Math.min(B, Y(c.env[k] + off2)); k ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.strokeStyle = th.ear; g.lineWidth = 2.2; g.shadowColor = th.ear; g.shadowBlur = 10; g.stroke(); g.shadowBlur = 0;
        c.forms.slice(0, 3).forEach((q, i) => {
          const x = L + ((R - L) * q.f) / 8000;
          g.setLineDash([2, 3]); g.strokeStyle = FC[i]; g.globalAlpha = 0.6;
          g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
          g.fillStyle = FC[i]; g.font = '600 10px "JetBrains Mono", monospace'; g.fillText('F' + (i + 1), x + 3, T + 10 + i * 12);
        });
      }
      g.fillStyle = 'rgba(255,255,255,.45)'; g.font = '500 9.5px "JetBrains Mono", monospace';
      g.fillText('dB', 4, T - 10);
      g.fillStyle = th.ear; g.fillText('p=' + S.order, R - 36, T - 10);
    }

    function drawZ(t, dt) {
      const { ctx: g, w, h: H } = U.fit(cvZ);
      g.clearRect(0, 0, w, H);
      const cx = w / 2, cy = H / 2, R = Math.min(w, H) * 0.4;
      // rings + axes
      const rg = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.05);
      rg.addColorStop(0, 'rgba(255,95,162,0.0)'); rg.addColorStop(1, 'rgba(255,95,162,0.07)');
      g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx - R * 1.15, cy); g.lineTo(cx + R * 1.15, cy); g.moveTo(cx, cy - R * 1.15); g.lineTo(cx, cy + R * 1.15); g.stroke();
      g.setLineDash([2, 4]); g.beginPath(); g.arc(cx, cy, R * 0.5, 0, 7); g.stroke(); g.setLineDash([]);
      g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1.4; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.4)'; g.font = '500 9px "JetBrains Mono", monospace'; g.textAlign = 'center';
      for (let f = 0; f <= 8000; f += 2000) {
        const a = (2 * Math.PI * f) / SR;
        g.fillText(f ? f / 1000 + 'k' : '0', cx + Math.cos(a) * (R + 14), cy - Math.sin(a) * (R + 14) + 3);
        g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.96, cy - Math.sin(a) * R * 0.96); g.lineTo(cx + Math.cos(a) * R * 1.04, cy - Math.sin(a) * R * 1.04); g.stroke();
      }
      g.textAlign = 'left';
      const c = S.cur;
      if (c && !c.silent) {
        const formSet = c.forms.slice(0, 3);
        for (const z of c.poles) {
          const x = cx + z.re * R, y = cy - z.im * R;
          const fi = formSet.findIndex((q) => Math.abs(q.z.re - z.re) < 1e-9 && Math.abs(Math.abs(q.z.im) - Math.abs(z.im)) < 1e-9);
          const col = fi >= 0 ? FC[fi] : 'rgba(170,175,195,.55)', s = fi >= 0 ? 5.5 : 3.5;
          g.strokeStyle = col; g.lineWidth = fi >= 0 ? 2 : 1.3;
          if (fi >= 0) { g.shadowColor = col; g.shadowBlur = 10; }
          g.beginPath(); g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s); g.stroke();
          g.shadowBlur = 0;
          if (fi >= 0 && z.im > 0) { g.fillStyle = col; g.font = '600 10px "JetBrains Mono", monospace'; g.fillText('F' + (fi + 1), x + 7, y - 6); }
        }
      }
      if (S.selPole) {
        const sp = S.selPole, x = cx + Math.cos(sp.ang) * sp.r * R, y = cy - sp.sign * Math.sin(sp.ang) * sp.r * R;
        g.strokeStyle = th.ear; g.lineWidth = 1.2;
        g.beginPath(); g.arc(x, y, 11, 0, 7); g.stroke();
        g.setLineDash([3, 3]); g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke(); g.setLineDash([]);
        const txt = [Math.round(sp.f) + ' Hz', 'B ' + Math.round(sp.bw) + ' Hz', '|p| ' + sp.r.toFixed(3)];
        const bx = Math.min(w - 96, x + 14), by = Math.max(6, Math.min(H - 52, y - 20));
        g.fillStyle = 'rgba(8,9,14,.88)'; g.strokeStyle = 'rgba(255,95,162,.5)';
        g.beginPath(); g.roundRect(bx, by, 88, 46, 7); g.fill(); g.stroke();
        g.fillStyle = '#fff'; g.font = '500 10px "JetBrains Mono", monospace';
        txt.forEach((s, i) => g.fillText(s, bx + 8, by + 14 + i * 13));
      }
      g.fillStyle = 'rgba(255,255,255,.35)'; g.font = '500 9px "JetBrains Mono", monospace';
      g.fillText('|z|=1', cx + R * 0.72, cy + R * 0.82);
    }

    function drawVowel(t, dt) {
      const { ctx: g, w, h: H } = U.fit(cvV);
      g.clearRect(0, 0, w, H);
      const L = 34, Rr = w - 12, T = 26, B = H - 24;
      const x2 = (F2) => L + ((Math.log(2800) - Math.log(F2)) / (Math.log(2800) - Math.log(600))) * (Rr - L);
      const y1 = (F1) => T + ((Math.log(F1) - Math.log(200)) / (Math.log(1000) - Math.log(200))) * (B - T);
      g.strokeStyle = 'rgba(255,255,255,.06)'; g.fillStyle = 'rgba(255,255,255,.38)'; g.font = '500 9px "JetBrains Mono", monospace';
      for (const f of [2500, 1500, 1000, 700]) { const x = x2(f); g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke(); g.fillText(f, x - 10, H - 9); }
      for (const f of [300, 500, 700, 900]) { const y = y1(f); g.beginPath(); g.moveTo(L, y); g.lineTo(Rr, y); g.stroke(); g.fillText(f, 3, y + 3); }
      g.fillText('F1', 6, T - 10); g.fillText('← F2', Rr - 30, T - 10);
      g.fillStyle = 'rgba(255,255,255,.22)'; g.font = '500 9px Inter, sans-serif';
      g.fillText('front', L + 4, B - 6); g.fillText('back', Rr - 26, B - 6);
      const sc = S.vScale, V = SL.audio.VOWELS, q = S.quest;
      V.forEach((v, i) => {
        const x = x2(v.F2 * sc), y = y1(v.F1 * sc), rx = Math.abs(x2(v.F2 * sc * 0.9) - x), ry = Math.abs(y1(v.F1 * sc * 1.11) - y);
        const isT = i === q.target;
        const grd = g.createRadialGradient(x, y, 1, x, y, Math.max(rx, ry));
        grd.addColorStop(0, isT ? 'rgba(255,95,162,.35)' : 'rgba(255,255,255,.09)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 7); g.fill();
        if (isT) {
          const pulse = 1 + 0.08 * Math.sin(t * 5);
          g.strokeStyle = th.ear; g.lineWidth = 1.5; g.shadowColor = th.ear; g.shadowBlur = 12;
          g.beginPath(); g.ellipse(x, y, rx * pulse, ry * pulse, 0, 0, 7); g.stroke(); g.shadowBlur = 0;
          if (q.hold > 0) { g.lineWidth = 3; g.beginPath(); g.ellipse(x, y, rx + 5, ry + 5, 0, -Math.PI / 2, -Math.PI / 2 + (q.hold / 0.5) * Math.PI * 2); g.stroke(); }
        }
        g.fillStyle = isT ? '#fff' : 'rgba(255,255,255,.6)'; g.font = `${isT ? 700 : 500} 15px "Space Grotesk", sans-serif`; g.textAlign = 'center';
        g.fillText(v.ipa, x, y + 5); g.textAlign = 'left';
      });
      // live point + trail
      const c = S.cur;
      let pt = null;
      if (c && !c.silent && c.forms.length >= 2) pt = { F1: c.forms[0].f, F2: c.forms[1].f };
      const active = S.mode === 'live' || (S.play && S.play.playing) || S.scrubbed;
      if (pt && active) { S.trail.push({ ...pt, a: 1 }); if (S.trail.length > 50) S.trail.shift(); }
      for (const p of S.trail) p.a -= dt * 0.7;
      S.trail = S.trail.filter((p) => p.a > 0);
      g.save(); g.beginPath(); g.rect(L - 6, T - 6, Rr - L + 12, B - T + 12); g.clip();
      g.strokeStyle = th.ear; g.lineWidth = 1.5;
      for (let i = 1; i < S.trail.length; i++) {
        const a = S.trail[i - 1], b = S.trail[i];
        g.globalAlpha = Math.max(0, b.a) * 0.7;
        g.beginPath(); g.moveTo(x2(a.F2), y1(a.F1)); g.lineTo(x2(b.F2), y1(b.F1)); g.stroke();
      }
      g.globalAlpha = 1;
      if (pt) {
        const x = x2(pt.F2), y = y1(pt.F1);
        if (x > L - 10 && x < Rr + 10 && y > T - 10 && y < B + 10) {
          g.fillStyle = '#fff'; g.shadowColor = th.ear; g.shadowBlur = 18;
          g.beginPath(); g.arc(x, y, 5.5, 0, 7); g.fill(); g.shadowBlur = 0;
          g.strokeStyle = th.ear; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 9, 0, 7); g.stroke();
        }
        g.restore();
        // quest scoring
        if (active) {
          const v = V[q.target];
          const dx = (Math.log(pt.F2) - Math.log(v.F2 * sc)) / 0.11, dy = (Math.log(pt.F1) - Math.log(v.F1 * sc)) / 0.11;
          if (dx * dx + dy * dy < 1.5) q.hold += dt;
          else q.hold = Math.max(0, q.hold - dt * 1.5);
          if (q.hold >= 0.5) {
            q.score++; q.flash = 1; ctx.discover('vowelspace'); nextTarget();
          }
        }
      } else { g.restore(); q.hold = Math.max(0, q.hold - dt * 1.5); }
      if (q.flash > 0) {
        q.flash -= dt * 1.5;
        g.fillStyle = `rgba(255,95,162,${Math.max(0, q.flash) * 0.18})`; g.fillRect(0, 0, w, H);
        g.fillStyle = `rgba(255,255,255,${Math.max(0, q.flash)})`; g.font = '700 26px "Space Grotesk", sans-serif'; g.textAlign = 'center';
        g.fillText('★ ' + q.score, w / 2, H / 2); g.textAlign = 'left';
      }
    }
  }
})();
