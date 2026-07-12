# Pattern Block Drum Machine

A digital take on a **pattern-block drum machine**: the rainbow **fraction wall**
is a bin of wooden blocks, and you slide those fraction-length blocks into a
normal horizontal lane sequencer to build rhythms.

Inspired by classroom fraction rods — every block is a slice of one bar
(`1`, `1/2`, `1/3` … `1/12`), and because a block's **width is its length in
time**, stacking lanes of different fractions gives you rich polyrhythms.

Colours are built from **prime factorization**, not a fixed palette: each prime
gets its own strong hue (2 is blue, 3 is red), a prime power intensifies that
hue as the exponent grows (`9 = 3²` is a deeper "super red"), and a composite
blends its factors' hues weighted by exponent (`6 = 2×3` is purple; `12 = 2²×3`
leans further toward blue than `6` does, from that extra factor of 2). A
block's colour is always the same on the wall and in a lane.

![fraction wall + sequencer](docs/screenshot.png)

Two pages: **`index.html`** is the plain sampler above. **`learn.html`** is a
guided tutorial that builds on the same engine — see [Learn mode](#-learn-mode)
below.

## Run it

It's a single static page — no build step, no dependencies.

```bash
# just open it
open index.html          # macOS
xdg-open index.html      # Linux

# …or serve it (any static server works)
npx serve .
python3 -m http.server
```

Everything runs locally in the browser with the Web Audio API. Nothing is uploaded.

## How to play

- **Build a rhythm** — drag a block from the fraction wall into a lane, or
  **click a block to "arm" it** and then click a lane to drop a copy (no dragging
  needed). Blocks tile from the left; left-to-right is the order they play. The
  brush always follows **whichever block you clicked last** — wall or placed —
  so you can pick up a shape straight from the sequencer. Press <kbd>Esc</kbd> to
  put the brush down. An unfinished lane shows a faint dashed ghost over its
  remaining time (e.g. "3/4 left") so you can see what's left to fill. Drag a
  placed block off the board — onto the wall, the header, anywhere that isn't
  a lane — and it's deleted.
- **Rotate the faces** — click a placed block to turn it to its next face:
  **loud → mid → soft → mute**. That's the block's dynamic, like rotating a
  physical wooden block to a different face. A **muted** block still holds its
  time, so it doubles as a **rest**.
- **Subdivide a beat** — right-click a block (or hover it and press
  <kbd>2</kbd>–<kbd>6</kbd>) to cut it into equal pieces. Split a `1/5` into 3
  and you get three `1/15` pieces — the total length never changes, and the
  pieces stay in perfect alignment with the rest of the bar no matter how deep
  you subdivide. Any new size that isn't on the wall yet (like `1/15`) is
  **added as a new row and the wall reflows to fit**. Press <kbd>M</kbd> to merge
  a block back into the one after it.
- **Bring your own sounds** — each lane has its own sampler. Drag an audio file
  onto a lane, or click 📁 to load one. Click a lane's name to cycle through the
  12 built-in synth voices instead.
- **Or record one** — click 🎙️ on a lane to record straight from your
  microphone (up to 12s), with a live level meter while you record. After you
  stop, drag the two handles on the waveform to trim it, hit **Preview trim** to
  check it, then **Use this sample** to drop the trimmed clip into that lane.
  Nothing is uploaded — recording, trimming and playback all stay in the browser.
- **Send MIDI** — flip **MIDI out** to On and choose a device. Each lane sends
  its own note on channel 10 (the little number by the lane name; defaults follow
  the General-MIDI drum map) and the block face sets the velocity. Great for
  driving hardware or a DAW instrument. *(Web MIDI needs an `https://` page — it
  works on the deployed site, and in Chrome/Edge.)*
- **Mix** — `M` mutes a lane, `S` solos it, and the slider sets its level. Use
  **+ Lane** to add more instruments.
- **Transport** — Space (or the Play button) starts/stops. Tempo sets the bar
  length; one bar = four beats. Stopping cuts any sound still ringing, so long
  samples don't keep playing after you hit Stop.

## 🎵 Tones

Flip **Tones** on (in the sequencer header) to play your beat as pitched notes
instead of drums. Lanes are stacked on a minor-pentatonic scale, so hits that
land together turn into chords — a quick way to hear the *harmony* hiding in a
rhythm.

## 🎓 Learn mode

![The tutorial and Groove Lab in Learn mode](docs/learn-mode.png)

The plain sampler above (`index.html`) never mentions Learn mode at all — it's
a clean, standalone drum machine. The tutorial lives at its own URL,
**`learn.html`**, which drops you straight into lesson 1 and adds a **← Sampler**
link back to the plain page, plus the Create/Learn toggle so you can switch
freely once you're there. (Under the hood `learn.html` just redirects to
`index.html?mode=learn`, which is what actually decides what to show — no
duplicated markup between the two.)

