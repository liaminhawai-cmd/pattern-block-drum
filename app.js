'use strict';

/* =========================================================================
   Pattern Block Drum Machine
   - The "fraction wall" is a palette of blocks (1, 1/2 ... 1/12).
   - You drag a block into a lane. Each lane is one bar; blocks tile from the
     left and a block's width is its length in time.
   - Each block has 4 faces = dynamics: mute / soft / mid / loud.
     A muted block still holds its time, so it acts as a rest.
   - Right-click a block to subdivide it (e.g. a 1/5 cut into 3 -> 1/15).
   ========================================================================= */

/* ------------------------------ constants ------------------------------ */
const ROWS = 12;                        // starting fraction wall rows: 1 .. 1/12
const EPS = 1e-9;
const FACES = ['loud', 'mid', 'soft', 'mute'];   // click-rotation order
const FACE_GAIN = { loud: 1.0, mid: 0.6, soft: 0.3, mute: 0 };
const FACE_VEL = { loud: 127, mid: 90, soft: 55, mute: 0 };   // MIDI velocity
const FACE_DOTS = { loud: '•••', mid: '••', soft: '•', mute: '×' };

// General-MIDI drum notes matched to the built-in voices (channel 10).
const GM_NOTES = [36, 38, 39, 42, 46, 45, 63, 37, 56, 70, 75, 53];
const MIDI_CH = 9;                      // 0-indexed channel 10 (GM drums)

