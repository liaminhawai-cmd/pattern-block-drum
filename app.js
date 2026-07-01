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
const ROWS = 12;                        // fraction wall rows: 1 .. 1/12
const EPS = 1e-9;
const FACES = ['loud', 'mid', 'soft', 'mute'];   // click-rotation order
const FACE_GAIN = { loud: 1.0, mid: 0.6, soft: 0.3, mute: 0 };
const FACE_DOTS = { loud: '•••', mid: '••', soft: '•', mute: '×' };

// Rainbow palette approximating the classic fraction-wall chart (rows 1..12).
const PALETTE = [
  '#d81b6a', '#e51e5a', '#e23131', '#ef6a2a', '#f68b1f', '#f5a623',
  '#d7c81e', '#3fae4a', '#12a37f', '#18b6c4', '#2f8fd6', '#6a4aa3'
];
const rowColor = (den) => PALETTE[Math.min(den, ROWS) - 1];

/* ------------------------------ fraction math -------------------------- */
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function reduce(n, d) { const g = gcd(n, d) || 1; return { n: n / g, d: d / g }; }
const fval = (b) => b.n / b.d;
function fracLabel(b) {
  const r = reduce(b.n, b.d);
  if (r.d === 1) return String(r.n);
  return `${r.n}/${r.d}`;
}

/* ------------------------------ state ---------------------------------- */
// Built-in synth voices (rendered to buffers at startup).
const VOICES = ['Kick', 'Snare', 'Clap', 'Closed Hat', 'Open Hat', 'Tom',
  'Conga', 'Rim', 'Cowbell', 'Shaker', 'Clave', 'Bell'];

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
  blocks,                // [{ n, d, face }]
});

// A block helper.
const blk = (n, d, face = 'loud') => ({ n, d, face });

const state = {
  bpm: 96,
  master: 0.9,
  playing: false,
  lanes: [],
};

/* seed a groovy, instructive default kit ------------------------------- */
function seedDefault() {
  laneSeq = 0;
  state.lanes = [
    // Kick: four on the floor
    newLane(0, [blk(1, 4, 'loud'), blk(1, 4, 'mid'), blk(1, 4, 'loud'), blk(1, 4, 'mid')]),
    // Snare: backbeat on 2 & 4 (muted blocks = rests holding the time)
    newLane(1, [blk(1, 4, 'mute'), blk(1, 4, 'loud'), blk(1, 4, 'mute'), blk(1, 4, 'loud')]),
    // Closed hat: eighths, alternating soft/mid
    newLane(3, Array.from({ length: 8 }, (_, i) => blk(1, 8, i % 2 ? 'mid' : 'soft'))),
    // Conga: fifths, with the middle fifth cut into 3 (1/15 flam) — shows subdivision
    newLane(6, [
      blk(1, 5, 'mid'), blk(1, 5, 'soft'),
      blk(1, 15, 'loud'), blk(1, 15, 'soft'), blk(1, 15, 'soft'),
      blk(1, 5, 'soft'), blk(1, 5, 'mid'),
    ]),
  ];
}
seedDefault();

/* ------------------------------ audio ---------------------------------- */
let ctx = null, masterNode = null;
const voiceBuffers = new Array(VOICES.length).fill(null);

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