**Create** is the free-play sampler, no rules. **Learn** turns the app into a
guided **tutorial** — and it *remembers* your Create pattern, resetting the
board for the lessons and handing it back when you switch out. It's a set of
lessons you can step through or jump between:

The lessons never do the maths *for* you — they're all feel and trial-and-error.
You build grooves, then **cut the pieces until the lanes line up**, discovering
the shared grid by ear rather than being told a number. (When you're curious
about the actual numbers, the **Groove Lab** is one click away.)

1. **Two against three** — stack a 2 and a 3, feel them pull, then cut until they
   line up.
2. **Rock (why it locks)** — a real kick/snare/hat beat; add a kick push, recut
   the hats to match, and notice it barely changes — rock's parts all share an
   easy grid, so it locks.
3. **Blues shuffle** — a ba-bum kick and backbeat snare with a swung ride; the
   triplet roll that makes the shuffle.
4. **Ewe drumming (Ghana)** — a real West-African groove: a gankoguí bell in four,
   an axatse shaker on the pulse, and a drum you set to three. Four and three
   *weave* — the engine of West-African music and the 6/8 feels that grew from it.
5. **Four against five** — a four-on-the-floor dance beat with a hook on five;
   cut until they line up (it takes a *lot* of tiny pieces) and feel why it's so
   restless. The same four-and-five as pitches is a sweet chord — try **Tones**.

Throughout, a lane stays **silent until it makes a full bar** (a muted block
counts as a rest, and the missing amount is never spelled out — that's the
puzzle), you **can't skip a step until you've actually done it**, and **cutting a
block mutes the new pieces**, so the groove holds while the finer grid appears.
Cutting further than needed doesn't sneak past, either — if you overshoot, the
tutorial notices and nudges you to merge a couple of pieces back together; merge
just one and it tidies up the rest for you.

The **Groove Lab** is a popout (button in the toolbar, works in either mode).
Pick any two numbers, or hit **Use my lanes**, and it live-computes:

- their **HCF (GCD)** and **LCD (LCM)**, with a colour-coded prime factorization
  (the same colours as the wall);
- how they groove, judged by the reduced **LCM** and honest about the top end:
  🔒 *Locked* → 🙂 *Classic cross-rhythm* → 😎 *Funky* → 🔥 *Deep funk* →
  🌶️ *Knotty* → 🤯 *Dissonant* (past a point it's tension, not groove);
- a plain-English explanation worked out from the shared factor;
- **▶ Hear the polyrhythm** (the two numbers as a click pattern) and **🎵 Hear it
  as a pitch** (the same ratio as two sustained tones). It names the interval in
  **7-limit just intonation and beyond** — so septimal ratios like `7/6` come
  back as a *subminor third*, not "custom", the way Ben Johnston would want.

Every edit is **undoable** — <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd>
(or the ↶ / ↷ buttons). Undo snapshots keep loaded/recorded samples intact, and
the history resets when you switch modes or lessons.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| <kbd>2</kbd>–<kbd>6</kbd> | Subdivide the hovered block into that many pieces |
| <kbd>M</kbd> | Merge the hovered block with the next one |
| <kbd>Del</kbd> / <kbd>Backspace</kbd> | Remove the hovered block |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Undo / redo (also <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>) |
| <kbd>Esc</kbd> | Put down the armed brush |
| <kbd>Space</kbd> | Play / stop |

## Save & share

- **Save / Load** keep your last pattern in this browser (localStorage).
- **Export** downloads the pattern as JSON; **Import** loads one back. Custom
  audio samples aren't stored in the JSON — reload those per session.

## Under the hood

- `index.html` — layout and controls.
- `styles.css` — the dark board + rainbow fraction-wall styling.
- `app.js` — everything else:
  - **Fraction math** — blocks are stored as exact `n/d` rationals and reduced
    for display, so subdivision/merge is always precise.
  - **Voices** — 12 drum sounds synthesized once into `AudioBuffer`s via an
    `OfflineAudioContext`, so it makes sound with no external assets.
  - **Scheduler** — a look-ahead scheduler (25 ms tick, ~120 ms window) turns
    each lane's tiled blocks into precisely-timed one-shots, with a lane-independent
    gain chain feeding a master bus.

## Physical version?

The long-term dream is the tactile original: wooden fraction blocks you drop into
slots, each with four faces (mute / soft / mid / loud). This digital version is a
playground for the same idea — and a place to prototype patterns before building
the real thing.