/* ------------------------------ prime-factor colour --------------------- */
// Every prime gets its own strong hue. A prime power (9 = 3^2) keeps that hue
// but grows more saturated/darker as the exponent rises ("super red"). A
// composite of distinct primes (6 = 2*3, 12 = 2^2*3) gets the exponent-weighted
// circular mean of its prime factors' hues, so 12 leans twice as hard toward
// blue as 6 does and reads as "blueish purple" next to 6's plain purple.
const PRIME_HUE = { 2: 214, 3: 356, 5: 42, 7: 150, 11: 320, 13: 185 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function hueForPrime(p) { return PRIME_HUE[p] != null ? PRIME_HUE[p] : (p * 61) % 360; }

function primeFactorize(n) {
  const factors = new Map();
  let m = n;
  for (let p = 2; p * p <= m; p++) {
    while (m % p === 0) { factors.set(p, (factors.get(p) || 0) + 1); m /= p; }
  }
  if (m > 1) factors.set(m, (factors.get(m) || 0) + 1);
  return factors;
}

// Colour for a denominator (the fraction wall "row" a block belongs to).
function denColor(den) {
  if (den <= 1) return 'hsl(224 12% 42%)';   // the whole bar "1" — no prime factors, neutral
  const factors = [...primeFactorize(den)];
  let vx = 0, vy = 0, total = 0;
  for (const [p, a] of factors) {
    const hue = hueForPrime(p) * Math.PI / 180;
    vx += Math.cos(hue) * a; vy += Math.sin(hue) * a; total += a;
  }
  let hueDeg = Math.atan2(vy, vx) * 180 / Math.PI;
  if (hueDeg < 0) hueDeg += 360;
  let sat, light;
  if (factors.length === 1) {
    const exp = factors[0][1];
    sat = clamp(70 + (exp - 1) * 12, 0, 100);
    light = clamp(52 - (exp - 1) * 6, 22, 60);
  } else {
    const agreement = Math.hypot(vx, vy) / total;   // 1 = factors agree, 0 = they cancel out (opposed hues)
    sat = clamp(30 + agreement * 55, 15, 90);
    light = 50;
  }
  return `hsl(${hueDeg.toFixed(1)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
}

/* ------------------------------ fraction math -------------------------- */
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function reduce(n, d) { const g = gcd(n, d) || 1; return { n: n / g, d: d / g }; }
const fval = (b) => b.n / b.d;
function fracLabel(b) {
  const r = reduce(b.n, b.d);
  if (r.d === 1) return String(r.n);
  return `${r.n}/${r.d}`;
}
// Exact rational addition (avoids float drift for the running lane total).
function addFrac(a, b) { return reduce(a.n * b.d + b.n * a.d, a.d * b.d); }
function laneSumFrac(lane) { return lane.blocks.reduce((s, b) => addFrac(s, b), { n: 0, d: 1 }); }
// A lane is "complete" once its blocks account for the whole bar exactly (mute
// blocks count — they're rests). Used by Learn mode to gate playback.
function laneComplete(lane) {
  if (!lane.blocks.length) return false;
  const s = laneSumFrac(lane);
  return s.n === s.d;
}

/* ------------------------------ state ---------------------------------- */
// Built-in synth voices (rendered to buffers at startup).
const VOICES = ['Kick', 'Snare', 'Clap', 'Closed Hat', 'Open Hat', 'Tom',
  'Conga', 'Rimshot', 'Cowbell', 'Shaker', 'Clave', 'Bell'];

let laneSeq = 0;
const newLane = (voice, blocks = []) => ({
  id: ++laneSeq,
  name: VOICES[voice % VOICES.length],
  voice: voice % VOICES.length,
  buffer: null,          // custom sample overrides the synth voice
  node: null,            // per-lane gain node (created lazily)
  gain: 0.85,
  muted: false,
  solo: false,
  midi: GM_NOTES[voice % VOICES.length],   // MIDI note this lane sends
  blocks,                // [{ n, d, face }]
});

// A block helper.
const blk = (n, d, face = 'loud') => ({ n, d, face });

const state = {
  bpm: 96,
  master: 0.9,
  playing: false,
  mode: 'create',   // 'create' (free play) or 'learn' (lanes gate on completeness, tutorial)
  tones: false,     // play the beat as pitched notes instead of drum samples
  lesson: 0, step: 0,   // tutorial position (Learn mode)
  lanes: [],
  denominators: Array.from({ length: ROWS }, (_, i) => i + 1),   // fraction-wall rows
};

// Add a denominator row to the wall if a unit fraction 1/d isn't there yet.
function registerFraction(block) {
  const r = reduce(block.n, block.d);
  if (r.n !== 1) return false;               // only unit fractions get a wall row
  if (state.denominators.includes(r.d)) return false;
  state.denominators.push(r.d);
  state.denominators.sort((a, b) => a - b);
  return true;
}
function registerAllFractions() {
  let added = false;
  for (const lane of state.lanes) for (const b of lane.blocks) added = registerFraction(b) || added;
  return added;
}

/* seed a groovy, instructive default kit ------------------------------- */
function seedDefault() {
  laneSeq = 0;
  state.lanes = [
    // Kick: on the halves — beats 1 & 3.
    newLane(0, [blk(1, 2, 'loud'), blk(1, 2, 'mid')]),
    // Snare: on the backbeats — quarter of silence, then a half (beat 2), then a
    // quarter (beat 4). Hits land on 2 and 4.
    newLane(1, [blk(1, 4, 'mute'), blk(1, 2, 'loud'), blk(1, 4, 'loud')]),
    // Closed hat: steady quarters.
    newLane(3, [blk(1, 4, 'soft'), blk(1, 4, 'mid'), blk(1, 4, 'soft'), blk(1, 4, 'mid')]),
    // Jazzy rimshot: a laid-back cross-stick on beats 2 and 4 with a little
    // "and of 3" pickup — the classic jazz comping feel.
    newLane(7, [blk(1, 4, 'mute'), blk(1, 4, 'mid'), blk(1, 8, 'mute'), blk(1, 8, 'soft'), blk(1, 4, 'mid')]),
  ];
}
seedDefault();

/* ------------------------------ audio ---------------------------------- */
let ctx = null, masterNode = null;
const voiceBuffers = new Array(VOICES.length).fill(null);
const activeSources = new Set();        // buffer sources currently sounding

function ensureAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  masterNode = ctx.createGain();
  masterNode.gain.value = state.master;
  masterNode.connect(ctx.destination);
  renderVoices();
  state.lanes.forEach(ensureLaneNode);
  applyLaneGains();
}

// Silence everything that is currently playing (fixes long samples ringing on
// after Stop). Optionally limit to one lane, e.g. when its sample is swapped.
function stopSources(lane) {
  for (const entry of [...activeSources]) {
    if (lane && entry.lane !== lane) continue;
    try { entry.src.stop(); } catch (_) { /* already stopped */ }
    activeSources.delete(entry);
  }
}

function ensureLaneNode(lane) {
  if (lane.node) return;
  lane.node = ctx.createGain();
  lane.node.connect(masterNode);
}

function anySolo() { return state.lanes.some((l) => l.solo); }
function applyLaneGains() {
  if (!ctx) return;
  const solo = anySolo();
  for (const l of state.lanes) {
    ensureLaneNode(l);
    const audible = l.muted ? 0 : (solo && !l.solo ? 0 : 1);
    l.node.gain.setTargetAtTime(l.gain * audible, ctx.currentTime, 0.01);
  }
}

function laneBuffer(lane) { return lane.buffer || voiceBuffers[lane.voice]; }

// Lanes stacked on a minor-pentatonic scale, so whatever combination of lanes
// hits together in Tones mode sounds consonant — coincident hits become chords.
const TONE_DEGREES = [0, 3, 5, 7, 10];
function laneToneFreq(li) {
  const base = 48;   // C3-ish
  const semis = TONE_DEGREES[li % TONE_DEGREES.length] + 12 * Math.floor(li / TONE_DEGREES.length);
  return 440 * Math.pow(2, (base + semis - 69) / 12);
}

// Fire a lane's sound (and MIDI, if enabled) at audio-time `when`.
function fire(lane, li, face, when) {
  if (face === 'mute') return;
  ensureLaneNode(lane);
  if (state.tones) {
    // Play the beat as a pitched note instead of the drum sample.
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = laneToneFreq(li);
    const g = ctx.createGain();
    const peak = FACE_GAIN[face] * 0.5;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.5);
    o.connect(g).connect(lane.node);
    const entry = { src: o, lane };
    o.onended = () => activeSources.delete(entry);
    activeSources.add(entry);
    o.start(when); o.stop(when + 0.55);
  } else {
    const buf = laneBuffer(lane);
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = FACE_GAIN[face];
      src.connect(g).connect(lane.node);
      const entry = { src, lane };
      src.onended = () => activeSources.delete(entry);
      activeSources.add(entry);
      src.start(when);
    }
  }
  midiFire(lane, face, when);
}

/* ------------------------------ MIDI out ------------------------------- */
let midiAccess = null, midiOut = null, midiEnabled = false;

function midiFire(lane, face, when) {
  if (!midiEnabled || !midiOut || face === 'mute') return;
  const note = lane.midi | 0;
  const vel = FACE_VEL[face];
  // Convert audio-clock time to the performance.now() domain Web MIDI expects.
  const tOn = performance.now() + Math.max(0, (when - ctx.currentTime) * 1000);
  midiOut.send([0x90 | MIDI_CH, note, vel], tOn);
  midiOut.send([0x80 | MIDI_CH, note, 0], tOn + 110);   // note-off after a short gate
}

async function toggleMidi() {
  if (midiEnabled) { midiEnabled = false; refreshMidiUI(); return; }
  if (!navigator.requestMIDIAccess) { toast('Web MIDI isn\'t supported in this browser'); return; }
  try {
    if (!midiAccess) {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      midiAccess.onstatechange = populateMidiPorts;
    }
    populateMidiPorts();
    if (!midiOut) { toast('No MIDI output found — connect a device or virtual port'); return; }
    midiEnabled = true;
    refreshMidiUI();
  } catch (err) {
    toast('MIDI permission was blocked');
  }
}

function populateMidiPorts() {
  const sel = document.getElementById('midiPort');
  if (!sel || !midiAccess) return;
  const outs = [...midiAccess.outputs.values()];
  sel.innerHTML = '';
  outs.forEach((o) => { const opt = document.createElement('option'); opt.value = o.id; opt.textContent = o.name; sel.appendChild(opt); });
  if (outs.length) {
    if (!midiOut || !outs.some((o) => o.id === midiOut.id)) midiOut = outs[0];
    sel.value = midiOut.id;
  } else {
    midiOut = null;
  }
  refreshMidiUI();
}

function refreshMidiUI() {
  const btn = document.getElementById('midiToggle');
  const sel = document.getElementById('midiPort');
  if (!btn || !sel) return;
  btn.textContent = midiEnabled ? 'On' : 'Off';
  btn.classList.toggle('on', midiEnabled);
  sel.hidden = !(midiAccess && midiAccess.outputs.size);
}

/* ------------------------------ synth voices --------------------------- */
// Each voice is rendered once into an AudioBuffer so playback is a one-shot.
function renderVoices() {
  if (voiceBuffers[0]) return;
  VOICES.forEach((_, i) => { voiceBuffers[i] = renderVoice(i); });
}

function renderVoice(i) {
  const sr = 44100;
  const dur = [0.5, 0.3, 0.3, 0.09, 0.4, 0.4, 0.35, 0.08, 0.5, 0.1, 0.07, 0.9][i] || 0.4;
  const oac = new OfflineAudioContext(1, Math.ceil(sr * dur), sr);
  const out = oac.destination;
  const t0 = 0;

  const env = (node, a, peak, d) => {
    const g = oac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    node.connect(g); return g;
  };
  const noise = (len) => {
    const b = oac.createBuffer(1, Math.ceil(sr * len), sr);
    const d = b.getChannelData(0);
    for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
    const s = oac.createBufferSource(); s.buffer = b; return s;
  };

  switch (i) {
    case 0: { // Kick
      const o = oac.createOscillator();
      o.frequency.setValueAtTime(150, t0);
      o.frequency.exponentialRampToValueAtTime(48, t0 + 0.12);
      env(o, 0.002, 1, 0.32).connect(out); o.start(t0); o.stop(t0 + 0.5); break;
    }
    case 1: { // Snare
      const n = noise(0.3); const hp = oac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400;
      n.connect(hp); env(hp, 0.001, 0.8, 0.18).connect(out);
      const o = oac.createOscillator(); o.type = 'triangle'; o.frequency.value = 190;
      env(o, 0.001, 0.5, 0.12).connect(out); n.start(t0); o.start(t0); o.stop(t0 + 0.2); break;
    }
    case 2: { // Clap
      for (const off of [0, 0.01, 0.02, 0.035]) {
        const n = noise(0.12); const bp = oac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.8;
        n.connect(bp); const g = oac.createGain();
        g.gain.setValueAtTime(0.0001, t0 + off);
        g.gain.exponentialRampToValueAtTime(0.8, t0 + off + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.08);
        bp.connect(g).connect(out); n.start(t0 + off);
      } break;
    }
    case 3: { // Closed hat
      const n = noise(0.09); const hp = oac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
      n.connect(hp); env(hp, 0.001, 0.6, 0.05).connect(out); n.start(t0); break;
    }
    case 4: { // Open hat
      const n = noise(0.4); const hp = oac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500;
      n.connect(hp); env(hp, 0.001, 0.5, 0.34).connect(out); n.start(t0); break;
    }
    case 5: { // Tom
      const o = oac.createOscillator();
      o.frequency.setValueAtTime(220, t0); o.frequency.exponentialRampToValueAtTime(90, t0 + 0.3);
      env(o, 0.002, 0.9, 0.34).connect(out); o.start(t0); o.stop(t0 + 0.4); break;
    }
    case 6: { // Conga
      const o = oac.createOscillator();
      o.frequency.setValueAtTime(330, t0); o.frequency.exponentialRampToValueAtTime(180, t0 + 0.18);
      env(o, 0.002, 0.9, 0.3).connect(out); o.start(t0); o.stop(t0 + 0.35); break;
    }
    case 7: { // Rim / jazz cross-stick — a woody click with a short pitched ring
      const click = noise(0.02); const bp = oac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 3;
      click.connect(bp); env(bp, 0.0004, 0.6, 0.02).connect(out); click.start(t0);
      const body = oac.createOscillator(); body.type = 'triangle'; body.frequency.value = 420;
      env(body, 0.0008, 0.45, 0.05).connect(out); body.start(t0); body.stop(t0 + 0.08);
      const ring = oac.createOscillator(); ring.type = 'sine'; ring.frequency.value = 1650;
      env(ring, 0.0006, 0.25, 0.04).connect(out); ring.start(t0); ring.stop(t0 + 0.06); break;
    }
    case 8: { // Cowbell
      const mk = (f) => { const o = oac.createOscillator(); o.type = 'square'; o.frequency.value = f; return o; };
      const a = mk(560), b = mk(845); const g = oac.createGain();
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      a.connect(g); b.connect(g); g.connect(out); a.start(t0); b.start(t0); a.stop(t0 + 0.5); b.stop(t0 + 0.5); break;
    }
    case 9: { // Shaker
      const n = noise(0.1); const hp = oac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
      n.connect(hp); env(hp, 0.005, 0.5, 0.06).connect(out); n.start(t0); break;
    }
    case 10: { // Clave
      const o = oac.createOscillator(); o.frequency.value = 2500;
      env(o, 0.0005, 0.7, 0.05).connect(out); o.start(t0); o.stop(t0 + 0.07); break;
    }
    default: { // Bell (FM-ish)
      const car = oac.createOscillator(); car.frequency.value = 660;
      const mod = oac.createOscillator(); mod.frequency.value = 1700;
      const mg = oac.createGain(); mg.gain.value = 600; mod.connect(mg).connect(car.frequency);
      env(car, 0.002, 0.55, 0.8).connect(out); car.start(t0); mod.start(t0); car.stop(t0 + 0.9); mod.stop(t0 + 0.9);
    }
  }
  // Render synchronously enough; return a promise-resolved buffer via a stub.
  const buffer = oac.startRendering();
  // startRendering returns a promise; we resolve it into the slot when ready.
  buffer.then((b) => { voiceBuffers[i] = b; });
  return null; // placeholder until the promise resolves
}

/* ------------------------------ scheduler ------------------------------ */
let events = [];         // { time: 0..1, lane: index, face, li, bi }
let eventsDirty = true;
let nextIndex = 0;
let loopStart = 0;
let schedTimer = null;

const loopDur = () => (60 / state.bpm) * 4;   // one bar = 4 beats

function markDirty() { eventsDirty = true; }

function rebuildEvents() {
  events = [];
  state.lanes.forEach((lane, li) => {
    if (state.mode === 'learn' && !laneComplete(lane)) return;   // silent until the bar is fully accounted for
    let off = 0;
    lane.blocks.forEach((b, bi) => {
      if (b.face !== 'mute' && off < 1 - EPS) {
        events.push({ time: off, lane: li, face: b.face, li: lane.id, bi });
      }
      off += fval(b);
    });
  });
  events.sort((a, b) => a.time - b.time);
  eventsDirty = false;
}

function resync() {
  rebuildEvents();
  if (!state.playing) return;
  const dur = loopDur();
  let phase = ((ctx.currentTime - loopStart) / dur) % 1;
  if (phase < 0) phase += 1;
  loopStart = ctx.currentTime - phase * dur;
  nextIndex = events.findIndex((e) => e.time >= phase - EPS);
  if (nextIndex < 0) { nextIndex = 0; loopStart += dur; }
}

function scheduler() {
  if (eventsDirty) resync();
  if (!events.length) return;
  const ahead = 0.12;
  let guard = 0;
  while (guard++ < 2000) {
    const ev = events[nextIndex];
    const t = loopStart + ev.time * loopDur();
    if (t < ctx.currentTime + ahead) {
      fire(state.lanes[ev.lane], ev.lane, ev.face, t);
      scheduleFlash(ev, t);
      nextIndex++;
      if (nextIndex >= events.length) { nextIndex = 0; loopStart += loopDur(); }
    } else break;
  }
}

function scheduleFlash(ev, t) {
  const delay = Math.max(0, (t - ctx.currentTime) * 1000);
  setTimeout(() => {
    const laneEl = document.querySelector(`.lane[data-id="${ev.li}"] .track`);
    if (!laneEl) return;
    const el = laneEl.children[ev.bi];
    if (!el || !el.classList.contains('block')) return;
    el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit');
  }, delay);
}

function play() {
  ensureAudio();
  if (ctx.state === 'suspended') ctx.resume();
  rebuildEvents();
  state.playing = true;
  nextIndex = 0;
  loopStart = ctx.currentTime + 0.08;
  schedTimer = setInterval(scheduler, 25);
  document.getElementById('play').classList.add('playing');
  document.querySelector('.play-label').textContent = 'Stop';
  document.querySelector('.play-glyph').textContent = '■';
  document.getElementById('seq').classList.add('playing');
}

function stop() {
  state.playing = false;
  clearInterval(schedTimer); schedTimer = null;
  stopSources();                          // cut any sounds still ringing (long samples)
  document.getElementById('play').classList.remove('playing');
  document.querySelector('.play-label').textContent = 'Play';
  document.querySelector('.play-glyph').textContent = '▶';
  document.getElementById('seq').classList.remove('playing');
}

/* playhead animation */
function tickPlayhead() {
  const ph = document.getElementById('playhead');
  if (state.playing && ctx) {
    const dur = loopDur();
    let phase = ((ctx.currentTime - loopStart) / dur);
    phase = ((phase % 1) + 1) % 1;
    const track = document.querySelector('.lane .track');
    const seq = document.getElementById('seq');
    if (track && ph) {
      const tr = track.getBoundingClientRect();
      const sr = seq.getBoundingClientRect();
      ph.style.left = (tr.left - sr.left + phase * tr.width) + 'px';
      ph.style.height = seq.clientHeight + 'px';
    }
  }
  requestAnimationFrame(tickPlayhead);
}

/* ------------------------------ rendering ------------------------------ */
const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

let drag = null;   // active drag payload: { kind:'new'|'move', n, d, face, fromLane?, fromIdx? }
let armed = null;  // "brush": the last block clicked (wall or placed) — click a lane to place a copy

// Arm the brush to a fraction. Any block click (wall or placed) calls this, so
// the brush always tracks whatever you last clicked.
function setArmed(n, d) {
  armed = { n, d };
  updateBrushUI();
  document.querySelectorAll('.pblock').forEach((b) => b.classList.toggle('armed', armed.n === 1 && +b.dataset.d === armed.d));
}
function disarm() {
  armed = null;
  updateBrushUI();
  document.querySelectorAll('.pblock.armed').forEach((b) => b.classList.remove('armed'));
}
function updateBrushUI() {
  const info = document.getElementById('brushInfo');
  if (info) info.textContent = armed ? `Brush: ${fracLabel(armed)} — click a lane to place (Esc to put down)` : 'Click a block to arm it, or drag';
}

function renderPalette() {
  const wrap = document.getElementById('palette');
  wrap.innerHTML = '';
  for (const den of state.denominators) {
    const row = el('div', 'prow');
    row.style.gridTemplateColumns = `repeat(${den}, 1fr)`;
    for (let i = 0; i < den; i++) {
      const b = el('div', 'pblock');
      if (armed && armed.d === den) b.classList.add('armed');
      b.style.setProperty('--c', denColor(den));
      b.draggable = true;
      b.dataset.n = 1; b.dataset.d = den;
      // Every wall block is a unit fraction, so the "1/" is implied — just show
      // the denominator. Keeps labels legible even when a row has many columns.
      b.innerHTML = den === 1 ? '1' : `<span>${den}</span>`;
      b.title = den === 1 ? 'A whole bar — click to arm, or drag' : `A 1/${den} block — click to arm, or drag into a lane`;
      b.addEventListener('click', () => setArmed(1, den));
      b.addEventListener('dragstart', (e) => {
        drag = { kind: 'new', n: 1, d: den, face: 'loud' };
        b.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', `1/${den}`);
      });
      b.addEventListener('dragend', () => b.classList.remove('dragging'));
      row.appendChild(b);
    }
    wrap.appendChild(row);
  }
  updateBrushUI();
}

function laneSum(lane) { return lane.blocks.reduce((s, b) => s + fval(b), 0); }

function renderSeq() {
  const seq = document.getElementById('seq');
  // keep the playhead element across re-renders
  let ph = document.getElementById('playhead');
  seq.innerHTML = '';
  const solo = anySolo();

  state.lanes.forEach((lane, li) => {
    const laneEl = el('div', 'lane');
    laneEl.dataset.id = lane.id;
    laneEl.dataset.index = li;
    if (lane.muted || (solo && !lane.solo)) laneEl.classList.add('dim');
    const learnGated = state.mode === 'learn' && lane.blocks.length && !laneComplete(lane);
    if (learnGated) laneEl.classList.add('incomplete');

    /* gutter -------------------------------------------------------- */
    const gutter = el('div', 'gutter');
    const voiceRow = el('div', 'lane-voice');
    const dot = el('span', 'voice-dot');   // a lane marker, not a fraction — stays neutral (see CSS)
    const name = el('button', 'lane-name'); name.textContent = lane.name;
    name.title = 'Click to change the built-in voice';
    name.addEventListener('click', () => { cycleVoice(lane); });
    const midi = el('input', 'lane-midi'); midi.type = 'number'; midi.min = 0; midi.max = 127; midi.value = lane.midi;
    midi.title = 'MIDI note this lane sends (channel 10)';
    midi.addEventListener('change', () => { lane.midi = Math.max(0, Math.min(127, +midi.value | 0)); midi.value = lane.midi; });
    midi.addEventListener('click', (e) => e.stopPropagation());
    voiceRow.append(dot, name, midi);

    const controls = el('div', 'gutter-controls');
    const mBtn = el('button', 'mini' + (lane.muted ? ' on-m' : ''), 'M'); mBtn.title = 'Mute lane';
    mBtn.addEventListener('click', () => { lane.muted = !lane.muted; applyLaneGains(); renderSeq(); });
    const sBtn = el('button', 'mini' + (lane.solo ? ' on-s' : ''), 'S'); sBtn.title = 'Solo lane';
    sBtn.addEventListener('click', () => { lane.solo = !lane.solo; applyLaneGains(); renderSeq(); });
    const loadBtn = el('button', 'mini', '📁'); loadBtn.title = 'Load an audio sample';
    loadBtn.addEventListener('click', () => loadSampleFor(lane));
    const micBtn = el('button', 'mini', '🎙️'); micBtn.title = 'Record a sample from your microphone';
    micBtn.addEventListener('click', () => openRecorder(lane));
    const vol = el('input', 'lane-vol'); vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.01; vol.value = lane.gain;
    vol.title = 'Lane level';
    vol.addEventListener('input', () => { lane.gain = +vol.value; applyLaneGains(); });
    const rm = el('button', 'mini rm', '×'); rm.title = 'Remove lane';
    rm.addEventListener('click', () => { removeLane(li); });
    controls.append(mBtn, sBtn, loadBtn, micBtn, vol, rm);
    gutter.append(voiceRow, controls);

    // drag an audio file onto the gutter to load a sample
    gutter.addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); gutter.classList.add('drop'); } });
    gutter.addEventListener('dragleave', () => gutter.classList.remove('drop'));
    gutter.addEventListener('drop', (e) => { gutter.classList.remove('drop'); handleFileDrop(e, lane); });

    /* track --------------------------------------------------------- */
    const track = el('div', 'track');
    track.dataset.index = li;
    const sum = laneSum(lane);
    if (sum > 1 + EPS) track.classList.add('full');

    if (!lane.blocks.length) {
      track.appendChild(el('div', 'track-empty', 'drag a block here, or arm one and click'));
    }

    lane.blocks.forEach((b, bi) => {
      const blockEl = el('div', 'block face-' + b.face);
      const w = Math.min(fval(b), 1) * 100;
      blockEl.style.flex = `0 0 ${w}%`;
      blockEl.style.setProperty('--c', denColor(reduce(b.n, b.d).d));   // colour follows the block's own fraction, matching the wall
      // seam (not flex `gap`) so splitting a block into pieces can't add extra
      // total width — flex `gap` stacks on top of percentage widths and drifts
      // the row out of alignment with other lanes as pieces are added.
      if (bi < lane.blocks.length - 1) blockEl.classList.add('seam');
      blockEl.draggable = true;
      blockEl.dataset.bi = bi;
      if (fval(b) < 0.06) blockEl.classList.add('narrow');
      blockEl.innerHTML = `<span class="blabel">${fracLabel(b)}</span><span class="dots">${FACE_DOTS[b.face]}</span>`;
      blockEl.title = `${fracLabel(b)} · ${b.face} — click to rotate face, right-click to subdivide`;

      let dragged = false;
      blockEl.addEventListener('click', () => {
        if (dragged) { dragged = false; return; }
        rotateFace(lane, bi);
        const r = reduce(b.n, b.d);
        setArmed(r.n, r.d);   // last-clicked block (wall or placed) becomes the brush
      });
      blockEl.addEventListener('dragstart', (e) => {
        dragged = true;
        drag = { kind: 'move', n: b.n, d: b.d, face: b.face, fromLane: li, fromIdx: bi };
        blockEl.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', fracLabel(b));
      });
      blockEl.addEventListener('dragend', () => {
        blockEl.classList.remove('dragging');
        setTimeout(() => (dragged = false), 0);
        // Any valid track drop (accepted or rejected-for-overflow) already nulls
        // `drag` inside handleBlockDrop before this fires. If it's still set here,
        // the block was released somewhere with no drop zone — off the board.
        if (drag) {
          drag = null;
          const label = fracLabel(b);
          deleteBlock(li, bi);
          toast(`Removed ${label}`);
        }
      });
      blockEl.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtxMenu(e, li, bi); });
      blockEl.addEventListener('mouseenter', () => { hoverTarget = { li, bi }; });
      blockEl.addEventListener('mouseleave', () => { if (hoverTarget && hoverTarget.li === li && hoverTarget.bi === bi) hoverTarget = null; });

      track.appendChild(blockEl);
    });

    // faint label over the remaining empty time in an unfinished lane
    const sumFrac = laneSumFrac(lane);
    if (lane.blocks.length && sumFrac.n < sumFrac.d) {
      const remain = reduce(sumFrac.d - sumFrac.n, sumFrac.d);
      // In Learn mode don't reveal how much is missing — that's the puzzle.
      const gapText = learnGated
        ? 'not a full bar yet — silent'
        : `${fracLabel(remain)} left`;
      const gapEl = el('div', 'gap', `<span class="gap-label">${gapText}</span>`);
      gapEl.style.flex = `0 0 ${Math.min(fval(remain), 1) * 100}%`;
      track.appendChild(gapEl);
    }

    // capacity readout — in Create mode show the exact fraction; in Learn mode
    // show only "complete" (never the missing amount, so the bar stays a puzzle).
    const cap = el('div', 'cap');
    if (state.mode === 'learn') {
      if (lane.blocks.length && sumFrac.n === sumFrac.d) cap.appendChild(el('span', 'complete-badge', '✓ complete'));
    } else {
      cap.textContent = capacityLabel(sumFrac);
    }
    track.appendChild(cap);

    // drop handling for the track (new block from palette OR moved block)
    track.addEventListener('dragover', (e) => {
      if (isFileDrag(e)) return;
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = drag.kind === 'move' ? 'move' : 'copy';
      track.classList.add('over');
    });
    track.addEventListener('dragleave', (e) => { if (e.target === track) track.classList.remove('over'); });
    track.addEventListener('drop', (e) => {
      track.classList.remove('over');
      if (isFileDrag(e)) { handleFileDrop(e, lane); return; }
      e.preventDefault();
      handleBlockDrop(e, li, track);
    });
    // dropping an audio file directly on the track
    track.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });

    // click-to-place: with a brush armed, clicking empty track space drops the block
    track.addEventListener('click', (e) => {
      if (!armed) return;
      if (e.target.closest('.block')) return;   // clicking a block rotates its face instead
      const idx = dropIndexFor(track, e.clientX);
      if (!insertBlock(li, idx, blk(armed.n, armed.d, 'loud'))) { rejectFlash(track); toast('No room left in the bar'); }
    });

    laneEl.append(gutter, track);
    seq.appendChild(laneEl);
  });

  // (re)attach playhead
  if (!ph) { ph = el('div', 'playhead'); ph.id = 'playhead'; }
  seq.appendChild(ph);

  maybeAdvanceTutorial();   // check the tutorial goal after any pattern change
}

// sumFrac is the lane's exact placed total, e.g. { n: 5, d: 8 } for 5/8.
function capacityLabel(sumFrac) {
  const { n, d } = sumFrac;
  if (n === d) return 'full bar';
  if (n > d) { const r = reduce(n - d, d); return 'over ' + (r.d === 1 ? r.n : `${r.n}/${r.d}`); }
  return (d === 1 ? n : `${n}/${d}`) + ' full';
}

/* ------------------------------ block ops ------------------------------ */
function rotateFace(lane, bi) {
  pushUndo();
  const b = lane.blocks[bi];
  b.face = FACES[(FACES.indexOf(b.face) + 1) % FACES.length];
  markDirty(); renderSeq();
}

function subdivide(li, bi, k) {
  pushUndo();
  const lane = state.lanes[li];
  const b = lane.blocks[bi];
  // In Learn mode, cutting keeps only the first piece sounding and mutes the
  // rest — so the audible groove is unchanged while the finer grid is revealed
  // (the point of "cut the pieces so they're all the same size").
  const pieces = Array.from({ length: k }, (_, i) =>
    blk(b.n, b.d * k, (state.mode === 'learn' && i > 0) ? 'mute' : b.face));
  lane.blocks.splice(bi, 1, ...pieces);
  // a new size like 1/15 may not be on the wall yet — add it and reflow
  if (registerFraction(pieces[0])) renderPalette();
  markDirty(); renderSeq();
}

function mergeWithNext(li, bi) {
  const lane = state.lanes[li];
  if (bi >= lane.blocks.length - 1) { toast('Nothing after this block to merge'); return; }
  pushUndo();
  const a = lane.blocks[bi], b = lane.blocks[bi + 1];
  const n = a.n * b.d + b.n * a.d;
  const d = a.d * b.d;
  const r = reduce(n, d);
  lane.blocks.splice(bi, 2, blk(r.n, r.d, a.face));
  markDirty(); renderSeq();
}

function deleteBlock(li, bi) {
  pushUndo();
  state.lanes[li].blocks.splice(bi, 1);
  markDirty(); renderSeq();
}

function insertBlock(li, index, block) {
  const lane = state.lanes[li];
  const sum = laneSum(lane);
  if (sum + fval(block) > 1 + 1e-6) return false;   // would overflow the bar
  pushUndo();
  lane.blocks.splice(index, 0, block);
  markDirty(); renderSeq();
  return true;
}

/* dropping a block into a track ---------------------------------------- */
function dropIndexFor(track, clientX) {
  const blocks = [...track.querySelectorAll('.block')];
  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return blocks.length;
}

function handleBlockDrop(e, li, track) {
  if (!drag) return;
  const d = drag; drag = null;
  let index = dropIndexFor(track, e.clientX);

  if (d.kind === 'move') {
    const src = state.lanes[d.fromLane];
    const target = state.lanes[li];
    const moved = src.blocks[d.fromIdx];
    // does it fit? (moving within a lane doesn't change that lane's total)
    const targetSum = laneSum(target) - (d.fromLane === li ? fval(moved) : 0);
    if (targetSum + fval(moved) > 1 + 1e-6) { rejectFlash(track); toast('No room in that lane'); return; }
    pushUndo();
    src.blocks.splice(d.fromIdx, 1);
    if (d.fromLane === li && d.fromIdx < index) index--;
    target.blocks.splice(index, 0, moved);
    markDirty(); renderSeq();
  } else {
    if (!insertBlock(li, index, blk(d.n, d.d, d.face))) {
      rejectFlash(track); toast('No room left in the bar');
    }
  }
}

function rejectFlash(track) {
  track.classList.remove('reject'); void track.offsetWidth; track.classList.add('reject');
  setTimeout(() => track.classList.remove('reject'), 300);
}

/* ------------------------------ lanes ---------------------------------- */
function addLane() {
  pushUndo();
  state.lanes.push(newLane(state.lanes.length));
  if (ctx) ensureLaneNode(state.lanes[state.lanes.length - 1]);
  markDirty(); applyLaneGains(); renderSeq();
}
function removeLane(li) {
  pushUndo();
  state.lanes.splice(li, 1);
  markDirty(); applyLaneGains(); renderSeq();
}
function cycleVoice(lane) {
  pushUndo();
  stopSources(lane);
  lane.voice = (lane.voice + 1) % VOICES.length;
  lane.buffer = null;
  lane.name = VOICES[lane.voice];
  lane.midi = GM_NOTES[lane.voice];
  renderSeq();
}

/* ------------------------------ samples -------------------------------- */
let pendingSampleLane = null;
function loadSampleFor(lane) {
  pendingSampleLane = lane;
  document.getElementById('fileInput').click();
}
async function decodeInto(lane, file) {
  ensureAudio();
  try {
    const buf = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    pushUndo();
    stopSources(lane);                    // cut the old sample if it's still playing
    lane.buffer = audio;
    lane.name = file.name.replace(/\.[^.]+$/, '');
    renderSeq(); toast('Loaded ' + lane.name);
  } catch (err) {
    toast('Could not decode that audio file');
  }
}
function isFileDrag(e) { return e.dataTransfer && [...e.dataTransfer.types].includes('Files'); }
function handleFileDrop(e, lane) {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) decodeInto(lane, f);
}

/* ------------------------------ recorder -------------------------------- */
const REC_MAX_SEC = 12;
let recLane = null;          // lane the finished take will go into
let recStream = null;        // live MediaStream (kept alive across takes until the modal closes)
let recorder = null;         // active MediaRecorder
let recChunks = [];
let recBuffer = null;        // decoded AudioBuffer of the last take
let recTrim = { start: 0, end: 1 };
let recTimerId = null, recStartedAt = 0;
let recAnalyser = null, recMeterRaf = null;
let recPreviewSrc = null;
let recCounter = 0;

function recSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}
function pickRecMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
  for (const c of candidates) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

function openRecorder(lane) {
  if (!recSupported()) { toast('Recording isn\'t supported in this browser'); return; }
  ensureAudio();
  recLane = lane;
  recBuffer = null;
  recTrim = { start: 0, end: 1 };
  $('#recTarget').textContent = `→ ${lane.name}`;
  $('#recStatus').textContent = 'Click record and allow microphone access';
  $('#recTimer').textContent = '0.0s';
  $('#recToggle').textContent = '● Record';
  $('#recToggle').classList.remove('recording');
  $('#recPreview').disabled = true;
  $('#recUse').disabled = true;
  $('#recTrimStart').hidden = true;
  $('#recTrimEnd').hidden = true;
  $('#recDimLeft').style.width = '0%';
  $('#recDimRight').style.width = '0%';
  clearCanvas();
  $('#recModal').hidden = false;
}

function closeRecorder() {
  if (recorder) {
    recorder.onstop = null;   // discard this take — the stop event fires async, after
                               // recorder/recLane below are cleared, so drop the handler
                               // rather than let it run against torn-down state
    if (recorder.state === 'recording') recorder.stop();
  }
  stopLevelMeter();
  clearInterval(recTimerId); recTimerId = null;
  if (recPreviewSrc) { try { recPreviewSrc.stop(); } catch (_) {} recPreviewSrc = null; }
  if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
  recorder = null; recBuffer = null; recLane = null;
  $('#recModal').hidden = true;
}

async function toggleRecording() {
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }

  if (!recStream) {
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast('Microphone access was blocked');
      return;
    }
  }
  recBuffer = null;
  recChunks = [];
  const mime = pickRecMime();
  recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = onRecordingStop;
  recorder.start();

  $('#recToggle').textContent = '■ Stop';
  $('#recToggle').classList.add('recording');
  $('#recStatus').textContent = 'Recording…';
  $('#recPreview').disabled = true;
  $('#recUse').disabled = true;
  $('#recTrimStart').hidden = true;
  $('#recTrimEnd').hidden = true;

  recStartedAt = Date.now();
  clearInterval(recTimerId);
  recTimerId = setInterval(() => {
    const elapsed = (Date.now() - recStartedAt) / 1000;
    $('#recTimer').textContent = elapsed.toFixed(1) + 's';
    if (elapsed >= REC_MAX_SEC) recorder.stop();
  }, 100);

  startLevelMeter(recStream);
}

async function onRecordingStop() {
  clearInterval(recTimerId); recTimerId = null;
  stopLevelMeter();
  $('#recToggle').textContent = '● Record';
  $('#recToggle').classList.remove('recording');

  const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
  try {
    const arr = await blob.arrayBuffer();
    recBuffer = await ctx.decodeAudioData(arr);
  } catch (err) {
    toast('Could not decode the recording — try again');
    $('#recStatus').textContent = 'Click record and allow microphone access';
    return;
  }
  recTrim = { start: 0, end: 1 };
  drawWaveform(recBuffer);
  $('#recTrimStart').hidden = false;
  $('#recTrimEnd').hidden = false;
  positionTrimUI();
  $('#recPreview').disabled = false;
  $('#recUse').disabled = false;
}

function clearCanvas() {
  const canvas = $('#recCanvas');
  const c2 = canvas.getContext('2d');
  c2.fillStyle = '#14161d';
  c2.fillRect(0, 0, canvas.width, canvas.height);
}

function startLevelMeter(stream) {
  const src = ctx.createMediaStreamSource(stream);
  recAnalyser = ctx.createAnalyser();
  recAnalyser.fftSize = 512;
  src.connect(recAnalyser);   // analysis only — not connected onward, so no monitoring feedback
  const data = new Uint8Array(recAnalyser.frequencyBinCount);
  const canvas = $('#recCanvas');
  const c2 = canvas.getContext('2d');
  const draw = () => {
    recAnalyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    const level = Math.min(1, peak / 110);
    c2.fillStyle = '#14161d'; c2.fillRect(0, 0, canvas.width, canvas.height);
    const barW = 80, h = level * canvas.height;
    const grad = c2.createLinearGradient(0, canvas.height, 0, 0);
    grad.addColorStop(0, '#37c26a'); grad.addColorStop(0.7, '#ffd166'); grad.addColorStop(1, '#e24a4a');
    c2.fillStyle = grad;
    c2.fillRect(canvas.width / 2 - barW / 2, canvas.height - h, barW, h);
    recMeterRaf = requestAnimationFrame(draw);
  };
  draw();
}
function stopLevelMeter() {
  if (recMeterRaf) cancelAnimationFrame(recMeterRaf);
  recMeterRaf = null; recAnalyser = null;
}

function drawWaveform(buffer) {
  const canvas = $('#recCanvas');
  const c2 = canvas.getContext('2d');
  const data = buffer.getChannelData(0);
  const w = canvas.width, h = canvas.height, mid = h / 2;
  c2.fillStyle = '#14161d'; c2.fillRect(0, 0, w, h);
  c2.fillStyle = 'rgba(255,255,255,.15)'; c2.fillRect(0, mid, w, 1);
  const step = Math.max(1, Math.ceil(data.length / w));
  c2.fillStyle = '#ffd166';
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    const start = x * step;
    for (let i = 0; i < step; i++) {
      const v = data[start + i];
      if (v === undefined) break;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min * mid * 0.9, y2 = mid + max * mid * 0.9;
    c2.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

function positionTrimUI() {
  $('#recTrimStart').style.left = (recTrim.start * 100) + '%';
  $('#recTrimEnd').style.left = (recTrim.end * 100) + '%';
  $('#recDimLeft').style.width = (recTrim.start * 100) + '%';
  $('#recDimRight').style.width = ((1 - recTrim.end) * 100) + '%';
  const dur = recBuffer.duration;
  $('#recStatus').textContent = `Selected ${((recTrim.end - recTrim.start) * dur).toFixed(2)}s of ${dur.toFixed(2)}s — drag the handles to trim`;
}

function wireTrimHandle(handleEl, which) {
  handleEl.addEventListener('pointerdown', (e) => {
    if (!recBuffer) return;
    handleEl.setPointerCapture(e.pointerId);
    const canvas = $('#recCanvas');
    const move = (ev) => {
      const r = canvas.getBoundingClientRect();
      let frac = (ev.clientX - r.left) / r.width;
      frac = Math.max(0, Math.min(1, frac));
      const minGap = 0.02;
      if (which === 'start') recTrim.start = Math.min(frac, recTrim.end - minGap);
      else recTrim.end = Math.max(frac, recTrim.start + minGap);
      positionTrimUI();
    };
    const up = () => {
      handleEl.releasePointerCapture(e.pointerId);
      handleEl.removeEventListener('pointermove', move);
      handleEl.removeEventListener('pointerup', up);
    };
    handleEl.addEventListener('pointermove', move);
    handleEl.addEventListener('pointerup', up);
  });
}

function previewTrim() {
  if (!recBuffer) return;
  if (recPreviewSrc) { try { recPreviewSrc.stop(); } catch (_) {} }
  const startSec = recTrim.start * recBuffer.duration;
  const durSec = Math.max(0.01, (recTrim.end - recTrim.start) * recBuffer.duration);
  const src = ctx.createBufferSource();
  src.buffer = recBuffer;
  src.connect(masterNode);
  src.start(0, startSec, durSec);
  recPreviewSrc = src;
}

function sliceBuffer(buffer, startFrac, endFrac) {
  const startSample = Math.floor(startFrac * buffer.length);
  const endSample = Math.max(startSample + 1, Math.floor(endFrac * buffer.length));
  const out = ctx.createBuffer(buffer.numberOfChannels, endSample - startSample, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(startSample, endSample));
  }
  return out;
}

function useRecording() {
  if (!recBuffer || !recLane) return;
  pushUndo();
  stopSources(recLane);
  recLane.buffer = sliceBuffer(recBuffer, recTrim.start, recTrim.end);
  recLane.name = 'Rec ' + ++recCounter;
  toast('Recorded sample loaded into ' + recLane.name);
  renderSeq();
  closeRecorder();
}

/* ------------------------------ context menu --------------------------- */
const ctxEl = document.getElementById('ctxmenu');
let hoverTarget = null;

function openCtxMenu(e, li, bi) {
  const b = state.lanes[li].blocks[bi];
  ctxEl.innerHTML = '';
  ctxEl.appendChild(el('div', 'ctx-head', `Block ${fracLabel(b)} · ${b.face}`));
  const item = (label, hint, fn) => {
    const btn = el('button', null, `<span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}`);
    btn.addEventListener('click', () => { fn(); closeCtxMenu(); });
    ctxEl.appendChild(btn);
  };
  for (let k = 2; k <= 6; k++) {
    const r = reduce(b.n, b.d * k);
    item(`Split into ${k}`, `→ ${r.d === 1 ? r.n : r.n + '/' + r.d}`, () => subdivide(li, bi, k));
  }
  ctxEl.appendChild(el('div', 'ctx-sep'));
  item('Merge with next', 'M', () => mergeWithNext(li, bi));
  item('Rotate face', 'click', () => rotateFace(state.lanes[li], bi));
  item('Delete block', 'Del', () => deleteBlock(li, bi));

  ctxEl.hidden = false;
  const mw = ctxEl.offsetWidth, mh = ctxEl.offsetHeight;
  ctxEl.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
  ctxEl.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
}
function closeCtxMenu() { ctxEl.hidden = true; }
document.addEventListener('click', (e) => { if (!ctxEl.contains(e.target)) closeCtxMenu(); });
document.addEventListener('scroll', closeCtxMenu, true);

/* ------------------------------ toast ---------------------------------- */
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1800);
}

/* ------------------------------ undo / redo ---------------------------- */
// In-memory snapshots (unlike serialize(), these keep AudioBuffer references so
// undoing an edit doesn't drop a lane's loaded/recorded sample).
let undoStack = [], redoStack = [];
const UNDO_LIMIT = 200;

function snapshotState() {
  return {
    bpm: state.bpm, master: state.master, tones: state.tones,
    denominators: state.denominators.slice(),
    lanes: state.lanes.map((l) => ({
      id: l.id, name: l.name, voice: l.voice, gain: l.gain, muted: l.muted, solo: l.solo,
      midi: l.midi, buffer: l.buffer,
      blocks: l.blocks.map((b) => ({ n: b.n, d: b.d, face: b.face })),
    })),
  };
}
function restoreState(snap) {
  stopSources();
  state.bpm = snap.bpm; state.master = snap.master; state.tones = !!snap.tones;
  state.denominators = snap.denominators.slice();
  state.lanes = snap.lanes.map((s) => {
    const lane = newLane(s.voice, s.blocks.map((b) => blk(b.n, b.d, b.face)));
    lane.id = s.id; lane.name = s.name; lane.gain = s.gain; lane.muted = s.muted;
    lane.solo = s.solo; lane.midi = s.midi; lane.buffer = s.buffer || null;
    return lane;
  });
  laneSeq = state.lanes.reduce((m, l) => Math.max(m, l.id), laneSeq);
  if (masterNode) masterNode.gain.setTargetAtTime(state.master, ctx.currentTime, 0.01);
  if (ctx) { state.lanes.forEach(ensureLaneNode); applyLaneGains(); }
  registerAllFractions();
  syncControls(); markDirty(); renderPalette(); renderSeq();
}

// Call before any pattern-mutating edit.
function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function clearUndo() { undoStack.length = 0; redoStack.length = 0; updateUndoButtons(); }
function undo() {
  if (!undoStack.length) { toast('Nothing to undo'); return; }
  redoStack.push(snapshotState());
  restoreState(undoStack.pop());
  updateUndoButtons();
}
function redo() {
  if (!redoStack.length) { toast('Nothing to redo'); return; }
  undoStack.push(snapshotState());
  restoreState(redoStack.pop());
  updateUndoButtons();
}
function updateUndoButtons() {
  const u = $('#undoBtn'), r = $('#redoBtn');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

/* ------------------------------ persistence ---------------------------- */
const SAVE_KEY = 'pbdm.pattern.v1';
function serialize() {
  return {
    bpm: state.bpm, master: state.master, denominators: state.denominators.slice(),
    lanes: state.lanes.map((l) => ({
      name: l.name, voice: l.voice, gain: l.gain, muted: l.muted, solo: l.solo, midi: l.midi,
      blocks: l.blocks.map((b) => ({ n: b.n, d: b.d, face: b.face })),
    })),
  };
}
function deserialize(data) {
  if (!data || !Array.isArray(data.lanes)) return;
  stopSources();
  state.bpm = data.bpm || 96; state.master = data.master ?? 0.9;
  laneSeq = 0;
  state.lanes = data.lanes.map((l) => {
    const lane = newLane(l.voice || 0, (l.blocks || []).map((b) => blk(b.n, b.d, b.face || 'loud')));
    lane.name = l.name || lane.name; lane.gain = l.gain ?? 0.85; lane.muted = !!l.muted; lane.solo = !!l.solo;
    if (l.midi != null) lane.midi = l.midi | 0;
    return lane;
  });
  // restore the wall (default rows + any saved/derived denominators)
  const base = Array.from({ length: ROWS }, (_, i) => i + 1);
  const extra = Array.isArray(data.denominators) ? data.denominators : [];
  state.denominators = [...new Set([...base, ...extra])].sort((a, b) => a - b);
  registerAllFractions();
  if (ctx) { state.lanes.forEach(ensureLaneNode); applyLaneGains(); }
  syncControls(); markDirty(); renderPalette(); renderSeq();
}
function saveLocal() { localStorage.setItem(SAVE_KEY, JSON.stringify(serialize())); toast('Saved to this browser'); }
function loadLocal() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) { toast('Nothing saved yet'); return; }
  try { pushUndo(); deserialize(JSON.parse(raw)); toast('Loaded save'); } catch { toast('Save was corrupt'); }
}
function exportJSON() {
  const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'pattern-block-drum.json'; a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------ randomize ------------------------------ */
function randomize() {
  pushUndo();
  const choices = [
    [[2, 'a'], [4, 'a']], // halves/quarters
    [[3, 'a']], [[4, 'a']], [[5, 'a']], [[6, 'a']], [[8, 'a']],
  ];
  state.lanes.forEach((lane) => {
    const den = [2, 3, 4, 5, 6, 8][Math.floor(Math.random() * 6)];
    const blocks = [];
    for (let i = 0; i < den; i++) {
      const roll = Math.random();
      const face = roll < 0.4 ? 'mute' : roll < 0.6 ? 'soft' : roll < 0.85 ? 'mid' : 'loud';
      blocks.push(blk(1, den, face));
    }
    // occasionally subdivide one block into 2 or 3
    if (Math.random() < 0.5) {
      const bi = Math.floor(Math.random() * blocks.length);
      const k = Math.random() < 0.5 ? 2 : 3;
      const b = blocks[bi];
      blocks.splice(bi, 1, ...Array.from({ length: k }, () => blk(b.n, b.d * k, Math.random() < 0.5 ? 'mid' : 'soft')));
    }
    lane.blocks = blocks;
  });
  markDirty(); renderSeq(); toast('Randomized');
}

function clearAll() {
  pushUndo();
  state.lanes.forEach((l) => (l.blocks = []));
  markDirty(); renderSeq();
}

/* ------------------------------ mode: Create / Learn -------------------- */
let createSnapshot = null;   // remembers the Create-mode pattern while in Learn

function setMode(mode) {
  if (mode === state.mode) return;
  clearUndo();   // undo history is scoped to the current editing context
  if (mode === 'learn') {
    createSnapshot = snapshotState();      // stash the free-play pattern (keeps samples)
    state.mode = 'learn';
    enterLesson(state.lesson || 0);        // reset the board for the tutorial
  } else {
    state.mode = 'create';
    if (createSnapshot) { restoreState(createSnapshot); createSnapshot = null; }   // bring it back
    else { markDirty(); renderSeq(); }
  }
  $('#modeCreate').classList.toggle('active', mode === 'create');
  $('#modeLearn').classList.toggle('active', mode === 'learn');
  $('#tutorialPanel').hidden = mode !== 'learn';
  $('#seqSub').textContent = mode === 'learn'
    ? 'Learn mode — a lane stays silent until it makes a full bar; cutting mutes the new pieces'
    : 'one bar per lane — blocks tile left to right, a muted block is a rest';
}

function toggleTones() {
  state.tones = !state.tones;
  stopSources();
  const btn = $('#tonesToggle');
  btn.classList.toggle('on', state.tones);
  btn.textContent = state.tones ? '🎵 Tones: on' : '🎵 Tones';
}

/* ------------------------------ tutorial (Learn mode) ------------------- */
// True when lane `li` is complete and made entirely of 1/den pieces.
function laneAllUnit(li, den) {
  const lane = state.lanes[li];
  if (!lane || !lane.blocks.length || !laneComplete(lane)) return false;
  return lane.blocks.every((b) => { const r = reduce(b.n, b.d); return r.n === 1 && r.d === den; });
}
// Replace the lanes for a lesson setup (voice, name, blocks).
function tutLanes(specs) {
  laneSeq = 0;
  state.lanes = specs.map((s) => {
    const lane = newLane(s.voice, s.blocks || []);
    if (s.name) lane.name = s.name;
    return lane;
  });
  if (ctx) { state.lanes.forEach(ensureLaneNode); applyLaneGains(); }
}
const q = (face) => blk(1, 4, face);       // a quarter
const half = (face) => blk(1, 2, face);    // a half

const LESSONS = [
  {
    name: '1 · Polyrhythm basics (2 vs 3)',
    setup: () => tutLanes([{ voice: 0, name: 'Kick' }, { voice: 1, name: 'Snare' }]),
    steps: [
      { text: "👋 Let's build a <b>polyrhythm</b> — two rhythms at once — and find out why some grooves feel funkier than others." },
      { text: "Fill the <b>Kick</b> lane so it hits <b>twice</b>: two <b>½</b> blocks, filling the whole bar.", done: () => laneAllUnit(0, 2) },
      { text: "Now fill the <b>Snare</b> lane so it hits <b>three</b> times — three <b>⅓</b> blocks.", done: () => laneAllUnit(1, 3) },
      { text: "▶ Press <b>Play</b>. Two against three! They only meet at the very start of the bar — that tug is the polyrhythm." },
      { text: "The puzzle: <b>cut every piece until both lanes are the same size.</b> Right-click a block to cut it (the new pieces mute, so your groove stays). How small must they get to match?", done: () => laneAllUnit(0, 6) && laneAllUnit(1, 6) },
      { text: "🎉 <b>Sixths!</b> 6 is the smallest number both 2 and 3 divide into — their <b>LCM</b>. That shared grid is where a polyrhythm 'resolves'." },
    ],
  },
  {
    name: '2 · Rock beat: layers vs detail',
    setup: () => tutLanes([
      { voice: 0, name: 'Kick', blocks: [half('loud'), half('mid')] },
      { voice: 1, name: 'Snare', blocks: [q('mute'), half('loud'), q('loud')] },
      { voice: 3, name: 'Hi-hat' },
      { voice: 5, name: 'Tom' },
    ]),
    steps: [
      { text: "Real music now. A <b>4/4 rock beat</b>: <b>kick</b> on the halves (beats 1 & 3), <b>snare</b> on the backbeat (2 & 4). ▶ Play it." },
      { text: "Add <b>hi-hats</b>: fill the Hi-hat lane with <b>eighths</b> (⅛).", done: () => laneAllUnit(2, 8) },
      { text: "Busier — but the <b>same groove</b>, right? 2, 4 and 8 are all made of <b>2s</b>, so they share the eighth grid and <b>lock</b>. A detail that stays in the family doesn't change the feel, just the density." },
      { text: "Now a detail that <i>does</i>: fill the <b>Tom</b> lane with <b>thirds</b> (⅓).", done: () => laneAllUnit(3, 3) },
      { text: "Feel the pull? Thirds bring a factor of <b>3</b> the 2-grid never had, so the shared grid leaps (LCM jumps to 24). A detail that adds a <b>new prime</b> changes the <b>feel</b> — that's the line between 'busier' and 'a new groove'." },
    ],
  },
  {
    name: '3 · Blues shuffle (6/8)',
    setup: () => tutLanes([
      { voice: 0, name: 'Kick', blocks: [blk(1, 4, 'loud'), blk(1, 8, 'mute'), blk(1, 8, 'loud'), blk(1, 2, 'mute')] },
      { voice: 1, name: 'Snare', blocks: [q('mute'), half('loud'), q('loud')] },
      { voice: 4, name: 'Ride' },
    ]),
    steps: [
      { text: "A <b>blues shuffle</b>: a 'ba-bum' kick and a backbeat snare, felt 'in 2'. ▶ Play the bed." },
      { text: "Add the <b>ride</b>: fill the Ride lane with <b>sixths</b> (⅙) — the shuffle's triplet roll.", done: () => laneAllUnit(2, 6) },
      { text: "Hear it? <b>6 lines up with 2</b> (6 is a multiple of 2): the triplets land on and between the pulse, so it <b>locks</b> — but that subdivision is the rolling <b>shuffle</b> of blues and jazz. Same trick as the rock hats, funkier flavour." },
    ],
  },
  {
    name: '4 · Cross-rhythm (world music)',
    setup: () => tutLanes([{ voice: 8, name: 'Bell (3)' }, { voice: 6, name: 'Feet (2)' }]),
    steps: [
      { text: "The <b>3-against-2</b> you met in Lesson 1 is the heartbeat of <b>West-African</b> and <b>Afro-Cuban</b> music — the 6/8 bell over a two-step." },
      { text: "Fill <b>Bell (3)</b> with three <b>⅓</b> blocks, and <b>Feet (2)</b> with two <b>½</b> blocks.", done: () => laneAllUnit(0, 3) && laneAllUnit(1, 2) },
      { text: "▶ Play. Dancers feel it flip between 'in 3' and 'in 2' — that shimmer is a <b>hemiola</b>. The <b>son clave</b> and bossa-nova patterns push it further with <b>syncopation</b>: accents that dodge the main pulse. Try muting/rotating single pieces to move the accents around." },
    ],
  },
  {
    name: '5 · 4-against-5 (dance & prog)',
    setup: () => tutLanes([{ voice: 0, name: 'Four' }, { voice: 2, name: 'Five' }]),
    steps: [
      { text: "Producers love <b>4-against-5</b> — you'll hear it in dance, footwork and prog, often <b>truncated</b> (the 5 hinted at, not fully spelled out)." },
      { text: "Fill <b>Four</b> with four <b>¼</b> blocks and <b>Five</b> with five <b>⅕</b> blocks.", done: () => laneAllUnit(0, 4) && laneAllUnit(1, 5) },
      { text: "▶ Play. To draw it exactly you'd cut everything into <b>twentieths</b> — LCM(4,5)=20, so it barely ever fully lines up: restless and hypnotic. Funny thing: as a <b>pitch</b>, 4:5 is a sweet <b>major third</b>. Same ratio, sold as tension in rhythm and sweetness in harmony. Flip <b>🎵 Tones</b> on and hear it." },
    ],
  },
  {
    name: '6 · Explore',
    setup: () => tutLanes([{ voice: 0, name: 'A' }, { voice: 1, name: 'B' }]),
    steps: [
      { text: "You've got the idea: <b>shared factors lock; coprime numbers cross</b>, and the bigger the <b>LCM</b>, the more it slides from funky toward pure tension. Open the <b>Groove Lab</b> and try any pair — 5-against-6, 7-against-8 — to feel where groove tips into dissonance. Sandbox is all yours." },
    ],
  },
];

function currentLesson() { return LESSONS[state.lesson] || LESSONS[0]; }
function currentStep() { return currentLesson().steps[state.step] || currentLesson().steps[0]; }

function enterLesson(li, runSetup = true) {
  clearUndo();   // a fresh lesson starts a fresh undo history
  state.lesson = Math.max(0, Math.min(LESSONS.length - 1, li));
  state.step = 0;
  if (runSetup && currentLesson().setup) currentLesson().setup();
  markDirty(); renderSeq(); renderTutorial();
}

function renderTutorial() {
  const L = currentLesson(), step = currentStep();
  const sel = $('#tutLesson');
  if (sel && sel.options.length !== LESSONS.length) {
    sel.innerHTML = LESSONS.map((l, i) => `<option value="${i}">${l.name}</option>`).join('');
  }
  if (sel) sel.value = state.lesson;
  $('#tutStep').textContent = `Step ${state.step + 1} of ${L.steps.length}`;
  $('#tutTitle').textContent = L.name.replace(/^\d+ · /, '');
  $('#tutText').innerHTML = step.text;
  $('#tutPrev').disabled = state.lesson === 0 && state.step === 0;
  const atEnd = state.lesson === LESSONS.length - 1 && state.step === L.steps.length - 1;
  $('#tutNext').textContent = atEnd ? '↻ Start over' : (state.step === L.steps.length - 1 ? 'Next lesson ›' : 'Next ›');
  $('#tutWaiting').hidden = !step.done;
}

// Auto-advance within a lesson when the current step's goal is reached.
function maybeAdvanceTutorial() {
  if (state.mode !== 'learn') return;
  const L = currentLesson(), step = currentStep();
  if (step && step.done && step.done() && state.step < L.steps.length - 1) {
    state.step++;
    renderTutorial();
    toast('Nice! ✓');
  }
}
function tutorialNext() {
  const L = currentLesson();
  if (state.step < L.steps.length - 1) { state.step++; renderTutorial(); }
  else if (state.lesson < LESSONS.length - 1) { enterLesson(state.lesson + 1); }
  else { enterLesson(0); }
}
function tutorialPrev() {
  if (state.step > 0) { state.step--; renderTutorial(); }
  else if (state.lesson > 0) { state.lesson--; state.step = currentLesson().steps.length - 1; renderTutorial(); }
}

/* ------------------------------ Groove Lab popout ---------------------- */
function openLab() { updateLab(); $('#labModal').hidden = false; }
function closeLab() { stopLabGroove(); stopLabTone(); $('#labModal').hidden = true; }

/* ------------------------------ Groove Lab popout ---------------------- */
function openLab() { updateLab(); $('#labModal').hidden = false; }
function closeLab() { stopLabGroove(); stopLabTone(); $('#labModal').hidden = true; }

/* ------------------------------ Groove Lab ------------------------------ */
// Base just-intonation intervals within one octave, keyed by "high:low" (ratio >= 1)
// in lowest terms. Includes the 7- and 11-limit ratios Ben Johnston named, so
// septimal steps like 7/6 and 7/4 get real names, not "custom".
const BASE_INTERVALS = {
  '1:1': 'Unison',
  '16:15': 'Minor second', '9:8': 'Major second', '10:9': 'Major second',
  '8:7': 'Supermajor second (septimal)',
  '7:6': 'Subminor third (septimal)', '6:5': 'Minor third', '5:4': 'Major third',
  '9:7': 'Supermajor third (septimal)', '14:11': 'Major third (undecimal)',
  '4:3': 'Perfect fourth', '11:8': 'Undecimal tritone',
  '7:5': 'Septimal tritone', '10:7': 'Septimal tritone', '45:32': 'Tritone',
  '3:2': 'Perfect fifth', '14:9': 'Subminor sixth (septimal)',
  '8:5': 'Minor sixth', '13:8': 'Neutral sixth (tridecimal)', '5:3': 'Major sixth',
  '12:7': 'Supermajor sixth (septimal)',
  '7:4': 'Harmonic seventh (septimal)', '16:9': 'Minor seventh', '9:5': 'Minor seventh',
  '11:6': 'Neutral seventh (undecimal)', '15:8': 'Major seventh',
};
// Name the interval for a frequency ratio a:b, reducing by octaves so compound
// ratios (e.g. 7/3 = a subminor third an octave up) still resolve to a name.
function nameInterval(a, b) {
  let num = Math.max(a, b), den = Math.min(a, b);
  const g0 = gcd(num, den); num /= g0; den /= g0;
  let octaves = 0;
  while (num >= 2 * den) { den *= 2; octaves++; }
  const g1 = gcd(num, den); num /= g1; den /= g1;
  const base = BASE_INTERVALS[`${num}:${den}`];
  if (!base) return null;
  if (num === den) return octaves === 1 ? 'Octave' : `${octaves} octaves`;
  if (octaves === 0) return base;
  return `${base} + ${octaves} octave${octaves > 1 ? 's' : ''}`;
}
// How a pair grooves, judged by its reduced LCM (the number of even slices you'd
// need to draw the cross-rhythm). Small = locks/simple, big = tips into dissonance.
// Honest about the top end: past a point it's tension, not funk.
function grooveDescriptor(a, b) {
  if (a === b) return '⚪ Unison — the very same pulse';
  const g = gcd(a, b);
  if (g === Math.min(a, b)) return '🔒 Locked — one nests inside the other, no cross-rhythm';
  const lcm = (a / g) * (b / g);          // reduced LCM
  if (lcm <= 6) return '🙂 Classic cross-rhythm';
  if (lcm <= 12) return '😎 Funky';
  if (lcm <= 20) return '🔥 Deep funk';
  if (lcm <= 40) return '🌶️ Knotty — more tension than groove';
  return '🤯 Dissonant — chaotic, hard to feel as a beat';
}

function factCard(n) {
  const factors = [...primeFactorize(n)];
  if (!factors.length) return `<span class="lab-p" style="--c:hsl(224 12% 42%)">${n}</span>`;
  return factors.map(([p, a]) => {
    const c = denColor(p);
    return Array.from({ length: a }, () => `<span class="lab-p" style="--c:${c}">${p}</span>`).join('');
  }).join('<span class="lab-op">×</span>');
}

function labValues() {
  const a = Math.max(1, Math.min(32, +$('#labA').value | 0 || 1));
  const b = Math.max(1, Math.min(32, +$('#labB').value | 0 || 1));
  return { a, b };
}

function updateLab() {
  const { a, b } = labValues();
  const g = gcd(a, b);
  const lcm = (a * b) / g;

  $('#labFactA').innerHTML = factCard(a);
  $('#labFactB').innerHTML = factCard(b);
  $('#labGcd').textContent = g;
  $('#labLcm').textContent = lcm;
  $('#labFunk').textContent = grooveDescriptor(a, b);

  let explain;
  if (a === b) {
    explain = `${a} and ${b} are the same number, so they always line up — no polyrhythm here.`;
  } else if (g === Math.min(a, b)) {
    explain = `${Math.max(a, b)} is a multiple of ${Math.min(a, b)}, so every ${Math.min(a, b)}-beat lines up with a ${Math.max(a, b)}-beat. Nothing to reconcile.`;
  } else if (g === 1) {
    explain = `${a} and ${b} share no common factor (HCF = 1) — they're coprime. To line them up exactly you need
      LCM(${a}, ${b}) = ${lcm} equal slices: that's a ${Math.min(a, b)}-against-${Math.max(a, b)} polyrhythm.`;
  } else {
    const ra = a / g, rb = b / g;
    explain = `${a} and ${b} share a factor of ${g} (HCF = ${g}). At heart this is the same relationship as
      ${ra} against ${rb}, just scaled up — LCM(${a}, ${b}) = ${lcm} slices needed to draw it exactly.`;
  }
  $('#labExplain').textContent = explain;

  const name = nameInterval(a, b);
  $('#labInterval').textContent = name ? `♪ ${name}` : 'a custom ratio — unusual, but still musical';
}

