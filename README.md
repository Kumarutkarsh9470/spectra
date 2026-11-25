# SPECTRA — two senses, one mathematics

An interactive web app made of **eight application-level instruments** built on the IIT Guwahati courses
[Vision & Image Processing](https://spinlabiitg.github.io/vip/) and [Speech & Audio Processing](https://spinlabiitg.github.io/sap/).

The course pages teach each topic on its own. SPECTRA asks what happens when you **use** the topics:
build a camera, a CT scanner, a VR foveated renderer, a voice codec. It also shows that the same mathematics
(Fourier analysis, sampling, noise, filtering, prediction, quantisation, perception) runs both the eye and the ear.

There are no lecture pages. Each lab hides **insights** (57 in total). An insight unlocks only when you do the
thing that shows the concept, for example pushing ISO in the dark or dragging a pole outside the unit circle.
Then a one-line explanation appears. The hub's constellation map lights up the links between labs and the
shared mathematics as you go.

## Run it

- **Easiest:** double-click `start.bat`. It serves the folder on <http://localhost:8137> and opens it.
  Serving over localhost is what lets the browser allow the **webcam and microphone**.
- Or open `index.html` directly. Everything works except, in some browsers, the camera and microphone.
- No install, no build step, no libraries. It is plain HTML, CSS and JavaScript, and it works offline
  (fonts fall back to system fonts).
- To host it, push the folder to GitHub Pages. Pages serves over https, so the camera and microphone work there too.

## The instruments

| Code | Lab | What you do | Course material used |
|---|---|---|---|
| E1 | **Night Shot** | Build a camera from photons up: Poisson photon arrivals, RGGB Bayer mosaic, read noise, full-well clipping, ISO gain, ADC bits, demosaicing, anti-alias filter, white balance. Works on a live webcam. | VIP M1 §3–6 |
| E2 | **Spectral Darkroom** | Repair a photo ruined by periodic interference by painting notches on its 2-D spectrum. Sculpt with filters and see the matching convolution kernel. Swap magnitude and phase. Make hybrid images. | VIP M2 §2–3, §7, §9–11 |
| E3 | **CT Scanner** | Watch a gantry rotate, a sinogram fill and an image rebuild by (filtered) back-projection. Shows the projection-slice theorem live, k-space coverage, few-view streaks, the missing wedge and dose noise. Draw your own phantom. | VIP M2 §4, §11 · VIP M1 §5 |
| E4 | **Foveal Engine** | Your cursor is the fovea. Eccentricity-dependent acuity, peripheral colour loss, the blind spot and the rendering budget a VR headset saves. An Itti–Koch saliency model then predicts a scanpath with inhibition of return, and scores it against your own gaze (NSS). | VIP M3 §1, §4–5, §7 |
| B1 | **Modulation Lab** | The bridge between the courses. Take a spectrogram, run the image-processing 2-D FFT on it to get the modulation spectrum, filter it, and resynthesise with Griffin-Lim. Hear the syllable rhythm survive and pitch dissolve. Also turns images and typed text into sound, and lets you draw a sound. | SAP M1 · VIP M2 |
| A1 | **Voice Space** | Live mic or a clip. Spectrogram with a wideband↔narrowband window, LPC envelope, z-plane poles, F0 and formant tracks, and a vowel chart you steer with your own voice (vowel-quest game). | SAP M1, M3, M5 |
| A2 | **Pole Instrument** | A real-time synthesiser you play by dragging poles in the z-plane: glottal source → all-pole vocal tract. Includes a vowel morph pad, tract-length scaling, whisper, and a source + filter = output view in dB. | SAP M3, M5 |
| A3 | **The Wire** | Squeeze a voice through a century of telephony: PCM, G.711 μ-law, G.726-style ADPCM (with an encoder-drift toggle) and an LPC-10-style 2.4 kbps vocoder. Bit-rate gauge, SNR, segmental SNR and log-spectral distance. Shows why SNR is useless for judging a vocoder. | SAP M6, M4 |

Every lab ships with a built-in test scene and a synthesised demo voice, so nothing needs a camera or microphone.
You can also load your own images and audio.

## Written from scratch

None of the signal processing uses a library:

- radix-2 FFT, 2-D FFT, STFT/ISTFT (WOLA), fast Griffin-Lim
- LPC: autocorrelation, Levinson-Durbin, polynomial roots (Durand–Kerner), formants and poles
- normalised-autocorrelation pitch detection
- Rosenberg glottal source and cascade formant synthesiser
- Poisson sensor model, Bayer demosaicing
- filtered back-projection with Ram-Lak, Shepp-Logan and Hann filters
- Itti–Koch saliency
- μ-law, ADPCM with Jayant step adaptation, LPC vocoder with log-area-ratio quantisation
- an AudioWorklet synthesiser

## Layout

```
index.html            page shell (loads core, then labs, then the app)
start.bat             local server launcher
css/style.css         design system
css/labs/*.css        per-lab styles
js/core/dsp.js        DSP toolkit (FFT, STFT, Griffin-Lim, LPC, pitch, filters, quantisers)
js/core/img.js        image toolkit (colormaps, procedural scenes, blur, webcam)
js/core/audio.js      audio (playback, mic, recording, formant synthesiser, vowel table)
js/core/ui.js         UI kit + lab registry
js/core/app.js        router, lab lifecycle, insight system, hub + constellation
js/labs/*.js          the eight instruments
```

Adding an instrument means one file that calls `SL.lab({ id, side, code, title, tagline, concepts, build(ctx), thumb })`.
