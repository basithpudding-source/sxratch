// Sxratch — main entry. Wires DOM + input to the audio engine.

import { AudioEngine, Sampler } from "./audio-engine.js";
import { Waveform } from "./waveform.js";
import { UI } from "./ui.js";
import { attachScratchPad, attachKnob, attachTrackpadGestures, attachWaveformScrub, attachFader } from "./input.js";
import { PracticeCoach, LESSONS, makeBeat } from "./practice.js";
import { SongBuilder } from "./songbuilder.js";
import { generateScratchPreset, generateLaserPreset } from "./presets.js";
import { MidiInput, DEFAULT_MIDI_MAP } from "./midi.js";
import { haptic, setHapticsEnabled, hapticsSupported } from "./haptics.js";

let coach = null;
let sampler = null;

const engine = new AudioEngine();
const ui = new UI(engine);
const analysers = {};
const discs = {};                               // rotating platter elements
const vizCache = {};                            // per-deck { canvas, ctx, buf } for the FFT visualizer (reused each frame)
const rot = { A: { pos: 0, rate: 0, t: 0 }, B: { pos: 0, rate: 0, t: 0 } };
const hot = { A: [null, null, null, null], B: [null, null, null, null] };
let mappingSource = null;                       // { deckId, start, end } for sampler region mapping

const DECK_COLORS = { A: "#37e6c8", B: "#ff5d8f" };
const CUE_COLORS = ["#ffd23f", "#37e6c8", "#ff5d8f", "#6c7bff"];
const DEG_PER_SEC = 200;                          // 33⅓ RPM platter spin

// ---------- Configurable controls (persisted to localStorage) ----------
const DEFAULT_KEYS = {
  playA: "KeyQ", playB: "KeyP",
  cueA: "KeyW", cueB: "KeyO",
  setCueA: "KeyE", setCueB: "KeyI",
  crossLeft: "ArrowLeft", crossRight: "ArrowRight", crossCenter: "ArrowDown",
  hotA1: "Digit1", hotA2: "Digit2", hotA3: "Digit3", hotA4: "Digit4",
  hotB1: "Digit6", hotB2: "Digit7", hotB3: "Digit8", hotB4: "Digit9",
  samp1: "KeyA", samp2: "KeyS", samp3: "KeyD", samp4: "KeyF",
  samp5: "KeyG", samp6: "KeyH", samp7: "KeyJ", samp8: "KeyK",
  loopA: "KeyR", loopB: "KeyU",
  playBoth: "Space", syncA: "KeyT", syncB: "KeyY",
};
const DEFAULT_GESTURES = {
  armA: "ControlRight", armB: "ControlLeft",
  slamAMod: "AltRight", slamBMod: "ShiftLeft", // left slam = Left Ctrl + Left Shift
  invertScratch: false,
  scratchSensitivity: 0.0016,
  crossfadeSensitivity: 0.0042,
  idleMs: 90,
  crossfadeCurve: "power",
  hamsterMode: false,
};
const config = loadConfig();
let keyMap = {}; // key code -> action name
const tempoFaders = {}; // { A, B } custom fader handles, for SYNC
let midi = null;                 // MidiInput instance
let midiLearn = null;            // action id currently waiting to bind a CC
const midiTargets = {};          // action id -> (value 0..1) => void  (set on-screen control)
const midiJogState = { A: { active: false, timer: null }, B: { active: false, timer: null } };

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("sxratch.config") || "{}"); } catch {}
  return {
    keys: { ...DEFAULT_KEYS, ...(saved.keys || {}) },
    gestures: { ...DEFAULT_GESTURES, ...(saved.gestures || {}) },
    midi: {
      enabled: saved.midi?.enabled ?? false,
      map: { ...DEFAULT_MIDI_MAP, ...(saved.midi?.map || {}) },
    },
    haptics: saved.haptics ?? true,
  };
}
function saveConfig() {
  try { localStorage.setItem("sxratch.config", JSON.stringify(config)); } catch {}
}
function rebuildKeyMap() {
  keyMap = {};
  for (const [action, code] of Object.entries(config.keys)) keyMap[code] = action;
}

// ---------- Boot (needs a user gesture for audio) ----------
const overlay = document.getElementById("start-overlay");
document.getElementById("start-btn").addEventListener("click", async () => {
  try {
    await engine.init();
    await engine.resume();
    engine.crossfadeCurve = config.gestures.crossfadeCurve ?? "power";
    engine.hamster = config.gestures.hamsterMode ?? false;
    setup();
    overlay.style.display = "none";
  } catch (err) {
    console.error(err);
    alert("Couldn't start audio: " + err.message);
  }
});

function setup() {
  // Waveforms
  for (const id of ["A", "B"]) {
    const canvas = document.getElementById(`wave-${id}`);
    const wave = new Waveform(canvas, { color: DECK_COLORS[id] });
    ui.setWaveform(id, wave);

    const deck = engine.decks[id];
    discs[id] = document.getElementById(`disc-${id}`);
    deck.onPosition = (pos, playing, rate, loop) => {
      ui.updatePosition(id, pos);
      ui.setPlaying(id, playing);
      const r = rot[id];
      r.pos = pos; r.rate = rate; r.t = performance.now();
      ui.waves[id].setLoop(loop);
      const autoBtn = document.querySelector(`.loop-auto[data-deck="${id}"]`);
      if (autoBtn) autoBtn.classList.toggle("active", !!(loop && loop.active));
    };

    // Per-channel VU analyser (taps post-volume signal)
    const an = engine.ctx.createAnalyser();
    an.fftSize = 256;
    deck.volume.connect(an);
    analysers[id] = { node: an, buf: new Float32Array(an.fftSize), el: document.getElementById(`vu-${id}`) };

    // Scratch pad (mouse / touch press-drag)
    attachScratchPad(document.getElementById(`pad-${id}`), deck, { sensitivity: 0.0024 });

    // Interactive waveform: scrub / seek / hot cues
    attachWaveformScrub(canvas, deck, wave, {
      onSeek: (p) => deck.seek(p),
      onSetCue: (p) => setCueSlot(id, hot[id].indexOf(null) === -1 ? 0 : hot[id].indexOf(null), p),
      onClearCue: (slot) => clearCue(id, slot),
    });
  }

  // Device-appropriate scratch hint.
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  document.querySelectorAll(".pad-hint").forEach((h) => {
    h.textContent = coarse ? "drag ← → to scratch" : "hold Ctrl + one finger ↕ scratch · two fingers ↔ crossfade";
  });

  setupLoading();
  setupTransport();
  setupMixer();
  setupDialogs();
  setupWaveTools();
  setupHotcues();
  setupSampler();
  setupLoopsFx();
  setupKeyboard();
  setupSettings();
  setupMidi();
  setupPractice();
  setupNav();
  setupGlobalRecorder();
  setupPresets();
  attachTrackpadGestures(engine, ui, config);

  // Debug handle (handy in the console for testing/automation).
  window.sxratch = { engine, ui, analysers, hot, config, coach, get sampler() { return sampler; }, get midi() { return midi; } };

  // Keep the platters as perfect circles that fit the (dynamic) scratch zone.
  sizePlatters();
  const ro = new ResizeObserver(() => sizePlatters());
  ro.observe(document.getElementById("scratch-zone"));

  window.addEventListener("resize", () => {
    ui.waves.A?.resize();
    ui.waves.B?.resize();
    sizePlatters();
  });

  requestAnimationFrame(frameLoop);
}