let labGrooveTimer = null, labGrooveNodes = [];
function stopLabGroove() {
  clearInterval(labGrooveTimer); labGrooveTimer = null;
  $('#labPlayGroove').classList.remove('on');
  $('#labPlayGroove').textContent = '▶ Hear the polyrhythm';
}
function playLabGroove() {
  if (labGrooveTimer) { stopLabGroove(); return; }
  ensureAudio();
  const { a, b } = labValues();
  const barDur = 2.4;   // seconds per bar, fixed and slow so the polyrhythm is easy to hear
  const kick = voiceBuffers[0], clave = voiceBuffers[10];
  let barStart = ctx.currentTime + 0.05;
  const scheduleBar = () => {
    for (let i = 0; i < a; i++) {
      const src = ctx.createBufferSource(); src.buffer = kick;
      const g = ctx.createGain(); g.gain.value = 0.8;
      src.connect(g).connect(masterNode); src.start(barStart + (i / a) * barDur);
    }
    for (let i = 0; i < b; i++) {
      const src = ctx.createBufferSource(); src.buffer = clave;
      const g = ctx.createGain(); g.gain.value = 0.8;
      src.connect(g).connect(masterNode); src.start(barStart + (i / b) * barDur);
    }
  };
  scheduleBar();
  barStart += barDur;
  labGrooveTimer = setInterval(() => {
    if (ctx.currentTime > barStart - 0.3) { scheduleBar(); barStart += barDur; }
  }, 100);
  $('#labPlayGroove').classList.add('on');
  $('#labPlayGroove').textContent = '■ Stop';
}

