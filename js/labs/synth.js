/* SPECTRA · A2 Pole Instrument — play the z-plane: glottal source → all-pole tract, in real time. */
(function () {
  const SL = window.SL, D = SL.dsp, U = SL.ui, h = SL.h;
  const FS = 16000; // the z-plane is drawn at fs = 16 kHz (θ = π ↔ 8 kHz)
  const MAX_PAIRS = 8;

  /* ---------- the voice engine (runs inside an AudioWorklet, or a ScriptProcessor fallback) ---------- */
  function makeVoice(sr) {
    const MAX = 10;
    const y1 = new Float64Array(MAX), y2 = new Float64Array(MAX);
    const a1 = new Float64Array(MAX), a2 = new Float64Array(MAX), b0 = new Float64Array(MAX);
    let cur = [], tgt = [];
    let f0 = 120, f0T = 120, src = 'glottal', gate = 0, gateT = 0, vol = 0.7, mute = false, vib = true;
    let phase = 0, prevG = 0, seed = 22222, env = 0.05, agc = 1, t = 0;
    function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
    function ros(p) {
      const tp = (0.6 * 2.2) / 3.2, tn = 0.6 - tp;
      if (p < tp) return 0.5 * (1 - Math.cos((Math.PI * p) / tp));
      if (p < 0.6) return Math.cos((Math.PI * (p - tp)) / (2 * tn));
      return 0;
    }
    return {
      set(d) {
        if (d.pairs) {
          const P = d.pairs.slice(0, MAX).map((q) => ({ f: Math.max(30, q.f), bw: Math.max(q.bw, 2) }));
          if (P.length !== tgt.length) { cur = P.map((q) => ({ f: q.f, bw: q.bw })); y1.fill(0); y2.fill(0); }
          tgt = P;
        }
        if (d.f0 !== undefined) f0T = d.f0;
        if (d.src) src = d.src;
        if (d.gate !== undefined) gateT = d.gate ? 1 : 0;
        if (d.vol !== undefined) vol = d.vol;
        if (d.mute !== undefined) { if (d.mute && !mute) { y1.fill(0); y2.fill(0); } mute = d.mute; }
        if (d.vib !== undefined) vib = d.vib;
      },
      process(out) {
        const n = out.length, ns = cur.length;
        for (let i = 0; i < ns; i++) {
          cur[i].f *= Math.pow(tgt[i].f / cur[i].f, 0.22);
          cur[i].bw += (tgt[i].bw - cur[i].bw) * 0.22;
          const r = Math.min(0.9995, Math.exp((-Math.PI * cur[i].bw) / sr));
          const th = (2 * Math.PI * Math.min(cur[i].f, sr * 0.48)) / sr;
          a1[i] = 2 * r * Math.cos(th); a2[i] = -r * r;
          b0[i] = 1 - a1[i] - a2[i]; // unity DC gain per section (Klatt cascade)
        }
        for (let k = 0; k < n; k++) {
          t += 1 / sr;
          f0 += (f0T - f0) * 0.0015;
          const ff = vib ? f0 * (1 + 0.011 * Math.sin(2 * Math.PI * 5.3 * t)) : f0;
          gate += ((mute ? 0 : gateT) - gate) * 0.0025;
          phase += ff / sr;
          let wrap = false;
          if (phase >= 1) { phase -= 1; wrap = true; }
          let e;
          if (src === 'impulse') e = wrap ? 1 : 0;
          else if (src === 'whisper') e = (rnd() - 0.5) * 0.35;
          else {
            const g = ros(phase);
            e = (g - prevG) * (sr / ff) * 0.12;
            prevG = g;
            if (src === 'breathy') e = e * 0.55 + (rnd() - 0.5) * 0.14 * (0.35 + g);
          }
          let s = e;
          for (let i = 0; i < ns; i++) {
            const y = b0[i] * s + a1[i] * y1[i] + a2[i] * y2[i];
            y2[i] = y1[i]; y1[i] = y; s = y;
          }
          if (!(Math.abs(s) < 1e4)) { y1.fill(0); y2.fill(0); s = 0; }
          env += (Math.abs(s) - env) * 0.0008;
          const want = Math.min(400, Math.max(0.02, 0.12 / (env + 1e-6)));
          agc += (want - agc) * 0.0006;
          out[k] = Math.tanh(s * agc * vol * gate * 1.1);
        }
      },
    };
  }
  const WORKLET_SRC = `const makeVoice = ${makeVoice.toString()};
class SpectraPoleSynth extends AudioWorkletProcessor {
  constructor() { super(); this.v = makeVoice(sampleRate); this.port.onmessage = (e) => this.v.set(e.data); }
  process(inputs, outputs) { const o = outputs[0]; if (o && o[0]) { this.v.process(o[0]); for (let c = 1; c < o.length; c++) o[c].set(o[0]); } return true; }
}
registerProcessor('spectra-pole-synth', SpectraPoleSynth);`;

  /** Create (or reuse) the engine node for the shared AudioContext. Returns {node, send(d), analyser, dispose()} */
  async function createEngine() {
    const ac = SL.audio.ctx();
    const out = ac.createGain();
    out.gain.value = 0.9;
    const an = ac.createAnalyser();
    an.fftSize = 2048;
    let node, send, dispose;
    try {
      if (!ac.audioWorklet) throw new Error('no worklet');
      if (!ac._spectraPole) {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        ac._spectraPole = ac.audioWorklet.addModule(url);
      }
      await ac._spectraPole;
      node = new AudioWorkletNode(ac, 'spectra-pole-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      send = (d) => node.port.postMessage(d);
      dispose = () => { try { node.disconnect(); node.port.close(); } catch (e) {} };
    } catch (e) {
      const v = makeVoice(ac.sampleRate);
      node = ac.createScriptProcessor(1024, 0, 1);
      node.onaudioprocess = (ev) => v.process(ev.outputBuffer.getChannelData(0));
      send = (d) => v.set(d);
      dispose = () => { try { node.onaudioprocess = null; node.disconnect(); } catch (e) {} };
    }
    node.connect(out); out.connect(an); out.connect(ac.destination);
    return { send, analyser: an, dispose: () => { dispose(); try { out.disconnect(); an.disconnect(); } catch (e) {} } };
  }

  /* ---------- helpers ---------- */
  const presetPairs = (v) => [
    { f: v.F1, bw: 80 }, { f: v.F2, bw: 100 }, { f: v.F3, bw: 130 }, { f: 3500, bw: 200 },
  ];
  const SCHWA = { ipa: 'ə', F1: 500, F2: 1500, F3: 2500 };
  const polar = (f, bw) => ({ r: Math.exp((-Math.PI * bw) / FS), th: (2 * Math.PI * f) / FS });

  SL.lab({
    id: 'synth', side: 'ear', code: 'A2',
    title: 'Pole Instrument',
    tagline: 'Play the z-plane. Hear the vocal tract.',
    syllabus: ['SAP M3 source–filter', 'SAP M5 all-pole model'],
    concepts: [
      { key: 'resonance', label: 'Pole = resonance', line: 'Each conjugate pole pair is a resonance: its angle sets the formant frequency, f = θ·fs / 2π.', hint: 'Drag a pole', math: ['filter', 'fourier'] },
      { key: 'bandwidth', label: 'Radius = bandwidth', line: 'Pole radius sets bandwidth, B ≈ −(fs/π)·ln r: nearer the rim the peak sharpens and the tract rings longer.', hint: 'Slide a pole toward the rim', math: ['filter'] },
      { key: 'unstable', label: 'Instability', line: 'Outside |z| = 1 the impulse response grows forever: an all-pole filter is stable only if every pole lies inside.', hint: 'Push a pole outside', math: ['filter', 'predict'] },
      { key: 'sourcefilter', label: 'Source × filter', line: 'Pitch moves the harmonics, not the envelope: source and tract multiply, so their log spectra simply add.', hint: 'Sweep pitch while playing', math: ['fourier', 'filter'] },
      { key: 'whisper', label: 'Whisper', line: 'Swap the buzz for noise and the vowel survives: formants carry vowel identity, F0 only carries pitch.', hint: 'Swap the buzz for noise', math: ['noise', 'percept'] },
      { key: 'tract', label: 'Tract length', line: 'Every formant scales as 1/L: a 14 cm child tract lifts all resonances ~25% yet the vowel stays the same.', hint: 'Shrink the tract', math: ['percept'] },
      { key: 'sparse', label: 'Sparse harmonics', line: 'At high F0 the harmonics sit too far apart to trace the envelope: soprano vowels blur, and LPC fails.', hint: 'Raise the pitch a lot', math: ['sampling'] },
    ],
    build,
    thumb(g, w, H, t) {
      const cx = w * 0.3, cy = H / 2, R = H * 0.36;
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
      g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();
      const ps = [[0.94, 0.28 + 0.12 * Math.sin(t * 0.8)], [0.9, 0.75 + 0.25 * Math.sin(t * 0.55 + 1)], [0.86, 1.6]];
      g.strokeStyle = '#ff5fa2'; g.lineWidth = 1.8; g.shadowColor = '#ff5fa2'; g.shadowBlur = 8;
      for (const [r, a] of ps) for (const s of [1, -1]) {
        const x = cx + Math.cos(a) * r * R, y = cy - s * Math.sin(a) * r * R;
        g.beginPath(); g.moveTo(x - 4, y - 4); g.lineTo(x + 4, y + 4); g.moveTo(x + 4, y - 4); g.lineTo(x - 4, y + 4); g.stroke();
      }
      g.shadowBlur = 0;
      const x0 = w * 0.56, x1 = w - 12, top = H * 0.2, bot = H * 0.82;
      g.beginPath();
      for (let i = 0; i <= 60; i++) {
        const om = (i / 60) * Math.PI;
        let db = 0;
        for (const [r, a] of ps) db -= 20 * Math.log10(Math.hypot(Math.cos(om) - r * Math.cos(a), Math.sin(om) - r * Math.sin(a)) * Math.hypot(Math.cos(om) - r * Math.cos(a), Math.sin(om) + r * Math.sin(a)));
        const y = bot - Math.max(0, Math.min(1, (db + 10) / 50)) * (bot - top);
        const x = x0 + ((x1 - x0) * i) / 60;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = '#ff5fa2'; g.lineWidth = 2; g.stroke();
    },
  });

  function build(ctx) {
    const th = U.theme();
    const S = {
      pairs: presetPairs(SL.audio.VOWELS[4]), // ɑ
      L: 17.5, f0: 120, src: 'glottal', vib: true, vol: 0.7,
      latched: false, held: false, engine: null, starting: null,
      drag: null, hover: null, probe: null, dirty: true,
      f0min: Infinity, f0max: 0,
      srcSpec: null, srcKey: '',
    };
    const scale = () => 17.5 / S.L;
    const eff = () => S.pairs.map((p) => ({ f: p.f * scale(), bw: p.bw }));
    const unstable = () => S.pairs.some((p) => p.bw <= 0);
    const playing = () => S.latched || S.held;

    /* ---------- stage ---------- */
    const cvZ = U.canvas(10, 10, { cls: 'ps-zcv' });
    const cvH = U.canvas(10, 10, { cls: 'ps-hcv' });
    const cvScope = U.canvas(10, 10, { cls: 'ps-scope' });
    const cvS = U.canvas(10, 10, { cls: 'ps-strip' }), cvF = U.canvas(10, 10, { cls: 'ps-strip' }), cvO = U.canvas(10, 10, { cls: 'ps-strip' });
    const cvIR = U.canvas(10, 10, { cls: 'ps-ir' });
    const warn = h('div.ps-unstable', null, 'UNSTABLE');
    const zCard = U.card('z-plane · drag · dbl-click add · right-click remove', h('div.ps-zwrap', null, cvZ, warn));
    zCard.classList.add('ps-z');
    const hCard = U.card('|H(e^jω)| · harmonics sample the envelope', cvH, cvScope);
    const sCard = U.card('Source + Filter = Output  (dB)',
      h('div.ps-strips', null,
        h('div.ps-strip-w', null, cvS, h('span', null, 'SOURCE')), h('div.ps-op', null, '+'),
        h('div.ps-strip-w', null, cvF, h('span', null, 'FILTER')), h('div.ps-op', null, '='),
        h('div.ps-strip-w', null, cvO, h('span', null, 'OUTPUT'))));
    const irCard = U.card('Impulse response h[n]', cvIR);
    ctx.stage.append(h('div.ps-grid', null, zCard, hCard, sCard, irCard));

    /* ---------- rail ---------- */
    const bPlay = h('button.ps-play', { type: 'button' }, h('span.ps-play-ico'), h('span.ps-play-t', null, 'Play'), h('span.kbd', null, 'Space'));
    bPlay.addEventListener('click', () => { S.latched = !S.latched; gateChanged(); });
    const sF0 = U.slider({
      label: 'Pitch F0', min: 60, max: 600, value: S.f0, log: true, step: 1, unit: 'Hz', fmt: (v) => Math.round(v),
      onInput: (v) => { S.f0 = v; send({ f0: v }); noteF0(); },
    });
    const sSrc = U.seg({
      label: 'Source', options: [['glottal', 'Buzz'], ['impulse', 'Pulses'], ['breathy', 'Breathy'], ['whisper', 'Whisper']], value: S.src,
      onChange: (v) => { S.src = v; send({ src: v }); if (v === 'whisper' && playing()) ctx.discover('whisper'); },
    });
    const tVib = U.toggle({ label: 'Vibrato', value: S.vib, onChange: (v) => { S.vib = v; send({ vib: v }); } });
    const sVol = U.slider({ label: 'Volume', min: 0, max: 1, step: 0.01, value: S.vol, fmt: (v) => Math.round(v * 100) + '%', onInput: (v) => { S.vol = v; send({ vol: v }); } });
    ctx.rail.append(U.group('Voice', bPlay, sF0.el, sSrc.el, tVib.el, sVol.el));

    const cvPad = U.canvas(10, 10, { cls: 'ps-pad' });
    const presets = U.seg({
      options: [['ə', 'ə'], ...SL.audio.VOWELS.map((v) => [v.ipa, v.ipa])], value: 'ɑ', wrap: true,
      onChange: (v) => { const src = v === 'ə' ? SCHWA : SL.audio.VOWELS.find((q) => q.ipa === v); S.pairs = presetPairs(src); changed(); },
    });
    presets.el.classList.add('ps-presets');
    const sL = U.slider({
      label: 'Tract length', min: 10, max: 20, step: 0.1, value: S.L, unit: 'cm', fmt: (v) => v.toFixed(1),
      onInput: (v) => { S.L = v; if (Math.abs(v - 17.5) >= 3) ctx.discover('tract'); changed(); },
    });
    const bAdd = U.button({ label: '+ pole pair', kind: 'ghost', onClick: () => { if (S.pairs.length < MAX_PAIRS) { S.pairs.push({ f: 4300 + Math.random() * 1500, bw: 160 }); changed(); } } });
    const bReset = U.button({ icon: 'reset', label: 'Reset', kind: 'ghost', onClick: () => { S.pairs = presetPairs(SL.audio.VOWELS[4]); S.L = 17.5; sL.set(17.5, true); presets.set('ɑ', true); changed(); } });
    ctx.rail.append(U.group('Vocal tract', h('div.ps-padwrap', null, cvPad), presets.el, sL.el, h('div.btn-row', null, bAdd, bReset)));

    const stF1 = U.stat('F1', 'Hz'), stF2 = U.stat('F2', 'Hz'), stR = U.stat('max |p|', '', { bar: true }), stN = U.stat('Poles', '');
    ctx.rail.append(U.group('Readout', h('div.stat-grid', null, stF1.el, stF2.el, stR.el, stN.el)));

    /* ---------- engine plumbing ---------- */
    function send(d) { if (S.engine) S.engine.send(d); }
    function pushAll() {
      send({ pairs: eff(), f0: S.f0, src: S.src, vib: S.vib, vol: S.vol, mute: unstable(), gate: playing() });
    }
    async function ensureEngine() {
      if (S.engine) return S.engine;
      if (!S.starting) S.starting = createEngine();
      const e = await S.starting;
      if (!ctx.alive) { e.dispose(); return null; }
      S.engine = e;
      pushAll();
      return e;
    }
    ctx.cleanup(() => { if (S.engine) S.engine.dispose(); else if (S.starting) S.starting.then((e) => e.dispose()); });
    function gateChanged() {
      bPlay.classList.toggle('on', playing());
      bPlay.querySelector('.ps-play-t').textContent = playing() ? 'Stop' : 'Play';
      if (playing()) {
        ensureEngine().then(() => send({ gate: playing() }));
        S.f0min = S.f0max = S.f0;
        if (S.src === 'whisper') ctx.discover('whisper');
        noteF0();
      } else send({ gate: false });
    }
    function noteF0() {
      if (!playing()) return;
      S.f0min = Math.min(S.f0min, S.f0); S.f0max = Math.max(S.f0max, S.f0);
      if (S.f0max / S.f0min >= 1.6) ctx.discover('sourcefilter');
      if (S.f0 >= 350) ctx.discover('sparse');
    }
    function changed() {
      S.dirty = true;
      send({ pairs: eff(), mute: unstable() });
    }
    ctx.on(document, 'keydown', (e) => {
      if (e.code !== 'Space' || e.target.closest('input,textarea,button')) return;
      e.preventDefault();
      if (e.repeat) return;
      S.held = true; gateChanged();
    });
    ctx.on(document, 'keyup', (e) => {
      if (e.code !== 'Space') return;
      if (!S.held) return;
      S.held = false; gateChanged();
    });

    /* ---------- z-plane geometry ---------- */
    let zGeo = { cx: 0, cy: 0, R: 1 };
    const toXY = (r, a, sgn = 1) => ({ x: zGeo.cx + Math.cos(a) * r * zGeo.R, y: zGeo.cy - sgn * Math.sin(a) * r * zGeo.R });
    function hitPole(mx, my) {
      let best = null, bd = 18;
      eff().forEach((p, i) => {
        const { r, th: a } = polar(p.f, p.bw);
        for (const s of [1, -1]) {
          const q = toXY(r, a, s), d = Math.hypot(q.x - mx, q.y - my);
          if (d < bd) { bd = d; best = { i, s }; }
        }
      });
      return best;
    }
    function setFromXY(i, mx, my) {
      const zx = (mx - zGeo.cx) / zGeo.R, zy = -(my - zGeo.cy) / zGeo.R;
      const r = Math.min(1.2, Math.max(0.3, Math.hypot(zx, zy)));
      const a = Math.min(Math.PI - 0.02, Math.max(0.02, Math.abs(Math.atan2(zy, zx))));
      const fEff = (a * FS) / (2 * Math.PI), bw = (-Math.log(r) * FS) / Math.PI;
      S.pairs[i] = { f: fEff / scale(), bw };
      return r;
    }
    let lp = null;
    U.pointer(cvZ, (p) => {
      const r = cvZ.getBoundingClientRect(), mx = p.u * r.width, my = p.v * r.height;
      if (p.type === 'down') {
        if (p.e.button === 2) return;
        const hit = hitPole(mx, my);
        if (hit) {
          const q = polar(eff()[hit.i].f, eff()[hit.i].bw);
          S.drag = { i: hit.i, r0: q.r, rMin: q.r, rMax: q.r, x0: mx, y0: my, moved: false };
          clearTimeout(lp);
          lp = setTimeout(() => { if (S.drag && !S.drag.moved) { removePair(S.drag.i); S.drag = null; } }, 650);
        }
      } else if (p.type === 'move') {
        if (S.drag) {
          if (Math.hypot(mx - S.drag.x0, my - S.drag.y0) > 5) S.drag.moved = true;
          if (!S.drag.moved) return;
          const rr = setFromXY(S.drag.i, mx, my);
          S.drag.rMin = Math.min(S.drag.rMin, rr); S.drag.rMax = Math.max(S.drag.rMax, rr);
          ctx.discover('resonance');
          if (S.drag.rMax - S.drag.rMin > 0.06) ctx.discover('bandwidth');
          if (rr >= 1) ctx.discover('unstable');
          presets.set(null, true);
          changed();
        } else S.hover = hitPole(mx, my);
      } else if (p.type === 'up' || p.type === 'leave') {
        if (p.type === 'up') { S.drag = null; clearTimeout(lp); }
        if (p.type === 'leave') S.hover = null;
      }
    });
    ctx.cleanup(() => clearTimeout(lp));
    ctx.on(cvZ, 'contextmenu', (e) => {
      e.preventDefault();
      const r = cvZ.getBoundingClientRect(), hit = hitPole(e.clientX - r.left, e.clientY - r.top);
      if (hit) removePair(hit.i);
    });
    ctx.on(cvZ, 'dblclick', (e) => {
      const r = cvZ.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      if (hitPole(mx, my) || S.pairs.length >= MAX_PAIRS) return;
      S.pairs.push({ f: 1000, bw: 100 });
      setFromXY(S.pairs.length - 1, mx, my);
      presets.set(null, true);
      changed();
    });
    function removePair(i) {
      if (S.pairs.length <= 1) return;
      S.pairs.splice(i, 1);
      presets.set(null, true);
      changed();
    }

    /* ---------- |H| probe ---------- */
    U.pointer(cvH, (p) => {
      if (p.type === 'leave') { S.probe = null; return; }
      const r = cvH.getBoundingClientRect(), x = p.u * r.width;
      S.probe = Math.max(0, Math.min(8000, ((x - 34) / (r.width - 44)) * 8000));
    });

    /* ---------- vowel pad ---------- */
    const PX = (F2) => (Math.log(2700) - Math.log(F2)) / (Math.log(2700) - Math.log(620));
    const PY = (F1) => (Math.log(F1) - Math.log(220)) / (Math.log(950) - Math.log(220));
    const iPX = (u) => Math.exp(Math.log(2700) - u * (Math.log(2700) - Math.log(620)));
    const iPY = (v) => Math.exp(Math.log(220) + v * (Math.log(950) - Math.log(220)));
    function sortedIdx() { return S.pairs.map((p, i) => i).sort((a, b) => S.pairs[a].f - S.pairs[b].f); }
    let padDrag = null;
    U.pointer(cvPad, (p) => {
      if (p.type === 'down') { const ix = sortedIdx(); padDrag = { i1: ix[0], i2: ix[1] }; }
      if ((p.type === 'down' || p.type === 'move') && padDrag && p.down) {
        const u = Math.max(0, Math.min(1, (p.u - 0.06) / 0.88)), v = Math.max(0, Math.min(1, (p.v - 0.08) / 0.84));
        if (padDrag.i1 !== undefined) S.pairs[padDrag.i1].f = iPY(v);
        if (padDrag.i2 !== undefined) S.pairs[padDrag.i2].f = iPX(u);
        presets.set(null, true);
        changed();
      }
      if (p.type === 'up') padDrag = null;
    });

    /* ---------- analysis ---------- */
    function Hdb(fHz, poles) {
      const om = (2 * Math.PI * fHz) / FS, c = Math.cos(om), s = Math.sin(om);
      let d = 0;
      for (const q of poles) {
        const pr = q.r * Math.cos(q.th), pi = q.r * Math.sin(q.th);
        d += Math.log10(Math.hypot(c - pr, s - pi) * Math.hypot(c - pr, s + pi) + 1e-12);
      }
      return -20 * d;
    }
    let cache = null;
    function recompute() {
      const E = eff(), poles = E.map((p) => polar(p.f, p.bw));
      const N = 400, curve = new Float32Array(N);
      let mx = -1e9;
      for (let i = 0; i < N; i++) { curve[i] = Hdb((i / (N - 1)) * 8000, poles); mx = Math.max(mx, curve[i]); }
      for (let i = 0; i < N; i++) curve[i] -= mx;
      // heat map of log|H(z)| over the plane
      const G = 120, hm = new Float32Array(G * G);
      let hmax = -1e9, hmin = 1e9;
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
        const zx = ((x + 0.5) / G) * 2.5 - 1.25, zy = 1.25 - ((y + 0.5) / G) * 2.5;
        let d = 0;
        for (const q of poles) {
          const pr = q.r * Math.cos(q.th), pi = q.r * Math.sin(q.th);
          d += Math.log10(Math.hypot(zx - pr, zy - pi) * Math.hypot(zx - pr, zy + pi) + 1e-9);
        }
        const v = -20 * d;
        hm[y * G + x] = v;
        if (v > hmax) hmax = v;
        if (v < hmin) hmin = v;
      }
      if (!heat) { heat = document.createElement('canvas'); heat.width = heat.height = G; }
      const hg = heat.getContext('2d'), img = hg.createImageData(G, G), lut = SL.img.lut('ember');
      const lo = hmax - 70;
      for (let i = 0; i < G * G; i++) {
        let v = Math.round(((hm[i] - lo) / (hmax - lo)) * 255);
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        img.data[i * 4] = lut[v * 3]; img.data[i * 4 + 1] = lut[v * 3 + 1]; img.data[i * 4 + 2] = lut[v * 3 + 2];
        img.data[i * 4 + 3] = 40 + v * 0.7;
      }
      hg.putImageData(img, 0, 0);
      // soft circular mask: full strength inside |z| ≈ 1.05, fading out by 1.25
      hg.globalCompositeOperation = 'destination-in';
      const mk = hg.createRadialGradient(G / 2, G / 2, 0, G / 2, G / 2, G / 2);
      mk.addColorStop(0, 'rgba(0,0,0,1)'); mk.addColorStop(0.84, 'rgba(0,0,0,1)'); mk.addColorStop(1, 'rgba(0,0,0,0)');
      hg.fillStyle = mk; hg.fillRect(0, 0, G, G);
      hg.globalCompositeOperation = 'source-over';
      // impulse response at 16 kHz with the true (possibly unstable) poles
      const IRN = 320, ir = new Float32Array(IRN), y1 = new Float64Array(poles.length), y2 = new Float64Array(poles.length);
      for (let n = 0; n < IRN; n++) {
        let s = n === 0 ? 1 : 0;
        poles.forEach((q, i) => {
          const y = s + 2 * q.r * Math.cos(q.th) * y1[i] - q.r * q.r * y2[i];
          y2[i] = y1[i]; y1[i] = y; s = y;
        });
        ir[n] = s;
      }
      cache = { E, poles, curve, ir, maxR: Math.max(...poles.map((q) => q.r)) };
      S.dirty = false;
    }
    let heat = null;

    function sourceSpec() {
      const key = S.src + '|' + Math.round(S.f0);
      if (key === S.srcKey) return S.srcSpec;
      const f0 = S.f0, K = Math.floor(7999 / f0), out = [];
      if (S.src === 'impulse' || S.src === 'whisper') for (let k = 1; k <= K; k++) out.push({ f: k * f0, db: 0 });
      else {
        const N = Math.max(8, Math.round(FS / f0)), e = new Float64Array(N);
        for (let n = 0; n < N; n++) e[n] = SL.audio.rosenberg((n + 1) / N) - SL.audio.rosenberg(n / N);
        let mx = -1e9;
        for (let k = 1; k <= K; k++) {
          let re = 0, im = 0;
          for (let n = 0; n < N; n++) { const a = (-2 * Math.PI * k * n) / N; re += e[n] * Math.cos(a); im += e[n] * Math.sin(a); }
          const db = 20 * Math.log10(Math.hypot(re, im) + 1e-9);
          out.push({ f: k * f0, db }); mx = Math.max(mx, db);
        }
        out.forEach((q) => (q.db -= mx));
      }
      S.srcKey = key; S.srcSpec = out;
      return out;
    }

    /* ---------- per-frame ---------- */
    let scopeBuf = new Float32Array(2048);
    ctx.frame((t) => {
      if (S.dirty || !cache) recompute();
      const bad = unstable();
      zCard.classList.toggle('bad', bad);
      bPlay.classList.toggle('muted', bad && playing());
      drawZ(t, bad);
      drawH(bad);
      drawScope(t);
      drawStrips(bad);
      drawIR(bad);
      drawPad(t);
      const ix = sortedIdx(), E = eff();
      stF1.set(Math.round(E[ix[0]]?.f || 0));
      stF2.set(E[ix[1]] ? Math.round(E[ix[1]].f) : '—');
      stR.set(cache.maxR.toFixed(3), '', Math.min(1, cache.maxR));
      stR.color(bad ? th.bad : th.ear);
      stN.set(S.pairs.length * 2);
    });

    const mono = (px, wt = 500) => `${wt} ${px}px "JetBrains Mono", monospace`;

    function drawZ(t, bad) {
      const { ctx: g, w, h: H } = U.fit(cvZ);
      g.clearRect(0, 0, w, H);
      const cx = w / 2, cy = H / 2, R = Math.min(w, H) * 0.38;
      zGeo = { cx, cy, R };
      // heat map
      if (heat) {
        g.save(); g.globalAlpha = 0.85; g.imageSmoothingEnabled = true;
        g.drawImage(heat, cx - 1.25 * R, cy - 1.25 * R, 2.5 * R, 2.5 * R);
        g.restore();
      }
      // axes + rings
      g.strokeStyle = 'rgba(255,255,255,.1)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx - R * 1.2, cy); g.lineTo(cx + R * 1.2, cy); g.moveTo(cx, cy - R * 1.2); g.lineTo(cx, cy + R * 1.2); g.stroke();
      g.setLineDash([2, 4]);
      for (const rr of [0.5, 0.9]) { g.beginPath(); g.arc(cx, cy, R * rr, 0, 7); g.stroke(); }
      g.setLineDash([]);
      g.strokeStyle = bad ? th.bad : 'rgba(255,255,255,.7)'; g.lineWidth = 1.6;
      if (bad) { g.shadowColor = th.bad; g.shadowBlur = 14 + 6 * Math.sin(t * 8); }
      g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke(); g.shadowBlur = 0;
      g.fillStyle = 'rgba(255,255,255,.5)'; g.font = mono(10); g.textAlign = 'center';
      for (let f = 0; f <= 8000; f += 1000) {
        const a = (2 * Math.PI * f) / FS;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.97, cy - Math.sin(a) * R * 0.97); g.lineTo(cx + Math.cos(a) * R * 1.03, cy - Math.sin(a) * R * 1.03);
        g.strokeStyle = 'rgba(255,255,255,.5)'; g.stroke();
        if (f % 2000 === 0) g.fillText(f ? f / 1000 + ' kHz' : '0', cx + Math.cos(a) * (R + 22), cy - Math.sin(a) * (R + 22) + 4);
      }
      g.fillStyle = 'rgba(255,255,255,.3)'; g.fillText('fs = 16 kHz', cx, cy + R * 1.2 + 10);
      g.textAlign = 'left';
      // probe: distances from e^{jω} to every pole
      if (S.probe !== null && cache) {
        const a = (2 * Math.PI * S.probe) / FS, px = cx + Math.cos(a) * R, py = cy - Math.sin(a) * R;
        g.strokeStyle = 'rgba(255,200,87,.55)'; g.lineWidth = 1;
        for (const q of cache.poles) for (const s of [1, -1]) {
          const z = toXY(q.r, q.th, s);
          g.beginPath(); g.moveTo(px, py); g.lineTo(z.x, z.y); g.stroke();
        }
        g.fillStyle = th.warn; g.beginPath(); g.arc(px, py, 5, 0, 7); g.fill();
      }
      // poles
      const ix = sortedIdx();
      eff().forEach((p, i) => {
        const { r, th: a } = polar(p.f, p.bw), out = r >= 1, rank = ix.indexOf(i);
        for (const s of [1, -1]) {
          const z = toXY(r, a, s), sz = s === 1 ? 7 : 6;
          const col = out ? th.bad : th.ear;
          const hl = (S.hover && S.hover.i === i) || (S.drag && S.drag.i === i);
          g.globalAlpha = s === 1 ? 1 : 0.6;
          if (hl || out) { g.strokeStyle = col; g.lineWidth = 1; g.beginPath(); g.arc(z.x, z.y, 13 + (out ? 3 * Math.sin(t * 10) : 0), 0, 7); g.stroke(); }
          g.strokeStyle = '#fff'; g.lineWidth = 4; g.globalAlpha *= 0.25;
          g.beginPath(); g.moveTo(z.x - sz, z.y - sz); g.lineTo(z.x + sz, z.y + sz); g.moveTo(z.x + sz, z.y - sz); g.lineTo(z.x - sz, z.y + sz); g.stroke();
          g.globalAlpha = s === 1 ? 1 : 0.6;
          g.strokeStyle = col; g.lineWidth = 2.4; g.shadowColor = col; g.shadowBlur = 10;
          g.beginPath(); g.moveTo(z.x - sz, z.y - sz); g.lineTo(z.x + sz, z.y + sz); g.moveTo(z.x + sz, z.y - sz); g.lineTo(z.x - sz, z.y + sz); g.stroke();
          g.shadowBlur = 0;
          if (s === 1) {
            g.fillStyle = '#fff'; g.font = mono(10, 600);
            g.fillText('F' + (rank + 1), z.x + 10, z.y - 9);
            if (hl) {
              const txt = [Math.round(p.f) + ' Hz', p.bw > 0 ? 'B ' + Math.round(p.bw) + ' Hz' : 'B < 0 !', '|p| ' + r.toFixed(3)];
              const bx = Math.min(w - 100, z.x + 16), by = Math.max(4, z.y - 60);
              g.fillStyle = 'rgba(8,9,14,.9)'; g.strokeStyle = out ? th.bad : 'rgba(255,95,162,.5)'; g.lineWidth = 1;
              g.beginPath(); g.roundRect(bx, by, 92, 46, 7); g.fill(); g.stroke();
              g.fillStyle = '#fff'; g.font = mono(10);
              txt.forEach((s2, k) => g.fillText(s2, bx + 8, by + 14 + k * 13));
            }
          }
        }
      });
      g.globalAlpha = 1;
    }

    function plotFrame(g, L, R, T, B, top, bot, xlabels) {
      g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1; g.fillStyle = 'rgba(255,255,255,.38)'; g.font = mono(9);
      for (let f = 0; f <= 8000; f += 2000) {
        const x = L + ((R - L) * f) / 8000;
        g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke();
        if (xlabels) g.fillText(f ? f / 1000 + 'k' : '0', x - 5, B + 12);
      }
      for (let d = top; d >= bot; d -= 20) {
        const y = B - ((d - bot) / (top - bot)) * (B - T);
        g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke();
        if (xlabels) g.fillText(d, 4, y + 3);
      }
    }

    function drawH(bad) {
      const { ctx: g, w, h: H } = U.fit(cvH);
      g.clearRect(0, 0, w, H);
      const L = 34, R = w - 10, T = 30, B = H - 20, top = 5, bot = -65;
      plotFrame(g, L, R, T, B, 0, -60, true);
      const Y = (v) => B - ((Math.max(bot, v) - bot) / (top - bot)) * (B - T), X = (f) => L + ((R - L) * f) / 8000;
      const c = cache.curve, N = c.length, col = bad ? th.bad : th.ear;
      // area
      g.beginPath(); g.moveTo(L, B);
      for (let i = 0; i < N; i++) g.lineTo(L + ((R - L) * i) / (N - 1), Y(c[i]));
      g.lineTo(R, B); g.closePath();
      const grd = g.createLinearGradient(0, T, 0, B);
      grd.addColorStop(0, bad ? 'rgba(255,107,107,.3)' : 'rgba(255,95,162,.32)'); grd.addColorStop(1, 'rgba(255,95,162,0)');
      g.fillStyle = grd; g.fill();
      // harmonic comb (lollipops) or noise
      const interp = (f) => { const p = (f / 8000) * (N - 1), i = Math.floor(p); return c[Math.min(N - 1, i)] + ((c[Math.min(N - 1, i + 1)] - c[Math.min(N - 1, i)]) * (p - i)); };
      if (S.src !== 'whisper') {
        g.strokeStyle = th.warn; g.fillStyle = th.warn; g.lineWidth = 1.2;
        for (let k = 1; k * S.f0 < 8000; k++) {
          const f = k * S.f0, x = X(f), y = Y(interp(f));
          g.globalAlpha = 0.75; g.beginPath(); g.moveTo(x, B); g.lineTo(x, y); g.stroke();
          g.globalAlpha = 1; g.beginPath(); g.arc(x, y, 2.4, 0, 7); g.fill();
        }
      } else {
        g.fillStyle = 'rgba(255,200,87,.35)';
        for (let i = 0; i < 260; i++) { const f = Math.random() * 8000; g.fillRect(X(f), Y(interp(f) - Math.random() * 12), 1.2, 1.2); }
      }
      // envelope line
      g.beginPath();
      for (let i = 0; i < N; i++) { const x = L + ((R - L) * i) / (N - 1), y = Y(c[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = col; g.lineWidth = 2.2; g.shadowColor = col; g.shadowBlur = 12; g.stroke(); g.shadowBlur = 0;
      // formant labels
      const ix = sortedIdx(), E = eff();
      ix.forEach((i, rank) => {
        const f = E[i].f;
        if (f > 8000) return;
        g.fillStyle = '#fff'; g.font = mono(10, 600);
        g.fillText('F' + (rank + 1), X(f) - 7, Math.max(T - 4, Y(interp(f)) - 8));
      });
      if (S.probe !== null) {
        const x = X(S.probe), v = interp(S.probe);
        g.strokeStyle = th.warn; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke(); g.setLineDash([]);
        g.fillStyle = th.warn; g.font = mono(10);
        g.fillText(Math.round(S.probe) + ' Hz · ' + v.toFixed(1) + ' dB', Math.min(R - 120, x + 6), T + 12);
      }
      g.fillStyle = 'rgba(255,255,255,.45)'; g.font = mono(9.5); g.fillText('dB', 6, T - 12);
      g.fillStyle = th.warn; g.fillText('F0 ' + Math.round(S.f0) + ' Hz', R - 80, T - 12);
    }

    function drawScope(t) {
      const { ctx: g, w, h: H } = U.fit(cvScope);
      g.clearRect(0, 0, w, H);
      g.strokeStyle = 'rgba(255,255,255,.06)'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(w, H / 2); g.stroke();
      if (!S.engine) {
        g.fillStyle = 'rgba(255,255,255,.3)'; g.font = mono(10); g.textAlign = 'center';
        g.fillText('press Play or hold Space', w / 2, H / 2 + 4); g.textAlign = 'left';
        return;
      }
      const an = S.engine.analyser;
      if (scopeBuf.length !== an.fftSize) scopeBuf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(scopeBuf);
      // trigger on rising zero crossing for a steady trace
      let s0 = 0;
      for (let i = 1; i < scopeBuf.length / 2; i++) if (scopeBuf[i - 1] < 0 && scopeBuf[i] >= 0) { s0 = i; break; }
      const n = Math.min(scopeBuf.length - s0, 900);
      g.beginPath();
      for (let i = 0; i < n; i++) { const x = (i / n) * w, y = H / 2 - scopeBuf[s0 + i] * H * 0.45; i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = th.ear; g.lineWidth = 1.4; g.globalAlpha = 0.9; g.stroke(); g.globalAlpha = 1;
    }

    function drawStrips(bad) {
      const src = sourceSpec(), c = cache.curve, N = c.length;
      const interp = (f) => { const p = (f / 8000) * (N - 1), i = Math.floor(p); return c[Math.min(N - 1, i)] + ((c[Math.min(N - 1, i + 1)] - c[Math.min(N - 1, i)]) * (p - i)); };
      const outs = src.map((q) => ({ f: q.f, db: q.db + interp(q.f) }));
      const om = Math.max(...outs.map((q) => q.db));
      outs.forEach((q) => (q.db -= om));
      const draw = (cv, fn) => {
        const { ctx: g, w, h: H } = U.fit(cv);
        g.clearRect(0, 0, w, H);
        const L = 4, R = w - 4, T = 6, B = H - 6;
        plotFrame(g, L, R, T, B, 0, -60, false);
        fn(g, (f) => L + ((R - L) * f) / 8000, (v) => B - ((Math.max(-60, v) + 60) / 60) * (B - T), B);
      };
      const lolli = (g, X, Y, B, arr, col) => {
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
        for (const q of arr) { const x = X(q.f), y = Y(q.db); g.beginPath(); g.moveTo(x, B); g.lineTo(x, y); g.stroke(); g.beginPath(); g.arc(x, y, 1.6, 0, 7); g.fill(); }
      };
      const noise = (g, X, Y, B, fn, col) => {
        g.fillStyle = col;
        for (let i = 0; i < 180; i++) { const f = Math.random() * 8000; g.fillRect(X(f), Y(fn(f) - Math.random() * 10), 1.2, 1.2); }
      };
      draw(cvS, (g, X, Y, B) => {
        if (S.src === 'whisper') noise(g, X, Y, B, () => -3, th.warn);
        else { lolli(g, X, Y, B, src, th.warn); if (S.src === 'breathy') noise(g, X, Y, B, () => -28, 'rgba(255,200,87,.5)'); }
      });
      draw(cvF, (g, X, Y) => {
        g.beginPath();
        for (let i = 0; i < N; i++) { const x = X((i / (N - 1)) * 8000), y = Y(c[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.strokeStyle = bad ? th.bad : th.ear; g.lineWidth = 2; g.stroke();
      });
      draw(cvO, (g, X, Y, B) => {
        g.beginPath();
        for (let i = 0; i < N; i++) { const x = X((i / (N - 1)) * 8000), y = Y(c[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.strokeStyle = 'rgba(255,95,162,.3)'; g.lineWidth = 1; g.stroke();
        if (S.src === 'whisper') noise(g, X, Y, B, (f) => interp(f), '#fff');
        else lolli(g, X, Y, B, outs, '#fff');
      });
    }

    function drawIR(bad) {
      const { ctx: g, w, h: H } = U.fit(cvIR);
      g.clearRect(0, 0, w, H);
      const ir = cache.ir, n = ir.length;
      let m = 0;
      for (let i = 0; i < 80; i++) m = Math.max(m, Math.abs(ir[i]));
      m = m || 1;
      g.strokeStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(w, H / 2); g.stroke();
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x = 6 + ((w - 12) * i) / (n - 1), v = ir[i] / m;
        const y = H / 2 - Math.max(-1.4, Math.min(1.4, v)) * (H * 0.34);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = bad ? th.bad : th.ear; g.lineWidth = 1.4; g.stroke();
      g.fillStyle = 'rgba(255,255,255,.4)'; g.font = mono(9);
      g.fillText('0', 6, H - 6); g.fillText('20 ms', w - 40, H - 6);
      if (bad) { g.fillStyle = th.bad; g.font = mono(10, 700); g.fillText('→ ∞', w - 44, 14); }
    }

    function drawPad(t) {
      const { ctx: g, w, h: H } = U.fit(cvPad);
      g.clearRect(0, 0, w, H);
      const L = w * 0.06, R = w * 0.94, T = H * 0.08, B = H * 0.92;
      const X = (F2) => L + PX(F2) * (R - L), Y = (F1) => T + PY(F1) * (B - T);
      const bg = g.createLinearGradient(L, T, R, B);
      bg.addColorStop(0, 'rgba(255,95,162,.08)'); bg.addColorStop(1, 'rgba(185,156,255,.06)');
      g.fillStyle = bg; g.beginPath(); g.roundRect(L, T, R - L, B - T, 10); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.1)'; g.stroke();
      g.font = '500 14px "Space Grotesk", sans-serif'; g.textAlign = 'center';
      for (const v of [SCHWA, ...SL.audio.VOWELS]) { g.fillStyle = 'rgba(255,255,255,.35)'; g.fillText(v.ipa, X(v.F2), Y(v.F1) + 5); }
      g.fillStyle = 'rgba(255,255,255,.3)'; g.font = mono(8.5);
      g.fillText('← front · F2 · back →', (L + R) / 2, H - 1);
      g.textAlign = 'left';
      const ix = sortedIdx();
      if (ix.length >= 2) {
        const F1 = S.pairs[ix[0]].f, F2 = S.pairs[ix[1]].f;
        const x = Math.max(L, Math.min(R, X(F2))), y = Math.max(T, Math.min(B, Y(F1)));
        g.strokeStyle = 'rgba(255,95,162,.35)'; g.setLineDash([2, 4]);
        g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.moveTo(L, y); g.lineTo(R, y); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#fff'; g.shadowColor = th.ear; g.shadowBlur = 18 + (playing() ? 6 * Math.sin(t * 8) : 0);
        g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); g.shadowBlur = 0;
        g.strokeStyle = th.ear; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 11, 0, 7); g.stroke();
      }
    }

    pushAll();
  }
})();