/** Size each platter to the largest circle that fits its jog pad. */
function sizePlatters() {
  for (const id of ["A", "B"]) {
    const pad = document.getElementById(`pad-${id}`);
    const plat = pad && pad.querySelector(".platter");
    if (!plat) continue;
    const size = Math.max(90, Math.min(pad.clientWidth * 0.86, pad.clientHeight * 0.82, 260));
    plat.style.width = `${size}px`;
    plat.style.height = `${size}px`;
  }
}

// ---------- Loading audio ----------
function setupLoading() {
  document.querySelectorAll(".load-btn").forEach((btn) => {
    const deck = btn.dataset.deck;
    const input = document.querySelector(`.file-input[data-deck="${deck}"]`);
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      if (input.files[0]) loadFile(deck, input.files[0]);
      input.value = "";
    });
  });

  // Instant Doubles — copy a deck (track + position) onto the other.
  document.querySelectorAll(".dbl-btn").forEach((btn) =>
    btn.addEventListener("click", () => instantDoubles(btn.dataset.deck))
  );

  // Drag & drop onto a deck's waveform area or its scratch pad
  for (const id of ["A", "B"]) {
    const zones = [document.querySelector(`.deck-meta[data-deck="${id}"]`), document.getElementById(`pad-${id}`)];
    zones.forEach((zone) => {
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("dragover");
        const file = e.dataTransfer.files[0];
        if (file) loadFile(id, file);
      });
    });
  }

  // URL dialog
  const urlDialog = document.getElementById("url-dialog");
  const urlInput = document.getElementById("url-input");
  let urlDeck = "A";
  document.querySelectorAll(".url-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      urlDeck = btn.dataset.deck;
      urlInput.value = "";
      urlDialog.hidden = false;
      urlInput.focus();
    });
  });
  document.getElementById("url-cancel").addEventListener("click", () => (urlDialog.hidden = true));
  document.getElementById("url-load").addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (url) loadURL(urlDeck, url);
    urlDialog.hidden = true;
  });
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("url-load").click();
  });
}

async function loadFile(deck, file) {
  ui.toast(`Loading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const audio = await engine.decode(buf);
    applyLoaded(deck, audio, file.name.replace(/\.[^.]+$/, ""));
  } catch (err) {
    console.error(err);
    ui.toast("Couldn't decode that file");
  }
}

async function loadURL(deck, url) {
  ui.toast("Fetching…");
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(res.status + "");
    const buf = await res.arrayBuffer();
    const audio = await engine.decode(buf);
    const name = decodeURIComponent(url.split("/").pop().split("?")[0]) || "track";
    applyLoaded(deck, audio, name.replace(/\.[^.]+$/, ""));
  } catch (err) {
    console.error(err);
    ui.toast("Load failed — check the URL allows cross-origin (CORS)");
  }
}

function applyLoaded(deck, audio, name) {
  engine.decks[deck].loadBuffer(audio, name);
  ui.waves[deck].setBuffer(audio);
  ui.setTitle(deck, name);
  ui.updatePosition(deck, 0);
  ui.setPlaying(deck, false);
  hot[deck] = [null, null, null, null]; // fresh track, clear hot cues
  renderHot(deck);
  ui.toast(`Deck ${deck}: ${name}`);
}

function instantDoubles(from) {
  const src = engine.decks[from];
  if (!src.buffer) { ui.toast(`Deck ${from} is empty`); return; }
  const to = from === "A" ? "B" : "A";
  applyLoaded(to, src.buffer, src.name);
  engine.decks[to].seek(src.position);
  if (src.playing) engine.decks[to].play();
  ui.toast(`Doubled ${from} → ${to}`);
}

// ---------- Global Mix Recorder ----------
function setupGlobalRecorder() {
  const recBtn = document.getElementById("record-btn");
  if (!recBtn) return;
  
  let rec = null;
  let chunks = [];
  let isRecording = false;
  let startTime = 0;
  let timerInterval = null;

  const dest = engine.ctx.createMediaStreamDestination();
  engine.limiter.connect(dest);

  recBtn.addEventListener("click", () => {
    if (!window.MediaRecorder) {
      ui.toast("MediaRecorder not supported in this browser");
      return;
    }

    if (!isRecording) {
      // Start Recording
      chunks = [];
      try {
        rec = new MediaRecorder(dest.stream);
      } catch (err) {
        console.error(err);
        ui.toast("Could not start recording");
        return;
      }

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      rec.onstop = () => {
        clearInterval(timerInterval);
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `sxratch-mix-${new Date().toISOString().slice(0, 10)}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        ui.toast("Mix saved!");
        recBtn.textContent = "🔴 REC";
      };

      rec.start();
      isRecording = true;
      startTime = Date.now();
      recBtn.classList.add("recording");
      ui.toast("Recording started...");

      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        recBtn.textContent = `🔴 REC [${m}:${s.toString().padStart(2, "0")}]`;
      }, 1000);

    } else {
      // Stop Recording
      if (rec && rec.state !== "inactive") {
        rec.stop();
      }
      isRecording = false;
      recBtn.classList.remove("recording");
    }
  });
}

// ---------- Presets Loader ----------
function setupPresets() {
  document.querySelectorAll(".preset-select").forEach((sel) => {
    const deckId = sel.dataset.deck;
    sel.addEventListener("change", async () => {
      const val = sel.value;
      if (!val) return;
      sel.disabled = true;

      try {
        let buffer = null;
        let label = "";

        if (val === "scratch") {
          label = "Scratch Tool (Synth)";
          buffer = generateScratchPreset(engine.ctx);
        } else if (val === "laser") {
          label = "Laser Preset (Synth)";
          buffer = generateLaserPreset(engine.ctx);
        } else if (val === "beat") {
          label = "Practice Beat (100 BPM)";
          buffer = makeBeat(engine.ctx, 100, 24);
          engine.decks[deckId].bpm = 100; // set deck BPM
        }

        if (buffer) {
          applyLoaded(deckId, buffer, label);
        }
      } catch (err) {
        console.error(err);
        ui.toast("Error generating preset");
      } finally {
        sel.disabled = false;
        sel.value = ""; // reset selector placeholder
      }
    });
  });
}