function trigger(lane, face, when) {
  const buf = laneBuffer(lane);
  if (!buf || face === 'mute') return;
  ensureLaneNode(lane);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = FACE_GAIN[face];
  src.connect(g).connect(lane.node);
  src.start(when);
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
    case 7: { // Rim
      const o = oac.createOscillator(); o.type = 'square'; o.frequency.value = 1700;
      env(o, 0.0005, 0.5, 0.05).connect(out); o.start(t0); o.stop(t0 + 0.08); break;
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
      trigger(state.lanes[ev.lane], ev.face, t);
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

function renderPalette() {
  const wrap = document.getElementById('palette');
  wrap.innerHTML = '';
  for (let den = 1; den <= ROWS; den++) {
    const row = el('div', 'prow');
    row.style.gridTemplateColumns = `repeat(${den}, 1fr)`;
    for (let i = 0; i < den; i++) {
      const b = el('div', 'pblock');
      b.style.setProperty('--c', rowColor(den));
      b.draggable = true;
      b.dataset.n = 1; b.dataset.d = den;
      b.innerHTML = den === 1 ? '1' : `<span>1&frasl;${den}</span>`;
      b.title = den === 1 ? 'A whole bar' : `A 1/${den} block — drag me into a lane`;
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

    /* gutter -------------------------------------------------------- */
    const gutter = el('div', 'gutter');
    const voiceRow = el('div', 'lane-voice');
    const dot = el('span', 'voice-dot'); dot.style.setProperty('--c', rowColor((li % ROWS) + 1));
    const name = el('button', 'lane-name'); name.textContent = lane.name;
    name.title = 'Click to change the built-in voice';
    name.addEventListener('click', () => { cycleVoice(lane); });
    voiceRow.append(dot, name);

    const controls = el('div', 'gutter-controls');
    const mBtn = el('button', 'mini' + (lane.muted ? ' on-m' : ''), 'M'); mBtn.title = 'Mute lane';
    mBtn.addEventListener('click', () => { lane.muted = !lane.muted; applyLaneGains(); renderSeq(); });
    const sBtn = el('button', 'mini' + (lane.solo ? ' on-s' : ''), 'S'); sBtn.title = 'Solo lane';
    sBtn.addEventListener('click', () => { lane.solo = !lane.solo; applyLaneGains(); renderSeq(); });
    const loadBtn = el('button', 'mini', '📁'); loadBtn.title = 'Load an audio sample';
    loadBtn.addEventListener('click', () => loadSampleFor(lane));
    const vol = el('input', 'lane-vol'); vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.01; vol.value = lane.gain;
    vol.title = 'Lane level';
    vol.addEventListener('input', () => { lane.gain = +vol.value; applyLaneGains(); });
    const rm = el('button', 'mini rm', '×'); rm.title = 'Remove lane';
    rm.addEventListener('click', () => { removeLane(li); });
    controls.append(mBtn, sBtn, loadBtn, vol, rm);
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
      track.appendChild(el('div', 'track-empty', 'drag a fraction block here'));
    }

    lane.blocks.forEach((b, bi) => {
      const blockEl = el('div', 'block face-' + b.face);
      const w = Math.min(fval(b), 1) * 100;
      blockEl.style.flex = `0 0 ${w}%`;
      blockEl.style.setProperty('--c', rowColor((li % ROWS) + 1));
      blockEl.draggable = true;
      blockEl.dataset.bi = bi;
      if (fval(b) < 0.06) blockEl.classList.add('narrow');
      blockEl.innerHTML = `<span class="blabel">${fracLabel(b)}</span><span class="dots">${FACE_DOTS[b.face]}</span>`;
      blockEl.title = `${fracLabel(b)} · ${b.face} — click to rotate face, right-click to subdivide`;

      let dragged = false;
      blockEl.addEventListener('click', () => {
        if (dragged) { dragged = false; return; }
        rotateFace(lane, bi);
      });
      blockEl.addEventListener('dragstart', (e) => {
        dragged = true;
        drag = { kind: 'move', n: b.n, d: b.d, face: b.face, fromLane: li, fromIdx: bi };
        blockEl.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', fracLabel(b));
      });
      blockEl.addEventListener('dragend', () => { blockEl.classList.remove('dragging'); setTimeout(() => (dragged = false), 0); });
      blockEl.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtxMenu(e, li, bi); });
      blockEl.addEventListener('mouseenter', () => { hoverTarget = { li, bi }; });
      blockEl.addEventListener('mouseleave', () => { if (hoverTarget && hoverTarget.li === li && hoverTarget.bi === bi) hoverTarget = null; });

      track.appendChild(blockEl);
    });

    // capacity readout
    const cap = el('div', 'cap');
    cap.textContent = capacityLabel(sum);
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

    laneEl.append(gutter, track);
    seq.appendChild(laneEl);
  });

  // (re)attach playhead
  if (!ph) { ph = el('div', 'playhead'); ph.id = 'playhead'; }
  seq.appendChild(ph);
}

function capacityLabel(sum) {
  const r = reduce(Math.round(sum * 720), 720); // 720 = lcm(1..12)/... enough resolution
  if (Math.abs(sum - 1) < 1e-6) return 'full bar';
  if (sum > 1) return 'over ' + (r.d === 1 ? r.n : `${r.n}/${r.d}`);
  return (r.d === 1 ? r.n : `${r.n}/${r.d}`) + ' full';
}

/* ------------------------------ block ops ------------------------------ */
function rotateFace(lane, bi) {
  const b = lane.blocks[bi];
  b.face = FACES[(FACES.indexOf(b.face) + 1) % FACES.length];
  markDirty(); renderSeq();
}

function subdivide(li, bi, k) {
  const lane = state.lanes[li];
  const b = lane.blocks[bi];
  const pieces = Array.from({ length: k }, () => blk(b.n, b.d * k, b.face));
  lane.blocks.splice(bi, 1, ...pieces);
  markDirty(); renderSeq();
}

