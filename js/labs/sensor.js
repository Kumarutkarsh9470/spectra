/* SPECTRA · E1 Night Shot — a camera built from photons up.
 * scene → illuminant → (optical low-pass) → RGGB Bayer CFA → Poisson photons + read noise → full well
 * → ISO gain → N-bit ADC → demosaic → white balance → gamma → display.
 */
(function () {
  const SL = window.SL, h = SL.h, U = SL.ui, D = SL.dsp, I = SL.img;
  const W = 256, H = 256, N = W * H;
  const FULL_WELL = 10000;          // e⁻ per photosite
  const Q = 8000;                   // e⁻ per (unit radiance · lux · s): 100 lux · 1/100 s → 8000 e⁻ for white
  const ILLUM = {
    day: { label: 'Day', t: [1, 1, 1] },
    tung: { label: 'Tungsten', t: [1, 0.58, 0.26] },
    sodium: { label: 'Sodium', t: [1, 0.6, 0.07] },
    led: { label: 'Cool LED', t: [0.72, 0.92, 1] },
  };
  const STAGES = [
    { id: 'scene', label: 'Scene' },
    { id: 'photons', label: 'Photons' },
    { id: 'mosaic', label: 'Mosaic' },
    { id: 'demosaic', label: 'Demosaic' },
    { id: 'output', label: 'Output' },
  ];
  // CFA channel of photosite (x, y): RGGB
  const cfa = (x, y) => ((y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : ((x & 1) === 0 ? 1 : 2));

  /* fast randomness: xorshift + Gaussian table */
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const GT = new Float32Array(1 << 16);
  for (let i = 0; i < GT.length; i++) GT[i] = D.gauss();
  const gt = () => GT[(rnd() * 65536) | 0];
  function pois(l) {
    if (l <= 0) return 0;
    if (l < 20) {
      const L = Math.exp(-l);
      let k = 0, p = rnd();
      while (p > L) { k++; p *= rnd(); }
      return k;
    }
    return l + Math.sqrt(l) * gt();
  }
  /* sRGB encode LUT */
  const GL = 4096, GAMMA = new Uint8ClampedArray(GL + 1);
  for (let i = 0; i <= GL; i++) GAMMA[i] = Math.round(I.toSRGB(i / GL) * 255);
  const FC_THR = 0.09;
  const enc = (v) => GAMMA[v <= 0 ? 0 : v >= 1 ? GL : (v * GL) | 0];

  SL.lab({
    id: 'sensor', side: 'eye', code: 'E1',
    title: 'Night Shot',
    tagline: 'Build a camera from photons up.',
    syllabus: ['VIP M1 §3–6'],
    concepts: [
      { key: 'shot', label: 'Shot noise', math: ['noise'], hint: 'Starve the sensor of light',
        line: 'Photons arrive as a Poisson process: n̄ photons carry noise √n̄, so SNR = √n̄. Light, not electronics, sets the floor.' },
      { key: 'iso', label: 'ISO is gain', math: ['noise', 'quant'], hint: 'Dark scene, crank the ISO',
        line: 'ISO multiplies signal and shot noise together after capture. The image gets brighter but SNR does not improve. Only more photons help.' },
      { key: 'bayer', label: 'Bayer mosaic', math: ['sampling'], hint: 'Inspect the mosaic up close',
        line: 'Each photosite sees one colour through an RGGB filter. Two of every four are green, matching the eye’s luminance sensitivity.' },
      { key: 'falsecolor', label: 'False colour', math: ['sampling', 'filter'], hint: 'Zone plate, AA filter off',
        line: 'Each colour plane is sampled at only half the pixel rate, so detail finer than that aliases into colour fringes. An optical low-pass filter blurs it away before sampling.' },
      { key: 'quant', label: 'Quantisation', math: ['quant'], hint: 'Drop the bit depth',
        line: 'An N-bit ADC has 2ᴺ levels. Below about 6 bits, smooth gradients break into contour bands: false edges that are not in the scene.' },
      { key: 'wb', label: 'White balance', math: ['percept'], hint: 'Change the light, then balance',
        line: 'The sensor records E(λ)·R(λ). Scaling each channel so that grey comes out grey (von Kries / grey-world) recovers surface colour. This is colour constancy done in arithmetic.' },
      { key: 'clip', label: 'Full-well clipping', math: ['quant', 'noise'], hint: 'Overexpose on purpose',
        line: 'A photosite holds a finite charge (its full well). Past that, highlights saturate and the detail is gone; no gain or processing can bring it back.' },
    ],

    thumb(g, w, hh, t) {
      const s = 10, cols = Math.ceil(w / s), rows = Math.ceil(hh / s);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const c = cfa(x, y);
        const lum = 0.5 + 0.5 * Math.sin(x * 0.25 - t * 1.3 + Math.sin(y * 0.2 + t * 0.4) * 2);
        const n = Math.max(0, lum * (0.55 + 0.45 * Math.sin(t * 7 + x * 13.7 + y * 7.3)));
        const v = Math.round(40 + 200 * n);
        g.fillStyle = c === 0 ? `rgb(${v},20,40)` : c === 1 ? `rgb(20,${v},60)` : `rgb(20,50,${v})`;
        g.fillRect(x * s + 0.5, y * s + 0.5, s - 1, s - 1);
      }
      const gr = g.createLinearGradient(0, 0, w, 0);
      gr.addColorStop(0, 'rgba(8,10,17,0)'); gr.addColorStop(0.55, 'rgba(8,10,17,0.1)'); gr.addColorStop(1, 'rgba(8,10,17,0.85)');
      g.fillStyle = gr; g.fillRect(0, 0, w, hh);
    },

    build(ctx) {
      const st = { light: 100, exp: 1 / 100, iso: 100, read: 3, bits: 10, demosaic: 'bilinear', aa: false, illum: 'day', awb: false, stage: 4, live: true };
      let touched = false;
      let src = null;                 // current image source
      let baseDirty = true, dirty = true;
      const lin = [new Float32Array(N), new Float32Array(N), new Float32Array(N)]; // linear scene
      const base = new Float32Array(N);        // radiance at each photosite's own channel
      const sceneRGB = new Uint8ClampedArray(N * 4);
      let medianG = 0.2, sceneChroma = 0;
      const elec = new Float32Array(N), raw = new Float32Array(N);
      const dm = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
      const stageCv = STAGES.map(() => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; });
      const stageImg = stageCv.map((c) => c.getContext('2d').createImageData(W, H));
      const hist = [new Float32Array(128), new Float32Array(128), new Float32Array(128)];
      const history = [];
      const res = { meanN: 0, snr: 0, clip: 0, chroma: 0, flatN: 0 };
      ctx.root.__res = res; // exposed for automated checks

      /* ---------- stage ---------- */
      const tiles = STAGES.map((s, i) => {
        const cv = U.canvas(W, H, { cls: 'ns-tile-cv' });
        const el = h('button.ns-tile', { type: 'button' }, cv, h('span.ns-tile-l', null, h('b', null, i + 1), s.label));
        el.addEventListener('click', () => { st.stage = i; paintTiles(); drawMain(); });
        return { el, cv };
      });
      const paintTiles = () => tiles.forEach((t, i) => t.el.classList.toggle('on', i === st.stage));
      const mainCv = U.canvas(W, H, { pixel: true, cls: 'ns-main-cv' });
      const loupe = h('canvas.ns-loupe', { width: 176, height: 176 });
      const readout = U.tag('', 'acc');
      readout.classList.add('ns-readout');
      const stageTag = U.tag('', 'ns-stage-tag');
      const viewCard = h('div.card.ns-view', null, h('div.card-label', null, 'Viewfinder'), stageTag, h('div.ns-view-box', null, mainCv, loupe), readout);
      const snrCv = h('canvas.ns-plot');
      const histCv = h('canvas.ns-hist');
      ctx.stage.append(
        h('div.card.ns-strip', null, h('div.card-label', null, 'Pipeline'), h('div.ns-tiles', null, tiles.map((t) => t.el))),
        h('div.ns-main', null, viewCard,
          h('div.ns-side', null,
            U.card('SNR vs photons', snrCv, h('div.legend.ns-legend', null,
              h('span', null, h('i', { style: { background: 'var(--ink-faint)' } }), '√n'),
              h('span', null, h('i', { style: { background: 'var(--eye)' } }), '√n + read noise'),
              h('span', null, h('i', { style: { background: '#fff', height: '8px', width: '8px', borderRadius: '50%' } }), 'measured'))),
            U.card('Histogram', histCv))));
      paintTiles();

      /* ---------- rail ---------- */
      const mark = () => { touched = true; dirty = true; };
      const imgSrc = U.imageSource({
        camera: true, scenes: ['city', 'zone', 'market', 'text'], size: 512,
        onChange: (s) => { src = s; baseDirty = true; dirty = true; if (s.kind !== 'scene') touched = true; },
      });
      const sLight = U.slider({ label: 'Light', min: 0.05, max: 3000, log: true, step: 0, value: st.light, unit: 'lux',
        fmt: (v) => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v)), onInput: (v) => { st.light = v; mark(); } });
      const sExp = U.slider({ label: 'Shutter', min: 1 / 8000, max: 1, log: true, step: 0, value: st.exp,
        fmt: (v) => (v >= 0.4 ? v.toFixed(1) + ' s' : '1/' + Math.round(1 / v)), onInput: (v) => { st.exp = v; mark(); } });
      const sIso = U.slider({ label: 'ISO', min: 100, max: 25600, log: true, step: 1, value: st.iso,
        fmt: (v) => Math.round(v), onInput: (v) => { st.iso = v; st.isoTouched = true; mark(); } });
      const sRead = U.slider({ label: 'Read noise', min: 0, max: 20, step: 0.5, value: st.read, unit: 'e⁻', onInput: (v) => { st.read = v; mark(); } });
      const sBits = U.slider({ label: 'ADC', min: 2, max: 14, step: 1, value: st.bits, unit: 'bit', fmt: (v) => v, onInput: (v) => { st.bits = v; st.bitsTouched = true; mark(); } });
      const tAA = U.toggle({ label: 'Optical low-pass (AA)', value: st.aa, onChange: (v) => { st.aa = v; baseDirty = true; mark(); } });
      const sDem = U.seg({ label: 'Demosaic', options: [['raw', 'Raw'], ['nearest', 'Nearest'], ['bilinear', 'Bilinear']], value: st.demosaic,
        onChange: (v) => { st.demosaic = v; mark(); } });
      const sIll = U.seg({ label: 'Illuminant', options: Object.entries(ILLUM).map(([k, v]) => [k, v.label]), value: st.illum, wrap: true,
        onChange: (v) => { st.illum = v; baseDirty = true; mark(); } });
      const tWB = U.toggle({ label: 'Auto white balance', value: st.awb, onChange: (v) => { st.awb = v; st.wbTouched = true; mark(); } });
      const tLive = U.toggle({ label: 'Live noise', value: st.live, onChange: (v) => { st.live = v; dirty = true; } });
      const stN = U.stat('Photons', 'e⁻'), stS = U.stat('SNR', 'dB', { bar: true }), stC = U.stat('Clipped', '%'), stL = U.stat('Levels', '');
      const presets = h('div.btn-row', null,
        U.button({ label: 'Daylight', onClick: () => preset(100, 1 / 100, 100) }),
        U.button({ label: 'Night', onClick: () => preset(0.3, 1 / 60, 100) }),
        U.button({ label: 'Night ISO', onClick: () => preset(0.3, 1 / 60, 12800) }),
        U.button({ label: 'Long exp.', onClick: () => preset(0.3, 1, 100) }));
      function preset(l, e, iso) { sLight.set(l, true); sExp.set(e, true); sIso.set(iso, true); st.light = l; st.exp = e; st.iso = iso; st.isoTouched = true; mark(); }
      ctx.rail.append(
        U.group('Scene', imgSrc.el),
        U.group('Exposure', sLight.el, sExp.el, sIso.el, presets),
        U.group('Sensor', sRead.el, sBits.el, sDem.el, tAA.el),
        U.group('Colour', sIll.el, tWB.el),
        U.group('Readout', h('div.stat-grid', null, stN.el, stS.el, stC.el, stL.el), tLive.el));

      /* ---------- precompute per-scene radiance ---------- */
      function rebuildBase() {
        if (!src) return;
        const id = I.grab(src.el, W, H), d = id.data;
        for (let i = 0; i < N; i++) {
          lin[0][i] = I.toLinear(d[i * 4] / 255); lin[1][i] = I.toLinear(d[i * 4 + 1] / 255); lin[2][i] = I.toLinear(d[i * 4 + 2] / 255);
        }
        const t = ILLUM[st.illum].t;
        let planes = lin;
        if (st.aa) planes = lin.map((p) => I.blur(p, W, H, 0.85));
        const gs = [];
        let ch = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x, c = cfa(x, y);
          base[i] = planes[c][i] * t[c];
          if (c === 1 && ((x + y * 3) & 7) === 1) gs.push(base[i]);
          const r = lin[0][i] * t[0], g = lin[1][i] * t[1], b = lin[2][i] * t[2];
          const R = enc(r), G = enc(g), B = enc(b);
          sceneRGB[i * 4] = R; sceneRGB[i * 4 + 1] = G; sceneRGB[i * 4 + 2] = B; sceneRGB[i * 4 + 3] = 255;
          ch += Math.max(R, G, B) - Math.min(R, G, B);
        }
        gs.sort((a, b) => a - b);
        medianG = Math.max(1e-4, gs[gs.length >> 1] || 0.2);
        sceneChroma = ch / N / 255;
        stageImg[0].data.set(sceneRGB);
        stageCv[0].getContext('2d').putImageData(stageImg[0], 0, 0);
        baseDirty = false;
      }

      /* ---------- the pipeline ---------- */
      // signed ADC with a small black-level pedestal, so read noise is not rectified at zero
      const digitise = (n, gain, Lv) => { let v = (n * gain) / FULL_WELL; v = v < -0.05 ? -0.05 : v > 1 ? 1 : v; return Math.round(v * Lv) / Lv; };
      function run() {
        const scale = st.light * st.exp * Q, gain = st.iso / 100, Lv = 2 ** st.bits - 1, rn = st.read;
        let sumN = 0, clipN = 0;
        for (let i = 0; i < N; i++) {
          let n = pois(base[i] * scale) + rn * gt();
          if (n >= FULL_WELL) { n = FULL_WELL; clipN++; } else if ((n * gain) / FULL_WELL >= 1) clipN++;
          elec[i] = n; sumN += n;
          raw[i] = digitise(n, gain, Lv);
        }
        res.meanN = sumN / N; res.clip = (clipN / N) * 100;
        demosaic();
        // white balance (grey-world)
        let gains = [1, 1, 1];
        if (st.awb) {
          const m = dm.map((p) => { let s = 0; for (let i = 0; i < N; i += 3) s += p[i]; return s + 1e-9; });
          gains = [m[1] / m[0], 1, m[1] / m[2]];
        }
        // paint stages 1..4 + histogram + chroma
        const pn = Math.max(1, Math.min(FULL_WELL, res.meanN * 2.2 + 3 * Math.sqrt(res.meanN) + 2));
        const lut = I.lut('magma');
        const P = stageImg[1].data, M = stageImg[2].data, Dm = stageImg[3].data, O = stageImg[4].data;
        hist.forEach((hh) => hh.fill(0));
        let chroma = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x, j = i * 4;
          const v = Math.max(0, Math.min(255, ((elec[i] / pn) * 255) | 0));
          P[j] = lut[v * 3]; P[j + 1] = lut[v * 3 + 1]; P[j + 2] = lut[v * 3 + 2]; P[j + 3] = 255;
          const c = cfa(x, y), s = enc(raw[i]);
          M[j] = c === 0 ? s : 0; M[j + 1] = c === 1 ? s : 0; M[j + 2] = c === 2 ? s : 0; M[j + 3] = 255;
          const r = dm[0][i], g = dm[1][i], b = dm[2][i];
          Dm[j] = enc(r); Dm[j + 1] = enc(g); Dm[j + 2] = enc(b); Dm[j + 3] = 255;
          // false-colour measure: chromaticity of demosaiced pixel vs. the true (tinted) scene pixel
          const sr = sceneRGB[j], sg = sceneRGB[j + 1], sb = sceneRGB[j + 2], ss = sr + sg + sb + 30, ds = Dm[j] + Dm[j + 1] + Dm[j + 2] + 30;
          chroma += Math.abs((Dm[j] - Dm[j + 1]) / ds - (sr - sg) / ss) + Math.abs((Dm[j + 2] - Dm[j + 1]) / ds - (sb - sg) / ss);
          const R = enc(r * gains[0]), G = enc(g * gains[1]), B = enc(b * gains[2]);
          O[j] = R; O[j + 1] = G; O[j + 2] = B; O[j + 3] = 255;
          hist[0][R >> 1]++; hist[1][G >> 1]++; hist[2][B >> 1]++;
        }
        res.chroma = chroma / N;
        for (let k = 1; k < 5; k++) stageCv[k].getContext('2d').putImageData(stageImg[k], 0, 0);
        // measured SNR on a flat grey patch at the scene's median green level
        const lam = medianG * scale, M2 = 3000;
        let s1 = 0, s2 = 0;
        for (let k = 0; k < M2; k++) {
          let n = pois(lam) + rn * gt();
          if (n > FULL_WELL) n = FULL_WELL;
          const v = digitise(n, gain, Lv);
          s1 += v; s2 += v * v;
        }
        const mu = s1 / M2, sd = Math.sqrt(Math.max(0, s2 / M2 - mu * mu));
        res.flatN = lam;
        res.snr = mu <= 0 ? 0.01 : sd <= 1e-9 ? 3000 : mu / sd;
        history.push({ n: Math.max(0.05, lam), s: Math.max(0.05, res.snr) });
        if (history.length > 90) history.shift();
        updateStats();
        drawMain(); drawTiles(); drawSNR(); drawHist();
        checkDiscoveries();
      }

      function demosaic() {
        const [R, G, B] = dm;
        const mode = st.demosaic;
        if (mode === 'raw') {
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x, c = cfa(x, y);
            R[i] = c === 0 ? raw[i] : 0; G[i] = c === 1 ? raw[i] : 0; B[i] = c === 2 ? raw[i] : 0;
          }
          return;
        }
        if (mode === 'nearest') {
          for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
            const i = y * W + x, r = raw[i], g = 0.5 * (raw[i + 1] + raw[i + W]), b = raw[i + W + 1];
            for (const k of [i, i + 1, i + W, i + W + 1]) { R[k] = r; G[k] = g; B[k] = b; }
          }
          return;
        }
        // bilinear: own channel kept, missing channels = weighted mean of 3×3 neighbours of that colour
        const K = [1, 2, 1, 2, 4, 2, 1, 2, 1];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x, own = cfa(x, y);
          const num = [0, 0, 0], den = [0, 0, 0];
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= W) continue;
              const c = cfa(xx, yy), k = K[(dy + 1) * 3 + dx + 1];
              num[c] += k * raw[yy * W + xx]; den[c] += k;
            }
          }
          R[i] = own === 0 ? raw[i] : num[0] / (den[0] || 1);
          G[i] = own === 1 ? raw[i] : num[1] / (den[1] || 1);
          B[i] = own === 2 ? raw[i] : num[2] / (den[2] || 1);
        }
      }

      /* ---------- drawing ---------- */
      function drawTiles() {
        tiles.forEach((t, k) => { const g = t.cv.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(stageCv[k], 0, 0); });
      }
      let hover = null;
      function drawMain() {
        const g = mainCv.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(stageCv[st.stage], 0, 0);
        stageTag.textContent = `${st.stage + 1} · ${STAGES[st.stage].label.toUpperCase()}`;
        drawLoupe();
      }
      function drawLoupe() {
        if (!hover) { loupe.style.opacity = 0; readout.style.opacity = 0; return; }
        const Z = 8, R = 11, L = 176;
        const sx = Math.max(0, Math.min(W - 2 * R, Math.round(hover.x) - R)), sy = Math.max(0, Math.min(H - 2 * R, Math.round(hover.y) - R));
        const g = loupe.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.clearRect(0, 0, L, L);
        g.drawImage(stageCv[st.stage], sx, sy, 2 * R, 2 * R, 0, 0, 2 * R * Z, 2 * R * Z);
        if (st.stage === 1 || st.stage === 2) {
          g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1;
          g.beginPath();
          for (let k = 0; k <= 2 * R; k++) { g.moveTo(k * Z + 0.5, 0); g.lineTo(k * Z + 0.5, L); g.moveTo(0, k * Z + 0.5); g.lineTo(L, k * Z + 0.5); }
          g.stroke();
        }
        const cx = Math.round(hover.x) - sx, cy = Math.round(hover.y) - sy;
        g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect(cx * Z + 0.5, cy * Z + 0.5, Z, Z);
        const box = mainCv.getBoundingClientRect(), u = hover.x / W, v = hover.y / H;
        let lx = u * box.width + 22, ly = v * box.height - L / 2;
        if (lx + L > box.width) lx = u * box.width - L - 22;
        ly = Math.max(4, Math.min(box.height - L - 4, ly));
        loupe.style.transform = `translate(${lx}px, ${ly}px)`;
        loupe.style.opacity = 1;
        const xi = Math.max(0, Math.min(W - 1, Math.round(hover.x))), yi = Math.max(0, Math.min(H - 1, Math.round(hover.y)));
        const i = yi * W + xi, c = 'RGB'[cfa(xi, yi)];
        readout.textContent = `${c} · ${Math.round(elec[i])} e⁻ · code ${Math.round(raw[i] * (2 ** st.bits - 1))}`;
        readout.style.opacity = 1;
      }
      let loupeMs = 0;
      U.pointer(mainCv, (p) => {
        if (p.type === 'leave') { hover = null; drawLoupe(); return; }
        hover = { x: p.u * W, y: p.v * H };
        drawLoupe();
      });

      function drawSNR() {
        const { ctx: g, w, h: hh } = U.fit(snrCv), th = U.theme();
        g.clearRect(0, 0, w, hh);
        const L = 38, R = 10, T = 10, B = 24;
        const x0 = -1, x1 = 5, y0 = -1, y1 = 3; // log10 ranges: photons 0.1..1e5, SNR 0.1..1000
        const X = (n) => L + ((Math.log10(n) - x0) / (x1 - x0)) * (w - L - R);
        const Y = (s) => hh - B - ((Math.log10(s) - y0) / (y1 - y0)) * (hh - T - B);
        g.font = '500 9.5px "JetBrains Mono", monospace'; g.fillStyle = th.faint; g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1;
        for (let e = x0; e <= x1; e++) { const x = X(10 ** e); g.beginPath(); g.moveTo(x, T); g.lineTo(x, hh - B); g.stroke(); g.textAlign = 'center'; g.fillText(e < 0 ? '0.1' : e < 3 ? String(10 ** e) : `1e${e}`, x, hh - B + 13); }
        for (let e = y0; e <= y1; e++) { const y = Y(10 ** e); g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke(); g.textAlign = 'right'; g.fillText(e < 0 ? '0.1' : String(10 ** e), L - 5, y + 3); }
        g.textAlign = 'right'; g.fillStyle = th.dim; g.fillText('photons / pixel', w - R - 4, hh - B - 6);
        g.textAlign = 'left'; g.fillText('SNR', L + 6, T + 10);
        // full well
        g.strokeStyle = 'rgba(255,107,107,.45)'; g.setLineDash([3, 4]);
        g.beginPath(); g.moveTo(X(FULL_WELL / Math.max(1, st.iso / 100)), T); g.lineTo(X(FULL_WELL / Math.max(1, st.iso / 100)), hh - B); g.stroke(); g.setLineDash([]);
        g.fillStyle = 'rgba(255,107,107,.7)'; g.textAlign = 'right'; g.fillText('clip', X(FULL_WELL / Math.max(1, st.iso / 100)) - 4, T + 10);
        // theory
        const curve = (f, col, dash) => {
          g.beginPath();
          for (let k = 0; k <= 120; k++) { const n = 10 ** (x0 + ((x1 - x0) * k) / 120), s = Math.max(1e-3, f(n)); const x = X(n), y = Y(s); k ? g.lineTo(x, y) : g.moveTo(x, y); }
          g.strokeStyle = col; g.lineWidth = 1.6; g.setLineDash(dash || []); g.stroke(); g.setLineDash([]);
        };
        g.save(); g.beginPath(); g.rect(L, T, w - L - R, hh - T - B); g.clip();
        curve((n) => Math.sqrt(n), th.faint, [4, 4]);
        curve((n) => n / Math.sqrt(n + st.read * st.read), th.eye);
        // history trail
        history.forEach((p, k) => {
          g.globalAlpha = 0.1 + (0.5 * k) / history.length;
          g.fillStyle = th.eye; g.beginPath(); g.arc(X(p.n), Y(p.s), 2.2, 0, 7); g.fill();
        });
        g.globalAlpha = 1;
        const cur = history[history.length - 1];
        if (cur) {
          g.fillStyle = '#fff'; g.shadowColor = th.eye; g.shadowBlur = 12;
          g.beginPath(); g.arc(X(cur.n), Y(cur.s), 5, 0, 7); g.fill(); g.shadowBlur = 0;
        }
        g.restore();
      }
      function drawHist() {
        const { ctx: g, w, h: hh } = U.fit(histCv);
        g.clearRect(0, 0, w, hh);
        let mx = 1;
        for (const hh2 of hist) for (let k = 1; k < 127; k++) mx = Math.max(mx, hh2[k]);
        const cols = ['rgba(255,80,110,.75)', 'rgba(80,255,160,.65)', 'rgba(90,160,255,.75)'];
        g.globalCompositeOperation = 'lighter';
        const bw = (w - 8) / 128;
        hist.forEach((hh2, c) => {
          g.fillStyle = cols[c];
          for (let k = 0; k < 128; k++) {
            const v = Math.min(1, Math.sqrt(hh2[k] / mx));
            g.fillRect(4 + k * bw, hh - 14 - v * (hh - 26), Math.max(1, bw - 0.3), v * (hh - 26));
          }
        });
        g.globalCompositeOperation = 'source-over';
        if (res.clip > 1) {
          g.fillStyle = 'rgba(255,107,107,.9)'; g.fillRect(w - 6, 8, 3, hh - 22);
          g.font = '600 9.5px "JetBrains Mono", monospace'; g.textAlign = 'right'; g.fillText('CLIP', w - 10, 18);
        }
        g.fillStyle = 'rgba(255,255,255,.1)'; g.fillRect(4, hh - 13, w - 8, 1);
        g.font = '500 9.5px "JetBrains Mono", monospace'; g.fillStyle = U.theme().faint;
        g.textAlign = 'left'; g.fillText('0', 4, hh - 2); g.textAlign = 'right'; g.fillText('255', w - 4, hh - 2);
      }
      function updateStats() {
        const n = res.meanN;
        stN.set(n < 10 ? n.toFixed(1) : n < 1e4 ? Math.round(n) : (n / 1000).toFixed(1) + 'k', `flat patch ${res.flatN < 10 ? res.flatN.toFixed(1) : Math.round(res.flatN)}`);
        const db = 20 * Math.log10(Math.max(0.01, res.snr));
        stS.set(res.snr >= 3000 ? '∞' : db.toFixed(1), res.snr >= 3000 ? 'noise below 1 LSB' : `${res.snr.toFixed(1)} : 1`, db / 50);
        stS.color(db < 10 ? 'var(--bad)' : db < 25 ? 'var(--warn)' : 'var(--good)');
        stC.set(res.clip.toFixed(1)); stC.color(res.clip > 2 ? 'var(--bad)' : 'var(--eye)');
        stL.set(String(2 ** st.bits), `${st.bits}-bit ADC`);
      }

      /* ---------- insights ---------- */
      function checkDiscoveries() {
        if (!touched) return;
        if (res.flatN < 10) ctx.discover('shot');
        if (st.isoTouched && st.iso >= 3200 && res.flatN < 300) ctx.discover('iso');
        if (st.bitsTouched && st.bits <= 5) ctx.discover('quant');
        if (res.clip > 6) ctx.discover('clip');
        if (st.wbTouched && st.awb && st.illum !== 'day') ctx.discover('wb');
        if (!st.aa && st.demosaic !== 'raw' && st.stage >= 3 && res.meanN > 400 && res.chroma > FC_THR) ctx.discover('falsecolor');
      }

      /* ---------- loop ---------- */
      let lastRun = 0;
      ctx.frame((t, dt) => {
        if (hover && st.stage === 2) { loupeMs += dt * 1000; if (loupeMs > 700) ctx.discover('bayer'); }
        const now = performance.now();
        const video = src && src.kind === 'video';
        if (video && now - lastRun > 90) baseDirty = true;
        if (baseDirty && src) { rebuildBase(); dirty = true; }
        const due = dirty ? now - lastRun > 40 : st.live && now - lastRun > 110;
        if (due && src && !baseDirty) {
          dirty = false; lastRun = now;
          run();
        }
      });
      ctx.on(window, 'resize', () => { drawSNR(); drawHist(); });
    },
  });
})();