let labToneNodes = null;
function stopLabTone() {
  if (!labToneNodes) return;
  labToneNodes.forEach((n) => { try { n.stop(); } catch (_) {} });
  labToneNodes = null;
  $('#labPlayTone').classList.remove('on');
  $('#labPlayTone').textContent = '🎵 Hear it as a pitch';
}
function playLabTone() {
  if (labToneNodes) { stopLabTone(); return; }
  ensureAudio();
  const { a, b } = labValues();
  const BASE = 220;
  const o1 = ctx.createOscillator(); o1.frequency.value = BASE;
  const o2 = ctx.createOscillator(); o2.frequency.value = BASE * (Math.max(a, b) / Math.min(a, b));
  const g = ctx.createGain(); g.gain.value = 0.0001;
  g.gain.setTargetAtTime(0.22, ctx.currentTime, 0.05);
  o1.connect(g); o2.connect(g); g.connect(masterNode);
  o1.start(); o2.start();
  labToneNodes = [o1, o2, { stop: () => g.gain.setTargetAtTime(0, ctx.currentTime, 0.05) }];
  $('#labPlayTone').classList.add('on');
  $('#labPlayTone').textContent = '■ Stop';
}

// Pull two lanes' predominant denominators into the lab (skips lanes with mixed sizes).
function labUseLanes() {
  const dens = [];
  for (const lane of state.lanes) {
    if (!lane.blocks.length) continue;
    const ds = new Set(lane.blocks.map((b) => reduce(b.n, b.d).d));
    if (ds.size === 1) dens.push([...ds][0]);
    if (dens.length === 2) break;
  }
  if (dens.length < 2) { toast('Build at least two lanes with a single consistent fraction first'); return; }
  $('#labA').value = dens[0]; $('#labB').value = dens[1];
  updateLab();
}