function mergeWithNext(li, bi) {
  const lane = state.lanes[li];
  if (bi >= lane.blocks.length - 1) { toast('Nothing after this block to merge'); return; }
  const a = lane.blocks[bi], b = lane.blocks[bi + 1];
  const n = a.n * b.d + b.n * a.d;
  const d = a.d * b.d;
  const r = reduce(n, d);
  lane.blocks.splice(bi, 2, blk(r.n, r.d, a.face));
  markDirty(); renderSeq();
}

function deleteBlock(li, bi) {
  state.lanes[li].blocks.splice(bi, 1);
  markDirty(); renderSeq();
}

function insertBlock(li, index, block) {
  const lane = state.lanes[li];
  const sum = laneSum(lane);
  if (sum + fval(block) > 1 + 1e-6) return false;   // would overflow the bar
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
    // remove from source first (adjust index if same lane and before insert point)
    const src = state.lanes[d.fromLane];
    const moved = src.blocks.splice(d.fromIdx, 1)[0];
    if (d.fromLane === li && d.fromIdx < index) index--;
    const target = state.lanes[li];
    const sumWithout = laneSum(target);
    if (sumWithout + fval(moved) > 1 + 1e-6) {
      // doesn't fit — put it back
      src.blocks.splice(d.fromIdx, 0, moved);
      rejectFlash(track); toast('No room in that lane');
    } else {
      target.blocks.splice(index, 0, moved);
    }
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
  state.lanes.push(newLane(state.lanes.length));
  if (ctx) ensureLaneNode(state.lanes[state.lanes.length - 1]);
  markDirty(); applyLaneGains(); renderSeq();
}
function removeLane(li) {
  state.lanes.splice(li, 1);
  markDirty(); applyLaneGains(); renderSeq();
}
function cycleVoice(lane) {
  lane.voice = (lane.voice + 1) % VOICES.length;
  lane.buffer = null;
  lane.name = VOICES[lane.voice];
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

/* ------------------------------ persistence ---------------------------- */
const SAVE_KEY = 'pbdm.pattern.v1';
function serialize() {
  return {
    bpm: state.bpm, master: state.master,
    lanes: state.lanes.map((l) => ({
      name: l.name, voice: l.voice, gain: l.gain, muted: l.muted, solo: l.solo,
      blocks: l.blocks.map((b) => ({ n: b.n, d: b.d, face: b.face })),
    })),
  };
}
function deserialize(data) {
  if (!data || !Array.isArray(data.lanes)) return;
  state.bpm = data.bpm || 96; state.master = data.master ?? 0.9;
  laneSeq = 0;
  state.lanes = data.lanes.map((l) => {
    const lane = newLane(l.voice || 0, (l.blocks || []).map((b) => blk(b.n, b.d, b.face || 'loud')));
    lane.name = l.name || lane.name; lane.gain = l.gain ?? 0.85; lane.muted = !!l.muted; lane.solo = !!l.solo;
    return lane;
  });
  if (ctx) { state.lanes.forEach(ensureLaneNode); applyLaneGains(); }
  syncControls(); markDirty(); renderSeq();
}
function saveLocal() { localStorage.setItem(SAVE_KEY, JSON.stringify(serialize())); toast('Saved to this browser'); }
function loadLocal() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) { toast('Nothing saved yet'); return; }
  try { deserialize(JSON.parse(raw)); toast('Loaded save'); } catch { toast('Save was corrupt'); }
}
function exportJSON() {
  const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'pattern-block-drum.json'; a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------ randomize ------------------------------ */
function randomize() {
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
  state.lanes.forEach((l) => (l.blocks = []));
  markDirty(); renderSeq();
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

  $('#helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal' || e.target.dataset.close != null) $('#helpModal').hidden = true; });

  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f && pendingSampleLane) decodeInto(pendingSampleLane, f);
    e.target.value = '';
  });
  $('#jsonInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) { try { deserialize(JSON.parse(await f.text())); toast('Imported'); } catch { toast('Invalid JSON'); } }
    e.target.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); state.playing ? stop() : play(); return; }
    if (!hoverTarget) return;
    const { li, bi } = hoverTarget;
    if (!state.lanes[li] || !state.lanes[li].blocks[bi]) return;
    if (e.key >= '2' && e.key <= '6') { subdivide(li, bi, +e.key); }
    else if (e.key === '1') { /* merge shorthand not used; 1 reserved */ }
    else if (e.key.toLowerCase() === 'm') { mergeWithNext(li, bi); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteBlock(li, bi); }
    else if (e.key >= '7' && e.key <= '9') { /* ignore */ }
  });
}

/* ------------------------------ boot ----------------------------------- */
function init() {
  renderPalette();
  syncControls();
  renderSeq();
  wireControls();
  requestAnimationFrame(tickPlayhead);
}
document.addEventListener('DOMContentLoaded', init);