// ---------- Sampler ----------
function setupSampler() {
  sampler = new Sampler(engine, 8);
  const wrap = document.getElementById("sampler-pads");
  wrap.innerHTML = "";
  for (let i = 0; i < 8; i++) {
    const pad = document.createElement("div");
    pad.className = "samp-pad";
    pad.dataset.slot = String(i);
    pad.innerHTML = `<input type="file" accept="audio/*" hidden /><button class="samp-stop" title="Stop">■</button><span class="samp-key"></span><span class="samp-name">empty</span>`;
    const input = pad.querySelector("input");
    pad.querySelector(".samp-stop").addEventListener("click", (e) => { e.stopPropagation(); sampler.stop(i); });
    pad.addEventListener("click", () => {
      if (mappingSource) {
        mapRegionToPad(mappingSource.deckId, mappingSource.start, mappingSource.end, i);
        cancelMappingMode();
        return;
      }
      if (sampler.slots[i]) triggerSample(i);
      else input.click();
    });
    pad.addEventListener("dblclick", () => { sampler.clear(i); renderPad(i); });
    input.addEventListener("change", async () => {
      if (input.files[0]) {
        ui.toast(`Loading pad ${i + 1}…`);
        try { await sampler.load(i, input.files[0]); renderPad(i); ui.toast(`Pad ${i + 1}: ${sampler.slots[i].name}`); }
        catch { ui.toast("Couldn't decode that sound"); }
      }
      input.value = "";
    });
    wrap.append(pad);
  }
  sampler.onChange = (i) => {
    const pad = document.querySelector(`.samp-pad[data-slot="${i}"]`);
    if (pad) pad.classList.toggle("playing", sampler.isPlaying(i));
  };
  renderPads();
  document.getElementById("samp-stopall").addEventListener("click", () => sampler.stopAll());
  const vol = document.getElementById("sampler-vol");
  sampler.setVolume(parseFloat(vol.value));
  vol.addEventListener("input", () => sampler.setVolume(parseFloat(vol.value)));
}

function triggerSample(i) { if (sampler && sampler.trigger(i)) { flashPad(i); haptic(8); } }
function flashPad(i) {
  const pad = document.querySelector(`.samp-pad[data-slot="${i}"]`);
  if (!pad) return;
  pad.classList.add("hit");
  setTimeout(() => pad.classList.remove("hit"), 150);
}
function renderPad(i) {
  const pad = document.querySelector(`.samp-pad[data-slot="${i}"]`);
  if (!pad) return;
  const s = sampler.slots[i];
  pad.classList.toggle("loaded", !!s);
  pad.querySelector(".samp-name").textContent = s ? s.name : "empty";
  pad.querySelector(".samp-key").textContent = fmtKey(config.keys["samp" + (i + 1)]);
}
function renderPads() { for (let i = 0; i < 8; i++) renderPad(i); }

// ---------- Transport ----------
function setupTransport() {
  document.querySelectorAll(".play-btn").forEach((btn) =>
    btn.addEventListener("click", () => engine.decks[btn.dataset.deck].toggle())
  );
  document.querySelectorAll(".cue-btn").forEach((btn) =>
    btn.addEventListener("click", () => { engine.decks[btn.dataset.deck].goToCue(); coach?.notify(`cue${btn.dataset.deck}`); })
  );
  document.querySelectorAll(".set-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      engine.decks[btn.dataset.deck].setCue();
      ui.toast(`Cue ${btn.dataset.deck} set`);
      coach?.notify(`setCue${btn.dataset.deck}`);
    })
  );

  // To-start, rewind / fast-forward (hold), sync, play-both
  document.querySelectorAll(".tp-start").forEach((btn) =>
    btn.addEventListener("click", () => engine.decks[btn.dataset.deck].seek(0))
  );
  document.querySelectorAll(".tp-rew").forEach((btn) => holdScan(btn, btn.dataset.deck, -6));
  document.querySelectorAll(".tp-ff").forEach((btn) => holdScan(btn, btn.dataset.deck, 6));
  document.querySelectorAll(".sync-btn").forEach((btn) =>
    btn.addEventListener("click", () => syncDeck(btn.dataset.deck))
  );
  bothBtn = document.getElementById("both-btn");
  bothBtn.addEventListener("click", playBoth);
}

let bothBtn = null;

/** Hold a button to scan the deck forward/backward at `rate` (audible). */
function holdScan(btn, id, rate) {
  const d = engine.decks[id];
  let timer = null;
  const start = (e) => {
    e.preventDefault();
    d.touchStart(); d.jog(rate);
    btn.classList.add("held");
    timer = setInterval(() => d.jog(rate), 33); // keep the jog fresh as it decays
  };
  const stop = () => {
    if (!timer) return;
    clearInterval(timer); timer = null;
    d.touchEnd();
    btn.classList.remove("held");
  };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("pointercancel", stop);
}

/** Play or pause BOTH decks together. */
function playBoth() {
  if (engine.decks.A.playing || engine.decks.B.playing) {
    engine.decks.A.pause(); engine.decks.B.pause();
  } else {
    engine.decks.A.play(); engine.decks.B.play();
  }
}

/** Beat-match a deck to the other: match BPM (via tempo) and align the beat phase. */
function syncDeck(id) {
  const d = engine.decks[id];
  const otherId = id === "A" ? "B" : "A";
  const m = engine.decks[otherId];
  if (!d.buffer || !m.buffer) { ui.toast("Load both decks to sync"); return; }
  const masterEff = m.bpm * (1 + m.tempo / 100);
  const target = Math.max(-8, Math.min(8, (masterEff / d.bpm - 1) * 100));
  tempoFaders[id]?.set(target); // moves the fader + applies tempo + readout
  // Align this deck's beat phase to the master's.
  const eff = d.bpm * (1 + target / 100);
  if (d.duration > 0 && m.duration > 0) {
    const beatM = 60 / masterEff, beatD = 60 / eff;
    const mPhase = ((m.position * m.duration) % beatM + beatM) % beatM;
    const dTime = d.position * d.duration;
    const dPhase = (dTime % beatD + beatD) % beatD;
    let delta = mPhase - dPhase;
    if (delta > beatD / 2) delta -= beatD;
    if (delta < -beatD / 2) delta += beatD;
    d.seek(Math.max(0, Math.min(1, (dTime + delta) / d.duration)));
  }
  ui.toast(`Synced ${id}→${otherId} · ${eff.toFixed(1)} BPM`);
}

