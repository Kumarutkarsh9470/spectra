/* SPECTRA — audio core: context, playback, mic, recording, decoding, built-in formant voice. */
(function () {
  const SL = (window.SL = window.SL || {});
  const A = (SL.audio = {});
  const D = SL.dsp;

  let ac = null;
  A.ctx = function () {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  };

  /* ---------------- Playback ---------------- */
  let current = null;
  /** Play a Float32Array at sample rate sr. Stops whatever was playing (unless opt.mix).
   *  Returns handle {stop(), get t() (seconds into the clip), duration, playing}. */
  A.play = function (x, sr, opt = {}) {
    const c = A.ctx();
    if (!opt.mix) A.stop();
    const buf = c.createBuffer(1, Math.max(1, x.length), sr);
    buf.copyToChannel(x instanceof Float32Array ? x : Float32Array.from(x), 0);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = !!opt.loop;
    const g = c.createGain();
    g.gain.value = opt.gain ?? 1;
    src.connect(g).connect(c.destination);
    const t0 = c.currentTime;
    const h = {
      duration: x.length / sr,
      playing: true,
      stop() { try { src.stop(); } catch (e) {} h.playing = false; },
      get t() { const e = c.currentTime - t0; return opt.loop ? e % h.duration : Math.min(e, h.duration); },
    };
    src.onended = () => { h.playing = false; if (current === h) current = null; opt.onEnd && opt.onEnd(); };
    src.start();
    if (!opt.mix) current = h;
    return h;
  };
  A.stop = function () { if (current) current.stop(); current = null; };
  A.current = () => current;

  /* ---------------- Microphone ---------------- */
  let mic = null;
  /** Live mic → AnalyserNode. Returns {stream, source, analyser, sr, frame(n) → latest Float32Array, stop()}. */
  A.mic = async function () {
    if (mic && mic.stream.active) return mic;
    const c = A.ctx();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const source = c.createMediaStreamSource(stream);
    const analyser = c.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    mic = {
      stream, source, analyser, sr: c.sampleRate,
      frame(n = 2048) { analyser.getFloatTimeDomainData(buf); return buf.subarray(buf.length - n); },
      stop() { stream.getTracks().forEach((t) => t.stop()); try { source.disconnect(); } catch (e) {} mic = null; },
    };
    return mic;
  };
  A.stopMic = function () { if (mic) mic.stop(); };

  /** Record from the mic for up to maxSec. Returns controller {stop(), done: Promise<{x, sr}>}. onLevel(rms) is called live. */
  A.record = function (maxSec = 4, onLevel) {
    let resolveDone, rejectDone, stopped = false, proc, srcNode, stream;
    const chunks = [];
    const done = new Promise((r, j) => { resolveDone = r; rejectDone = j; });
    const c = A.ctx();
    const finish = () => {
      if (stopped) return;
      stopped = true;
      try { proc && proc.disconnect(); srcNode && srcNode.disconnect(); } catch (e) {}
      stream && stream.getTracks().forEach((t) => t.stop());
      let L = 0;
      chunks.forEach((ch) => (L += ch.length));
      const x = new Float32Array(L);
      let o = 0;
      chunks.forEach((ch) => { x.set(ch, o); o += ch.length; });
      resolveDone({ x, sr: c.sampleRate });
    };
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      .then((s) => {
        stream = s;
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
        srcNode = c.createMediaStreamSource(s);
        proc = c.createScriptProcessor(2048, 1, 1);
        const maxN = maxSec * c.sampleRate;
        let n = 0;
        proc.onaudioprocess = (e) => {
          if (stopped) return;
          const d = e.inputBuffer.getChannelData(0);
          chunks.push(Float32Array.from(d));
          n += d.length;
          onLevel && onLevel(D.rms(d));
          if (n >= maxN) finish();
        };
        const mute = c.createGain();
        mute.gain.value = 0;
        srcNode.connect(proc); proc.connect(mute).connect(c.destination);
      })
      .catch((e) => { stopped = true; rejectDone(e); });
    return { stop: finish, done };
  };

  /** Decode an audio File → {x: Float32Array mono, sr}. */
  A.decodeFile = async function (file) {
    const c = A.ctx();
    const ab = await file.arrayBuffer();
    const buf = await c.decodeAudioData(ab);
    const x = new Float32Array(buf.length);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < x.length; i++) x[i] += d[i] / buf.numberOfChannels;
    }
    return { x, sr: buf.sampleRate };
  };

  /** Trim leading/trailing silence (relative threshold). */
  A.trim = function (x, sr, thr = 0.02) {
    let m = 0;
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
    const t = m * thr, pad = Math.floor(0.05 * sr);
    let s = 0, e = x.length - 1;
    while (s < x.length && Math.abs(x[s]) < t) s++;
    while (e > s && Math.abs(x[e]) < t) e--;
    return x.slice(Math.max(0, s - pad), Math.min(x.length, e + pad));
  };

  /* ---------------- Vowel reference table (Peterson & Barney 1952, adult male means) ---------------- */
  A.VOWELS = [
    { ipa: 'i', word: 'heed', F1: 270, F2: 2290, F3: 3010 },
    { ipa: 'ɪ', word: 'hid', F1: 390, F2: 1990, F3: 2550 },
    { ipa: 'ɛ', word: 'head', F1: 530, F2: 1840, F3: 2480 },
    { ipa: 'æ', word: 'had', F1: 660, F2: 1720, F3: 2410 },
    { ipa: 'ɑ', word: 'hod', F1: 730, F2: 1090, F3: 2440 },
    { ipa: 'ɔ', word: 'hawed', F1: 570, F2: 840, F3: 2410 },
    { ipa: 'ʊ', word: 'hood', F1: 440, F2: 1020, F3: 2240 },
    { ipa: 'u', word: "who'd", F1: 300, F2: 870, F3: 2240 },
    { ipa: 'ʌ', word: 'hud', F1: 640, F2: 1190, F3: 2390 },
    { ipa: 'ɝ', word: 'heard', F1: 490, F2: 1350, F3: 1690 },
  ];
  const V = Object.fromEntries(A.VOWELS.map((v) => [v.ipa, v]));
  V.e = { F1: 480, F2: 2000, F3: 2600 };
  V.o = { F1: 500, F2: 850, F3: 2450 };
  V.a = { F1: 760, F2: 1250, F3: 2500 };

  /* ---------------- Glottal source ---------------- */
  /** Rosenberg glottal pulse value at phase p∈[0,1). Open quotient oq, speed quotient. */
  A.rosenberg = function (p, oq = 0.6, sq = 2.2) {
    const tp = (oq * sq) / (1 + sq), tn = oq - tp;
    if (p < tp) return 0.5 * (1 - Math.cos((Math.PI * p) / tp));
    if (p < oq) return Math.cos((Math.PI * (p - tp)) / (2 * tn));
    return 0;
  };

  /** Formant synthesiser (cascade) for a list of segments. Returns Float32Array at sr.
   *  seg: {dur, v: vowel key or {F1,F2,F3}, to?: vowel for glide, fric?: [centre, bw], voiced?: bool, gain?} */
  A.synthesize = function (segs, sr = 16000, opt = {}) {
    const f0a = opt.f0Start ?? 132, f0b = opt.f0End ?? 92;
    const total = segs.reduce((s, g) => s + g.dur, 0), N = Math.floor(total * sr);
    const out = new Float32Array(N), R = D.rng(opt.seed ?? 3);
    const st = [[0, 0], [0, 0], [0, 0], [0, 0]], fst = [[0, 0], [0, 0]];
    let phase = 0, prevG = 0, n = 0, tAll = 0;
    const tr = (k) => (typeof k === 'string' ? V[k] : k);
    for (const sg of segs) {
      const L = Math.floor(sg.dur * sr), v0 = tr(sg.v), v1 = tr(sg.to || sg.v);
      const ramp = Math.floor(0.025 * sr);
      for (let i = 0; i < L && n < N; i++, n++) {
        const u = i / L, t = n / sr;
        const env = Math.min(1, i / ramp, (L - i) / ramp) * (sg.gain ?? 1);
        let y = 0;
        if (v0 && sg.voiced !== false) {
          // pitch: declination + gentle vibrato + jitter
          const f0 = (f0a + (f0b - f0a) * (t / total)) * (1 + 0.012 * Math.sin(2 * Math.PI * 5 * t)) * (opt.pitchScale || 1);
          phase += f0 / sr * (1 + 0.004 * (R() - 0.5));
          if (phase >= 1) phase -= 1;
          const gp = A.rosenberg(phase);
          let src = gp - prevG; // derivative: glottal flow + lip radiation
          prevG = gp;
          src += 0.006 * (R() - 0.5); // aspiration
          const F = [v0.F1 + (v1.F1 - v0.F1) * u, v0.F2 + (v1.F2 - v0.F2) * u, v0.F3 + (v1.F3 - v0.F3) * u, 3500];
          const BW = [80, 100, 140, 200];
          let s = src * 40;
          for (let k = 0; k < 4; k++) {
            const c = D.resonator(F[k], BW[k], sr);
            const yk = c.b0 * s + c.a1 * st[k][0] + c.a2 * st[k][1];
            st[k][1] = st[k][0]; st[k][0] = yk; s = yk;
          }
          y += s * env;
        }
        if (sg.fric) {
          let s = (R() - 0.5) * 0.9;
          const c = D.resonator(sg.fric[0], sg.fric[1], sr);
          const yk = c.b0 * s + c.a1 * fst[0][0] + c.a2 * fst[0][1];
          fst[0][1] = fst[0][0]; fst[0][0] = yk;
          const c2 = D.resonator(sg.fric[0] * 1.25, sg.fric[1] * 1.4, sr);
          const y2 = c2.b0 * yk + c2.a1 * fst[1][0] + c2.a2 * fst[1][1];
          fst[1][1] = fst[1][0]; fst[1][0] = y2;
          y += (yk * 0.6 + y2 * 0.6) * env * 0.5;
        }
        out[n] = y;
      }
      tAll += sg.dur;
    }
    return D.normalize(out, 0.85);
  };

  /** The built-in demo utterance (≈1.9 s): fricatives, steady vowels, diphthongs, silence. */
  A.demoVoice = function (sr = 16000) {
    const key = 'demo' + sr;
    if (A._cache[key]) return A._cache[key];
    const segs = [
      { dur: 0.08, v: null },
      { dur: 0.14, v: null, fric: [5800, 1800] },            // s
      { dur: 0.22, v: 'ɑ' },                                  // a
      { dur: 0.2, v: 'ɑ', to: 'i' },                          // → i (diphthong "ai")
      { dur: 0.06, v: null },
      { dur: 0.15, v: null, fric: [3000, 1200] },            // ʃ
      { dur: 0.26, v: 'u' },                                  // u
      { dur: 0.05, v: null },
      { dur: 0.2, v: 'æ' },                                   // æ
      { dur: 0.2, v: 'ɛ', to: 'o' },                          // e → o
      { dur: 0.24, v: 'i', gain: 0.9 },                       // i
      { dur: 0.1, v: null },
    ];
    return (A._cache[key] = A.synthesize(segs, sr));
  };
  A._cache = {};
})();