/* ------------------------------ controls ------------------------------- */
function syncControls() {
  $('#bpm').value = state.bpm; $('#bpmOut').textContent = state.bpm;
  $('#master').value = state.master;
}

function wireControls() {
  $('#play').addEventListener('click', () => (state.playing ? stop() : play()));
  $('#bpm').addEventListener('input', (e) => { state.bpm = +e.target.value; $('#bpmOut').textContent = state.bpm; markDirty(); });
  $('#master').addEventListener('input', (e) => { state.master = +e.target.value; if (masterNode) masterNode.gain.setTargetAtTime(state.master, ctx.currentTime, 0.01); });
  $('#addLane').addEventListener('click', addLane);
  $('#randomize').addEventListener('click', randomize);
  $('#clear').addEventListener('click', clearAll);
  $('#save').addEventListener('click', saveLocal);
  $('#load').addEventListener('click', loadLocal);
  $('#export').addEventListener('click', exportJSON);
  $('#import').addEventListener('click', () => $('#jsonInput').click());
  $('#help').addEventListener('click', () => ($('#helpModal').hidden = false));

  $('#midiToggle').addEventListener('click', toggleMidi);
  $('#midiPort').addEventListener('change', (e) => {
    if (midiAccess) midiOut = midiAccess.outputs.get(e.target.value) || midiOut;
  });

  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#modeCreate').addEventListener('click', () => setMode('create'));
  $('#modeLearn').addEventListener('click', () => setMode('learn'));
  $('#tonesToggle').addEventListener('click', toggleTones);
  $('#tutPrev').addEventListener('click', tutorialPrev);
  $('#tutNext').addEventListener('click', tutorialNext);
  $('#tutLesson').addEventListener('change', (e) => enterLesson(+e.target.value));
  $('#openLab').addEventListener('click', openLab);
  $('#grooveLabBtn').addEventListener('click', openLab);
  $('#labA').addEventListener('input', updateLab);
  $('#labB').addEventListener('input', updateLab);
  $('#labUseLanes').addEventListener('click', labUseLanes);
  $('#labPlayGroove').addEventListener('click', playLabGroove);
  $('#labPlayTone').addEventListener('click', playLabTone);
  $('#labModal').addEventListener('click', (e) => { if (e.target.id === 'labModal' || e.target.dataset.close != null) closeLab(); });

  $('#helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal' || e.target.dataset.close != null) $('#helpModal').hidden = true; });

  $('#recToggle').addEventListener('click', toggleRecording);
  $('#recPreview').addEventListener('click', previewTrim);
  $('#recUse').addEventListener('click', useRecording);
  $('#recModal').addEventListener('click', (e) => { if (e.target.id === 'recModal' || e.target.dataset.close != null) closeRecorder(); });
  wireTrimHandle($('#recTrimStart'), 'start');
  wireTrimHandle($('#recTrimEnd'), 'end');

  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f && pendingSampleLane) decodeInto(pendingSampleLane, f);
    e.target.value = '';
  });
  $('#jsonInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) { try { const data = JSON.parse(await f.text()); pushUndo(); deserialize(data); toast('Imported'); } catch { toast('Invalid JSON'); } }
    e.target.value = '';
  });

  document.addEventListener('keydown', (e) => {
    // Escape closes an open modal first — even from a focused input inside it.
    const recOpen = !$('#recModal').hidden, labOpen = !$('#labModal').hidden, helpOpen = !$('#helpModal').hidden;
    if (e.key === 'Escape') {
      if (recOpen) { closeRecorder(); return; }
      if (labOpen) { closeLab(); return; }
      if (helpOpen) { $('#helpModal').hidden = true; return; }
    }
    if (recOpen || labOpen || helpOpen) return;   // don't fire board shortcuts behind a modal
    if (e.target.matches('input, textarea')) return;
    // Undo / redo (Ctrl/Cmd+Z, Ctrl/Cmd+Y or Shift+Z)
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    }
    if (e.code === 'Space') { e.preventDefault(); state.playing ? stop() : play(); return; }
    if (e.key === 'Escape' && armed) { disarm(); return; }
    if (!hoverTarget) return;
    const { li, bi } = hoverTarget;
    if (!state.lanes[li] || !state.lanes[li].blocks[bi]) return;
    if (e.key >= '2' && e.key <= '6') { subdivide(li, bi, +e.key); }
    else if (e.key.toLowerCase() === 'm') { mergeWithNext(li, bi); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteBlock(li, bi); }
  });
}

/* ------------------------------ boot ----------------------------------- */
function init() {
  registerAllFractions();     // seed patterns may include sizes (e.g. 1/15) to add to the wall
  renderPalette();
  syncControls();
  renderSeq();
  wireControls();
  renderTutorial();
  refreshMidiUI();
  requestAnimationFrame(tickPlayhead);
}
document.addEventListener('DOMContentLoaded', init);