// ---------- Mixer ----------
function setupMixer() {
  // Channel knobs — TRIM, 3-band EQ and FILTER — each with a tick scale + arc.
  document.querySelectorAll(".knob").forEach((el) => {
    const deck = el.dataset.deck;
    const band = el.dataset.band;
    const svg = el.closest(".knob-dial").querySelector(".knob-scale");
    const setArc = buildKnobScale(svg, band === "filter" ? "#6c7bff" : DECK_COLORS[deck]);
    let value = 0.5, dflt = 0.5, apply;
    if (band === "trim") { value = dflt = 0.67; apply = (v) => engine.decks[deck].setTrim(v); }
    else if (band === "filter") { value = dflt = 0.5; apply = (v) => engine.decks[deck].setFilter(v); }
    else { apply = (v) => { engine.decks[deck].setEQ(band, v); coach?.notify("eq"); }; }
    const kh = attachKnob(el, {
      value, default: dflt,
      indicator: el, // rotate the whole knob so the dot orbits its centre
      onChange: (v) => { apply(v); setArc(v); },
    });
    if (band === "mid") midiTargets["eq" + deck] = (v) => kh.set(v); // MIDI -> EQ mid sweep
    apply(value); setArc(value);
  });

  // Volume faders (vertical, neutral = unity)
  for (const id of ["A", "B"]) {
    const start = 0.85;
    engine.decks[id].setVolume(start);
    const vh = attachFader(document.getElementById(`vol-${id}`), {
      min: 0, max: 1, value: start, default: 1,
      ticks: [0, 0.25, 0.5, 0.75, 1].map((at) => ({ at, major: at === 1 })),
      onChange: (v) => engine.decks[id].setVolume(v),
    });
    midiTargets["vol" + id] = (v) => vh.set(v);
  }

  // Tempo faders (vertical, ±8%, neutral = 0)
  for (const id of ["A", "B"]) {
    const read = document.getElementById(`tempo-${id}-read`);
    const fmt = (v) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)}%`;
    tempoFaders[id] = attachFader(document.getElementById(`tempo-${id}`), {
      min: -8, max: 8, value: 0, default: 0, step: 0.1,
      ticks: [
        { at: 8, label: "+8", major: true }, { at: 4 }, { at: 0, major: true },
        { at: -4 }, { at: -8, label: "−8", major: true },
      ],
      onChange: (v) => { engine.decks[id].setTempo(v); read.textContent = fmt(v); coach?.notify("tempo"); },
    });
    read.textContent = fmt(0);
  }

  // Crossfader (horizontal, neutral = centre)
  const cf = attachFader(document.getElementById("crossfader"), {
    min: 0, max: 1, value: 0.5, default: 0.5,
    ticks: [0, 0.25, 0.5, 0.75, 1].map((at) => ({ at, major: at === 0.5 })),
    onChange: (v) => engine.setCrossfade(v),
  });
  ui.crossfadeSet = cf.set; // let keyboard / gestures move the on-screen fader
  midiTargets.crossfade = (v) => cf.set(v); // and MIDI

  // Master (kept as a compact native slider in the header)
  const master = document.getElementById("master-vol");
  engine.setMasterVolume(parseFloat(master.value));
  master.addEventListener("input", () => engine.setMasterVolume(parseFloat(master.value)));
}

/**
 * Draw a tick scale + value arc into a knob's SVG. Returns setArc(value 0..1)
 * that fills an arc from neutral (12 o'clock) to the current position.
 */
function buildKnobScale(svg, color) {
  const NS = "http://www.w3.org/2000/svg";
  const cx = 50, cy = 50, rTickOuter = 48, rTickInner = 42, rArc = 45;
  const polar = (r, deg) => {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  };
  svg.innerHTML = "";
  // Ticks every 33.75° across the 270° sweep (-135 .. +135).
  for (let i = 0; i <= 8; i++) {
    const deg = -135 + i * 33.75;
    const major = i === 0 || i === 4 || i === 8;
    const [x1, y1] = polar(rTickInner, deg);
    const [x2, y2] = polar(rTickOuter, deg);
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1);
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    line.setAttribute("stroke", major ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.22)");
    line.setAttribute("stroke-width", major ? 2.4 : 1.4);
    line.setAttribute("stroke-linecap", "round");
    svg.append(line);
  }
  const arc = document.createElementNS(NS, "path");
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", color);
  arc.setAttribute("stroke-width", 3);
  arc.setAttribute("stroke-linecap", "round");
  svg.append(arc);

  const describe = (start, end) => {
    const [sx, sy] = polar(rArc, start);
    const [ex, ey] = polar(rArc, end);
    const large = Math.abs(end - start) > 180 ? 1 : 0;
    return `M ${sx} ${sy} A ${rArc} ${rArc} 0 ${large} 1 ${ex} ${ey}`;
  };
  return (value) => {
    const a = (value - 0.5) * 270;
    if (Math.abs(a) < 0.6) arc.setAttribute("d", "");
    else arc.setAttribute("d", a > 0 ? describe(0, a) : describe(a, 0));
  };
}

// ---------- Keyboard (configurable) ----------
function setCrossUI(v) {
  v = Math.max(0, Math.min(1, v));
  engine.setCrossfade(v);
  ui.syncCrossfade(v);
}

function buildActions() {
  const A = engine.decks.A, B = engine.decks.B;
  const cue = (id, slot) => (e) => (e.shiftKey ? clearCue(id, slot) : hitCue(id, slot));
  return {
    playA: () => { A.toggle(); ui.flash("A"); },
    playB: () => { B.toggle(); ui.flash("B"); },
    cueA: () => { A.goToCue(); coach?.notify("cueA"); },
    cueB: () => { B.goToCue(); coach?.notify("cueB"); },
    setCueA: () => { A.setCue(); ui.toast("Cue A set"); coach?.notify("setCueA"); },
    setCueB: () => { B.setCue(); ui.toast("Cue B set"); coach?.notify("setCueB"); },
    crossLeft: () => setCrossUI(engine.crossfade - 0.05),
    crossRight: () => setCrossUI(engine.crossfade + 0.05),
    crossCenter: () => setCrossUI(0.5),
    hotA1: cue("A", 0), hotA2: cue("A", 1), hotA3: cue("A", 2), hotA4: cue("A", 3),
    hotB1: cue("B", 0), hotB2: cue("B", 1), hotB3: cue("B", 2), hotB4: cue("B", 3),
    samp1: () => triggerSample(0), samp2: () => triggerSample(1), samp3: () => triggerSample(2), samp4: () => triggerSample(3),
    samp5: () => triggerSample(4), samp6: () => triggerSample(5), samp7: () => triggerSample(6), samp8: () => triggerSample(7),
    loopA: () => toggleAutoLoop("A"), loopB: () => toggleAutoLoop("B"),
    playBoth: () => playBoth(), syncA: () => syncDeck("A"), syncB: () => syncDeck("B"),
  };
}

let rebindCapture = null; // { type:'keys'|'gestures', name } while listening for a key

function setupKeyboard() {
  rebuildKeyMap();
  const actions = buildActions();

  // Capture phase: when rebinding, the next key press becomes the binding and
  // is swallowed so it can't also trigger an action / arm a deck.
  window.addEventListener("keydown", (e) => {
    if (!rebindCapture) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code !== "Escape") {
      config[rebindCapture.type][rebindCapture.name] = e.code;
      rebuildKeyMap();
      saveConfig();
      if (sampler) renderPads();
    }
    rebindCapture = null;
    renderSettings();
  }, true);

  // Action dispatch (bubble phase).
  window.addEventListener("keydown", (e) => {
    if (rebindCapture) return;
    if (!document.getElementById("settings-dialog").hidden) return; // not while editing
    if (e.target.closest && e.target.closest('input[type="url"], input[type="text"], textarea')) return;
    // Ctrl/Alt/Cmd are reserved for gesture arming/slam; Shift is allowed
    // because it means "clear" for hot cues.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = keyMap[e.code];
    if (!action) return;
    const repeatable = action === "crossLeft" || action === "crossRight";
    if (e.repeat && !repeatable) return;
    actions[action]?.(e);
    if (action.startsWith("cross") || action === "playBoth") e.preventDefault();
  });
}

// ---------- Settings / remapping panel ----------
const KEY_ACTION_GROUPS = [
  ["Transport", [["playA", "Play / pause A"], ["playB", "Play / pause B"], ["cueA", "Cue A (jump)"], ["cueB", "Cue B (jump)"], ["setCueA", "Set cue A"], ["setCueB", "Set cue B"]]],
  ["Crossfader", [["crossLeft", "Nudge toward A"], ["crossRight", "Nudge toward B"], ["crossCenter", "Centre"]]],
  ["Sync & both", [["playBoth", "Play / pause both"], ["syncA", "Sync A → B"], ["syncB", "Sync B → A"]]],
  ["Loops", [["loopA", "Auto-loop Deck A"], ["loopB", "Auto-loop Deck B"]]],
  ["Hot cues — Deck A", [["hotA1", "Cue 1"], ["hotA2", "Cue 2"], ["hotA3", "Cue 3"], ["hotA4", "Cue 4"]]],
  ["Hot cues — Deck B", [["hotB1", "Cue 1"], ["hotB2", "Cue 2"], ["hotB3", "Cue 3"], ["hotB4", "Cue 4"]]],
  ["Sampler pads", [["samp1", "Pad 1"], ["samp2", "Pad 2"], ["samp3", "Pad 3"], ["samp4", "Pad 4"], ["samp5", "Pad 5"], ["samp6", "Pad 6"], ["samp7", "Pad 7"], ["samp8", "Pad 8"]]],
];
const GESTURE_KEYS = [
  ["armA", "Arm Deck A (hold to scratch)"], ["armB", "Arm Deck B (hold to scratch)"],
  ["slamAMod", "Slam to A (with arm A)"], ["slamBMod", "Slam to B (with arm B)"],
];

function fmtKey(code) {
  if (!code) return "—";
  const map = {
    ControlLeft: "L-Ctrl", ControlRight: "R-Ctrl", ShiftLeft: "L-Shift", ShiftRight: "R-Shift",
    AltLeft: "L-Alt", AltRight: "R-Alt", MetaLeft: "L-⌘", MetaRight: "R-⌘",
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "Space", Escape: "Esc",
  };
  if (map[code]) return map[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  return code;
}

function renderSettings() {
  const body = document.getElementById("settings-body");
  body.innerHTML = "";

  const keyBtn = (type, name) => {
    const capturing = rebindCapture && rebindCapture.type === type && rebindCapture.name === name;
    const b = document.createElement("button");
    b.className = "key-btn" + (capturing ? " capturing" : "");
    b.textContent = capturing ? "press a key…" : fmtKey(config[type][name]);
    b.addEventListener("click", () => { rebindCapture = { type, name }; renderSettings(); });
    return b;
  };

  const addRows = (title, rows, type) => {
    const h = document.createElement("div"); h.className = "set-group-title"; h.textContent = title;
    body.append(h);
    for (const [name, label] of rows) {
      const row = document.createElement("div"); row.className = "set-row";
      const l = document.createElement("span"); l.textContent = label;
      row.append(l, keyBtn(type, name));
      body.append(row);
    }
  };

  for (const [title, rows] of KEY_ACTION_GROUPS) addRows(title, rows, "keys");
  addRows("Trackpad arming & slam", GESTURE_KEYS, "gestures");

  const h = document.createElement("div"); h.className = "set-group-title"; h.textContent = "Trackpad feel";
  body.append(h);

  const invRow = document.createElement("label"); invRow.className = "set-row";
  const invL = document.createElement("span"); invL.textContent = "Invert scratch direction";
  const inv = document.createElement("input"); inv.type = "checkbox"; inv.checked = config.gestures.invertScratch;
  inv.addEventListener("change", () => { config.gestures.invertScratch = inv.checked; saveConfig(); });
  invRow.append(invL, inv); body.append(invRow);

  const slider = (label, key, min, max, step) => {
    const row = document.createElement("div"); row.className = "set-row";
    const l = document.createElement("span"); l.textContent = label;
    const r = document.createElement("input"); r.type = "range"; r.min = min; r.max = max; r.step = step;
    r.value = config.gestures[key];
    r.addEventListener("input", () => { config.gestures[key] = parseFloat(r.value); saveConfig(); });
    row.append(l, r); body.append(row);
  };
  slider("Scratch sensitivity", "scratchSensitivity", 0.0006, 0.004, 0.0001);
  slider("Crossfade sensitivity", "crossfadeSensitivity", 0.001, 0.01, 0.0002);

  const opt = (val, txt, sel) => {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = txt;
    if (sel) o.selected = true;
    return o;
  };

  const cfTitle = document.createElement("div"); cfTitle.className = "set-group-title"; cfTitle.textContent = "Crossfader settings";
  body.append(cfTitle);

  // Crossfader Curve Row
  const curveRow = document.createElement("div"); curveRow.className = "set-row";
  const curveL = document.createElement("span"); curveL.textContent = "Crossfader curve";
  const curveS = document.createElement("select");
  curveS.className = "preset-select";
  curveS.style.minHeight = "28px";
  curveS.style.padding = "2px 6px";
  curveS.appendChild(opt("power", "Equal Power", config.gestures.crossfadeCurve === "power"));
  curveS.appendChild(opt("linear", "Linear Blend", config.gestures.crossfadeCurve === "linear"));
  curveS.appendChild(opt("cut", "Sharp Cut (Scratch)", config.gestures.crossfadeCurve === "cut"));
  curveS.addEventListener("change", () => {
    config.gestures.crossfadeCurve = curveS.value;
    engine.crossfadeCurve = curveS.value;
    engine.setCrossfade(engine.crossfade); // re-apply
    saveConfig();
  });
  curveRow.append(curveL, curveS);
  body.append(curveRow);

  // Hamster Switch Row
  const hamRow = document.createElement("label"); hamRow.className = "set-row";
  const hamL = document.createElement("span"); hamL.textContent = "Hamster mode (Reverse crossfader)";
  const ham = document.createElement("input"); ham.type = "checkbox"; ham.checked = config.gestures.hamsterMode;
  ham.addEventListener("change", () => {
    config.gestures.hamsterMode = ham.checked;
    engine.hamster = ham.checked;
    engine.setCrossfade(engine.crossfade); // re-apply
    saveConfig();
  });
  hamRow.append(hamL, ham);
  body.append(hamRow);

  renderMidiHapticsSettings(body);
}

function renderMidiHapticsSettings(body) {
  const title = document.createElement("div");
  title.className = "set-group-title";
  title.textContent = "MIDI & Haptics";
  body.append(title);

  // Haptics toggle
  const hRow = document.createElement("label"); hRow.className = "set-row";
  const hL = document.createElement("span");
  hL.textContent = hapticsSupported() ? "Haptic feedback (vibration)" : "Haptic feedback (unsupported here)";
  const hCb = document.createElement("input"); hCb.type = "checkbox";
  hCb.checked = config.haptics; hCb.disabled = !hapticsSupported();
  hCb.addEventListener("change", () => { config.haptics = hCb.checked; setHapticsEnabled(hCb.checked); saveConfig(); });
  hRow.append(hL, hCb); body.append(hRow);

  // MIDI enable toggle
  const mRow = document.createElement("label"); mRow.className = "set-row";
  const mL = document.createElement("span"); mL.textContent = "Enable MIDI controller";
  const mCb = document.createElement("input"); mCb.type = "checkbox";
  mCb.checked = config.midi.enabled; mCb.disabled = !(midi && midi.supported());
  mCb.addEventListener("change", async () => {
    config.midi.enabled = mCb.checked; saveConfig();
    if (mCb.checked && midi) await midi.enable();
    renderSettings();
  });
  mRow.append(mL, mCb); body.append(mRow);

  // Status line
  const status = document.createElement("div"); status.className = "hint"; status.id = "midi-status";
  status.textContent = midiStatusText({ supported: !!(midi && midi.supported()), enabled: config.midi.enabled, devices: midi ? midi.devices : [] });
  body.append(status);

  // Learn rows for the mappable continuous controls
  const LEARNABLE = [
    ["crossfade", "Crossfader"], ["volA", "Deck A volume"], ["volB", "Deck B volume"],
    ["eqA", "Deck A EQ (mid)"], ["eqB", "Deck B EQ (mid)"], ["jogA", "Deck A jog/scratch"], ["jogB", "Deck B jog/scratch"],
  ];
  for (const [action, label] of LEARNABLE) {
    const row = document.createElement("div"); row.className = "set-row";
    const l = document.createElement("span");
    const cc = config.midi.map[action]?.cc;
    l.textContent = `${label} — CC ${cc ?? "—"}`;
    const b = document.createElement("button");
    b.className = "key-btn" + (midiLearn === action ? " capturing" : "");
    b.textContent = midiLearn === action ? "move a control…" : "Learn";
    b.addEventListener("click", () => { midiLearn = midiLearn === action ? null : action; renderSettings(); });
    row.append(l, b); body.append(row);
  }
}

function setupSettings() {
  const dialog = document.getElementById("settings-dialog");
  const close = () => { rebindCapture = null; dialog.hidden = true; };
  document.getElementById("settings-btn").addEventListener("click", () => { rebindCapture = null; renderSettings(); dialog.hidden = false; });
  document.getElementById("settings-close").addEventListener("click", close);
  document.getElementById("settings-reset").addEventListener("click", () => {
    Object.assign(config.keys, DEFAULT_KEYS);
    Object.assign(config.gestures, DEFAULT_GESTURES);
    rebuildKeyMap(); saveConfig();
    engine.crossfadeCurve = config.gestures.crossfadeCurve ?? "power";
    engine.hamster = config.gestures.hamsterMode ?? false;
    engine.setCrossfade(engine.crossfade);
    renderSettings();
    if (sampler) renderPads();
    ui.toast("Controls reset to defaults");
  });
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
}

// ---------- Web MIDI controllers ----------
function setupMidi() {
  setHapticsEnabled(config.haptics);
  midi = new MidiInput();
  midi.onStatus = (info) => {
    const el = document.getElementById("midi-status");
    if (el) el.textContent = midiStatusText(info);
  };
  midi.onControl = (cc, value) => handleMidiCC(cc, value);
  midi.onNote = (note, vel, ch, on) => handleMidiNote(note, on);
  if (config.midi.enabled && midi.supported()) midi.enable();
}

function midiStatusText(info) {
  if (!info.supported) return "Web MIDI not supported in this browser";
  if (!info.enabled) return "MIDI off";
  return info.devices.length ? `Connected: ${info.devices.join(", ")}` : "No MIDI device detected";
}

function handleMidiCC(cc, value) {
  // MIDI Learn: bind the next incoming CC to the pending action.
  if (midiLearn) {
    config.midi.map[midiLearn] = { cc };
    midiLearn = null;
    saveConfig();
    if (!document.getElementById("settings-dialog").hidden) renderSettings();
    ui.toast(`Mapped CC ${cc}`);
    return;
  }
  const map = config.midi.map;
  for (const action of ["crossfade", "volA", "volB", "eqA", "eqB"]) {
    if (map[action] && map[action].cc === cc) { midiTargets[action]?.(value); return; }
  }
  if (map.jogA && map.jogA.cc === cc) return midiJog("A", value);
  if (map.jogB && map.jogB.cc === cc) return midiJog("B", value);
}

// A relative jog wheel sends 1..63 forward / 65..127 backward; treat each
// message as a momentary scratch nudge that releases after a short idle.
function midiJog(deck, value01) {
  const raw = Math.round(value01 * 127);
  const signed = raw === 0 ? 0 : raw < 64 ? raw : raw - 128;
  const d = engine.decks[deck], st = midiJogState[deck];
  if (!st.active) { d.touchStart(); st.active = true; }
  d.jog(signed * 0.3);
  clearTimeout(st.timer);
  st.timer = setTimeout(() => { d.touchEnd(); st.active = false; }, 100);
}

function handleMidiNote(note, on) {
  if (!on) return;
  // Notes 36..43 -> sampler pads 1..8 (the common finger-drum / pad range).
  if (note >= 36 && note <= 43) triggerSample(note - 36);
}

// ---------- Practice mode ----------
function loadPracticeBeat(deck, bpm) {
  const buf = makeBeat(engine.ctx, bpm, 24);
  applyLoaded(deck, buf, `practice • ${bpm} BPM`);
  engine.decks[deck].bpm = bpm; // so auto-loop is beat-accurate
  return buf;
}

// ---------- Loops + Beat FX ----------
function toggleAutoLoop(deck) {
  const d = engine.decks[deck];
  if (d.loop && d.loop.active) d.loopExit();
  else d.autoLoop(4);
}

function setupLoopsFx() {
  const onDeck = (sel, fn) =>
    document.querySelectorAll(sel).forEach((b) => b.addEventListener("click", () => fn(engine.decks[b.dataset.deck], b.dataset.deck)));
  onDeck(".loop-auto", (_, id) => toggleAutoLoop(id));
  onDeck(".loop-in", (d) => d.loopIn());
  onDeck(".loop-out", (d) => d.loopOut());
  onDeck(".loop-half", (d) => d.loopHalve());
  onDeck(".loop-double", (d) => d.loopDouble());
  onDeck(".loop-exit", (d) => d.loopExit());

  // Loop to sampler pad mapping setup
  document.querySelectorAll(".loop-to-pad").forEach((btn) => {
    const deckId = btn.dataset.deck;
    btn.addEventListener("click", () => {
      const d = engine.decks[deckId];
      if (!d.buffer) {
        ui.toast("Load a track first!");
        return;
      }
      if (d.loop.start < 0 || d.loop.end <= d.loop.start) {
        ui.toast("Set Loop IN and Loop OUT first to define a region.");
        return;
      }

      // Toggle mapping mode
      if (mappingSource && mappingSource.deckId === deckId) {
        cancelMappingMode();
      } else {
        enterMappingMode(deckId, d.loop.start, d.loop.end, btn);
      }
    });
  });

  // Brake = momentary (hold). Spin = one-shot.
  document.querySelectorAll(".fx-brake").forEach((b) => {
    const d = engine.decks[b.dataset.deck];
    const on = (e) => { e.preventDefault(); d.brake(true); b.classList.add("held"); };
    const off = () => { d.brake(false); b.classList.remove("held"); };
    b.addEventListener("pointerdown", on);
    b.addEventListener("pointerup", off);
    b.addEventListener("pointerleave", off);
    b.addEventListener("pointercancel", off);
  });
  document.querySelectorAll(".fx-spin").forEach((b) =>
    b.addEventListener("click", () => engine.decks[b.dataset.deck].backspin())
  );

  // Independent Beat FX per deck
  document.querySelectorAll(".fx-btn").forEach((b) => {
    const deck = b.dataset.deck;
    b.addEventListener("click", () => {
      const d = engine.decks[deck];
      d.fx.select(b.dataset.fx);
      document.querySelectorAll(`.fx-btn[data-deck="${deck}"]`).forEach((x) => x.classList.toggle("active", x === b));
    });
  });

  document.querySelectorAll(".fx-depth-slider").forEach((slider) => {
    const deck = slider.dataset.deck;
    const d = engine.decks[deck];
    d.fx.setDepth(parseFloat(slider.value));
    slider.addEventListener("input", () => d.fx.setDepth(parseFloat(slider.value)));
  });

  document.querySelectorAll(".fx-on").forEach((btn) => {
    const deck = btn.dataset.deck;
    const d = engine.decks[deck];
    btn.addEventListener("click", () => {
      d.fx.setOn(!d.fx.on);
      btn.classList.toggle("active", d.fx.on);
    });
  });
}

// Tap the final mix into a MediaRecorder so a routine can be played back / saved.
function makeRecorder() {
  if (!window.MediaRecorder) return null;
  const dest = engine.ctx.createMediaStreamDestination();
  engine.limiter.connect(dest);
  let rec = null, chunks = [];
  return {
    start() {
      chunks = [];
      try { rec = new MediaRecorder(dest.stream); } catch { rec = null; return; }
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.start();
    },
    stop(cb) {
      if (!rec || rec.state === "inactive") { cb?.(null); return; }
      rec.onstop = () => cb?.(URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || "audio/webm" })));
      try { rec.stop(); } catch { cb?.(null); }
    },
  };
}

function setupPractice() {
  coach = new PracticeCoach({ engine, ui, loadBeat: loadPracticeBeat });
  coach.recorder = makeRecorder();
  engine.onJog = (id, rate) => coach.onJog(id, rate);
  engine.onCrossfade = (v) => coach.onCrossfade(v);

  const dialog = document.getElementById("practice-dialog");
  const list = document.getElementById("practice-list");
  const cats = [];
  for (const l of LESSONS) {
    let grp = cats.find((c) => c.cat === l.cat);
    if (!grp) { grp = { cat: l.cat, items: [] }; cats.push(grp); }
    grp.items.push(l);
  }
  list.innerHTML = "";
  // Freestyle (scored) sits at the top.
  const fcat = document.createElement("div"); fcat.className = "practice-cat"; fcat.textContent = "Freestyle";
  list.append(fcat);
  const fbtn = document.createElement("button");
  fbtn.className = "lesson-btn freestyle-btn";
  fbtn.innerHTML = `<span class="lesson-title">🔥 Freestyle — 30 seconds</span><span class="lesson-blurb">Go off on both decks; get scored, ranked and coached.</span>`;
  fbtn.addEventListener("click", () => { dialog.hidden = true; coach.startFreestyle(); });
  list.append(fbtn);

  for (const grp of cats) {
    const h = document.createElement("div"); h.className = "practice-cat"; h.textContent = grp.cat;
    list.append(h);
    for (const l of grp.items) {
      const b = document.createElement("button");
      b.className = "lesson-btn";
      b.innerHTML = `<span class="lesson-title">${l.title}</span><span class="lesson-blurb">${l.blurb}</span>`;
      b.addEventListener("click", () => { dialog.hidden = true; coach.start(l.id); });
      list.append(b);
    }
  }
  document.getElementById("practice-btn").addEventListener("click", () => (dialog.hidden = false));
  document.getElementById("practice-close").addEventListener("click", () => (dialog.hidden = true));
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.hidden = true; });
}

// ---------- SXRATCH / PAD navigation ----------
let studioReady = false;
function showView(view) {
  const studio = view === "studio";
  document.body.classList.toggle("view-studio", studio);
  document.getElementById("nav-decks").classList.toggle("active", !studio);
  document.getElementById("nav-studio").classList.toggle("active", studio);
  if (studio) {
    if (!studioReady) {
      studioReady = true;
      SongBuilder.init({
        getCtx: () => engine.ctx,
        toast: (m) => ui.toast(m),
        onUse: (buf, label, deck) => { applyLoaded(deck, buf, label); showView("decks"); },
        getSampler: () => sampler,
      });
    }
  } else {
    SongBuilder.stopPreview();
  }
}
function setupNav() {
  document.getElementById("nav-decks").addEventListener("click", () => showView("decks"));
  document.getElementById("nav-studio").addEventListener("click", () => showView("studio"));
}

// ---------- Dialogs ----------
function setupDialogs() {
  const help = document.getElementById("help-dialog");
  document.getElementById("help-btn").addEventListener("click", () => (help.hidden = false));
  document.getElementById("help-close").addEventListener("click", () => (help.hidden = true));
  [help, document.getElementById("url-dialog")].forEach((d) =>
    d.addEventListener("click", (e) => { if (e.target === d) d.hidden = true; })
  );
}

// ---------- Waveform zoom + stacked beat-match view ----------
function setupWaveTools() {
  document.querySelectorAll(".zoom-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const wave = ui.waves[btn.dataset.deck];
      wave.zoomBy(btn.dataset.dir === "in" ? 1.5 : 1 / 1.5);
    });
  });
  const stackBtn = document.getElementById("stack-btn");
  stackBtn.addEventListener("click", () => {
    const on = document.body.classList.toggle("stack-view");
    stackBtn.classList.toggle("active", on);
    ui.waves.A?.resize();
    ui.waves.B?.resize();
  });
}

// ---------- Hot cues ----------
function setupHotcues() {
  for (const id of ["A", "B"]) {
    const wrap = document.querySelector(`.hotcues[data-deck="${id}"]`);
    wrap.innerHTML = "";
    for (let i = 0; i < 4; i++) {
      const chip = document.createElement("button");
      chip.className = "hotcue-chip";
      chip.dataset.deck = id;
      chip.dataset.slot = String(i);
      chip.textContent = id === "A" ? String(i + 1) : String(i + 6);
      chip.title = "Click: set / jump · Shift-click: clear";
      chip.addEventListener("click", (e) => {
        if (e.shiftKey) clearCue(id, i);
        else hitCue(id, i);
      });
      wrap.appendChild(chip);
    }
    renderHot(id);
  }
}

/** Set a cue if the slot is empty, otherwise jump to it. */
function hitCue(id, slot) {
  if (hot[id][slot] == null) setCueSlot(id, slot, engine.decks[id].position);
  else engine.decks[id].seek(hot[id][slot]);
  coach?.notify("hotcue");
}

function setCueSlot(id, slot, pos) {
  if (!engine.decks[id].duration) return;
  hot[id][slot] = pos;
  renderHot(id);
  haptic(12);
  ui.toast(`Deck ${id}: cue ${id === "A" ? slot + 1 : slot + 6} set`);
}

function clearCue(id, slot) {
  hot[id][slot] = null;
  renderHot(id);
}

function renderHot(id) {
  const cues = [];
  hot[id].forEach((p, i) => {
    if (p != null) cues.push({ pos: p, color: CUE_COLORS[i], label: i + 1 });
  });
  ui.waves[id]?.setCues(cues);
  document.querySelectorAll(`.hotcue-chip[data-deck="${id}"]`).forEach((chip) => {
    const slot = Number(chip.dataset.slot);
    const set = hot[id][slot] != null;
    chip.classList.toggle("set", set);
    chip.style.background = set ? CUE_COLORS[slot] : "";
  });
}

// ---------- Animation loop: VU meters + platter rotation ----------
function frameLoop() {
  const now = performance.now();
  if (coach) coach.update();
  if (bothBtn) bothBtn.classList.toggle("playing", engine.decks.A.playing && engine.decks.B.playing);

  for (const id of ["A", "B"]) {
    // VU
    const a = analysers[id];
    if (a) {
      a.node.getFloatTimeDomainData(a.buf);
      let sum = 0;
      for (let i = 0; i < a.buf.length; i++) sum += a.buf[i] * a.buf[i];
      const rms = Math.sqrt(sum / a.buf.length);
      a.el.style.setProperty("--level", Math.min(100, rms * 180) + "%");
    }

    // Platter rotation — extrapolate the playhead since the last position post
    // so the disc spins smoothly (and reverses while scratching).
    const deck = engine.decks[id];
    const r = rot[id];
    if (deck.duration > 0) {
      let dt = (now - r.t) / 1000;
      if (dt > 0.25) dt = 0; // tab was backgrounded; don't lurch
      const est = Math.max(0, Math.min(1, r.pos + (r.rate / deck.duration) * dt));
      const seconds = est * deck.duration;
      discs[id].style.transform = `rotate(${seconds * DEG_PER_SEC}deg)`;
      // Scroll the waveform off the same extrapolated playhead so it tracks the
      // platter at full frame rate (the worklet only posts position ~25/s).
      ui.waves[id]?.setPosition(est);
    } else {
      discs[id].style.transform = "rotate(0deg)";
    }

    // Flush any pending waveform redraw (cues/loops/scroll) once per frame.
    ui.waves[id]?.renderIfDirty();

    // Update split real-time FFT visualizer per deck
    drawDeckVisualizer(id);
  }
  requestAnimationFrame(frameLoop);
}

function drawDeckVisualizer(id) {
  const canvas = document.getElementById(`viz-${id}`);
  if (!canvas || !engine.ready) return;
  const d = engine.decks[id];
  if (!d || !d.analyser) return;

  // Reuse the canvas context + frequency buffer across frames (allocating a
  // fresh Uint8Array every frame, x2 decks x60fps, was steady GC pressure).
  let v = vizCache[id];
  if (!v || v.canvas !== canvas) {
    v = vizCache[id] = { canvas, ctx: canvas.getContext("2d"), buf: new Uint8Array(d.analyser.frequencyBinCount) };
  }
  const ctx = v.ctx;
  const dataArray = v.buf;
  d.analyser.getByteFrequencyData(dataArray);

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width;
  const h = canvas.height;
  const midX = w / 2;

  // Symmetrical frequency bars growing outward from the center
  const barCount = 16;
  const barGap = 2;
  const totalBarWidth = (w / 2) / barCount;
  const barWidth = totalBarWidth - barGap;

  for (let i = 0; i < barCount; i++) {
    const val = dataArray[i]; // 0..255
    const percent = val / 255;
    const barHeight = Math.max(2, percent * h * 0.9);

    // Color gradient based on side: Deck A is cyan, Deck B is pink
    const baseHue = id === "A" ? 170 : 325;
    const hue = baseHue + (i / barCount) * 20;
    ctx.fillStyle = `hsla(${hue}, 90%, 65%, 0.85)`;

    // Draw left half (moving left from center)
    const lx = midX - (i * totalBarWidth) - totalBarWidth;
    ctx.fillRect(lx, h - barHeight, barWidth, barHeight);

    // Draw right half (moving right from center)
    const rx = midX + (i * totalBarWidth);
    ctx.fillRect(rx, h - barHeight, barWidth, barHeight);
  }
}

function enterMappingMode(deckId, start, end, btn) {
  cancelMappingMode(); // cancel any active mapping first
  
  mappingSource = { deckId, start, end };
  btn.classList.add("active");
  
  // Highlight all sampler pads to indicate they are targets
  document.querySelectorAll(".samp-pad").forEach((pad) => {
    pad.classList.add("mappable");
  });
  
  ui.toast(`Tap any Sampler Pad (1-8) to map Deck ${deckId} loop region...`);
}

function cancelMappingMode() {
  mappingSource = null;
  document.querySelectorAll(".loop-to-pad").forEach((btn) => btn.classList.remove("active"));
  document.querySelectorAll(".samp-pad").forEach((pad) => pad.classList.remove("mappable"));
}

function mapRegionToPad(deckId, start, end, slotIndex) {
  const d = engine.decks[deckId];
  if (!d || !d.buffer) return;

  try {
    const slicedBuffer = extractAudioRegion(engine.ctx, d.buffer, start, end);
    const sliceName = `${d.name || "Track"} [Slice]`;
    sampler.setBuffer(slotIndex, slicedBuffer, sliceName);
    renderPad(slotIndex);
    ui.toast(`Mapped Deck ${deckId} region to Pad ${slotIndex + 1}!`);
  } catch (err) {
    console.error(err);
    ui.toast("Failed to extract loop region");
  }
}

function extractAudioRegion(ctx, sourceBuffer, startFraction, endFraction) {
  const sampleRate = sourceBuffer.sampleRate;
  const numChannels = sourceBuffer.numberOfChannels;
  const len = sourceBuffer.length;
  
  // Calculate sample indices from normalized fractions (0..1)
  const start = Math.max(0, Math.min(len - 1, Math.round(startFraction * len)));
  const end = Math.max(start + 1, Math.min(len, Math.round(endFraction * len)));
  const newLength = end - start;
  
  // Create a new AudioBuffer
  const newBuffer = ctx.createBuffer(numChannels, newLength, sampleRate);
  
  // Copy channel data
  for (let c = 0; c < numChannels; c++) {
    const srcData = sourceBuffer.getChannelData(c);
    const destData = newBuffer.getChannelData(c);
    destData.set(srcData.subarray(start, end));
  }
  
  return newBuffer;
}
