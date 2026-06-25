// Sxratch Practice Mode — interactive, guided tutorials that teach real DJ /
// turntablist technique. Each lesson is a sequence of steps; a step instructs the
// user, highlights the control to use, and either auto-detects when the objective
// is met (via engine instrumentation) or waits for a "Got it" tap.
//
// Technique + history sourced from turntablism literature (Grand Wizzard Theodore,
// Grandmaster Flash, GrandMixer DXT, DJ QBert) — see README for references.

/** Synthesize a simple drum loop into an AudioBuffer so users can practice
 *  immediately without uploading anything. */
export function makeBeat(ctx, bpm = 100, bars = 24) {
  const sr = ctx.sampleRate;
  const beat = 60 / bpm;
  const total = Math.ceil(beat * 4 * bars * sr) + sr;
  const buf = ctx.createBuffer(2, total, sr);
  const L = buf.getChannelData(0);
  const add = (t, dur, fn) => {
    const start = Math.floor(t * sr), n = Math.floor(dur * sr);
    for (let i = 0; i < n && start + i < total; i++) L[start + i] += fn(i / sr, i / n);
  };
  const kick = (t) => add(t, 0.28, (x) => Math.sin(2 * Math.PI * (40 + 110 * Math.exp(-x * 32)) * x) * Math.exp(-x * 7) * 0.95);
  const snare = (t) => add(t, 0.2, (x) => ((Math.random() * 2 - 1) * 0.7 + Math.sin(2 * Math.PI * 190 * x) * 0.3) * Math.exp(-x * 20) * 0.7);
  const hat = (t) => add(t, 0.05, (x) => (Math.random() * 2 - 1) * Math.exp(-x * 55) * 0.22);
  for (let b = 0; b < bars * 4; b++) {
    const t = b * beat;
    kick(t);
    if (b % 4 === 1 || b % 4 === 3) snare(t);
    hat(t); hat(t + beat / 2);
  }
  const R = buf.getChannelData(1);
  for (let i = 0; i < total; i++) { L[i] = Math.tanh(L[i] * 1.2); R[i] = L[i]; }
  return buf;
}

// Convenience builders for step objectives.
const both = (c) => c.playing("A") && c.playing("B");

export const LESSONS = [
  // ---------------- FOUNDATIONS ----------------
  {
    id: "f1", cat: "Foundations", title: "Decks & the platter",
    blurb: "Get a track running and feel how the platter grabs the record.",
    steps: [
      { text: "Welcome to the booth. I've loaded a practice beat on Deck A. Hit PLAY to start it.",
        onEnter: (c) => c.ensureBeat("A", 100), highlight: "#play-A",
        check: (c) => c.playing("A") },
      { text: "Nice. Press it again to pause — a DJ is always starting and stopping.",
        highlight: "#play-A", check: (c) => !c.playing("A") },
      { text: "Now hold RIGHT Ctrl and move ONE finger up/down on Deck A. Holding Ctrl 'grabs' the record — exactly what Grand Wizzard Theodore did when he invented scratching in 1975. Give it a few nudges.",
        highlight: "#pad-A", target: 4, progress: (c) => c.scratch.A, check: (c) => c.scratch.A >= 4 },
      { text: "That hand-on-the-record control is the root of everything here. On to cue points.",
        manual: true },
    ],
  },
  {
    id: "f2", cat: "Foundations", title: "Cue points",
    blurb: "Mark a spot and snap back to it — the basis of tight mixing.",
    steps: [
      { text: "A cue point is a bookmark you can jump back to. Drag the Deck A waveform to a spot you like, then press SET.",
        onEnter: (c) => c.ensureBeat("A", 100), highlight: '.set-btn[data-deck="A"]',
        check: (c) => c.flags.setCueA },
      { text: "Now press CUE to jump straight back to it. DJs drop cues on 'the one' — the first beat of a phrase.",
        highlight: '.cue-btn[data-deck="A"]', check: (c) => c.flags.cueA },
      { text: "You can also drop up to four HOT CUES per deck (keys 1–4). Tap a hot-cue chip or key to set one.",
        highlight: '.hotcues[data-deck="A"]', check: (c) => c.flags.hotcue },
      { text: "Cue points let you re-trigger any moment instantly — essential for beat-juggling and tight transitions.",
        manual: true },
    ],
  },

  // ---------------- BEATMATCHING ----------------
  {
    id: "b1", cat: "Beatmatching", title: "Match the tempo",
    blurb: "Make two tracks run at the same speed — the DJ's core skill.",
    steps: [
      { text: "Two beats are loaded: Deck A at 100 BPM, Deck B a little faster. Play BOTH decks and listen to them fight.",
        onEnter: (c) => { c.ensureBeat("A", 100); c.ensureBeat("B", 108); }, highlight: "#play-A,#play-B",
        check: both },
      { text: "Now ride Deck B's TEMPO fader DOWN until its beat locks onto Deck A. Listen for the two kicks to become one.",
        highlight: "#tempo-B", progress: (c) => `${c.effBpm("B").toFixed(1)} BPM`,
        check: (c) => Math.abs(c.effBpm("B") - 100) < 0.8 },
      { text: "Locked! That's beatmatching. The golden rule: tiny adjustments, and never 'chase' the beat — ease into it.",
        manual: true },
    ],
  },
  {
    id: "b2", cat: "Beatmatching", title: "Nudge to align",
    blurb: "Even matched tempos drift — pull them back by hand.",
    steps: [
      { text: "Matched tempos still slip out of phase. Hold the arm key and give Deck B a gentle one-finger NUDGE to slide its beat back in line.",
        onEnter: (c) => { c.ensureBeat("A", 100); c.ensureBeat("B", 100); }, highlight: "#pad-B",
        target: 3, progress: (c) => c.scratch.B, check: (c) => c.scratch.B >= 3 },
      { text: "That push/pull is how vinyl DJs keep two records glued together all night. Forward nudge speeds up, back nudge slows down.",
        manual: true },
    ],
  },

  // ---------------- TIMING ----------------
  {
    id: "t1", cat: "Timing", title: "On-beat scratch",
    blurb: "Scratch in time — a metronome scores every hit.",
    steps: [
      { text: "A metronome is clicking at 100 BPM — watch the pulsing dot below. Hold RIGHT Ctrl and scratch Deck A so each stroke lands ON the click. Land 6 on the beat.",
        onEnter: (c) => { c.ensureBeat("A", 100); c.setCross(0); c.startTiming(100, 6); }, highlight: "#pad-A",
        progress: (c) => (c.tm ? `${c.tm.good} / ${c.tm.target} on beat` : ""), check: (c) => c.tm && c.tm.good >= c.tm.target },
      { text: "Timing is everything: a scratch on the beat sounds musical, off the beat sounds like noise. Drill with the metronome until it's automatic.",
        manual: true },
    ],
  },
  {
    id: "t2", cat: "Timing", title: "On-beat cuts",
    blurb: "Chop the crossfader in time with the click.",
    steps: [
      { text: "Deck A is playing over the metronome. Cut the CROSSFADER toward B and back on each click — clean, rhythmic chops. Land 6 cuts on the beat.",
        onEnter: (c) => { c.ensureBeat("A", 100); c.engine.decks.A.play(); c.setCross(0); c.startTiming(100, 6); }, highlight: "#crossfader",
        progress: (c) => (c.tm ? `${c.tm.good} / ${c.tm.target} on beat` : ""), check: (c) => c.tm && c.tm.good >= c.tm.target },
      { text: "Rhythmic fader cuts are the backbone of transformers and flares. Lock them to the grid and your scratches will groove.",
        manual: true },
    ],
  },

  // ---------------- MIXING ----------------
  {
    id: "m1", cat: "Mixing", title: "The crossfade blend",
    blurb: "Carry the crowd from one track to the next.",
    steps: [
      { text: "Both beats are playing with the crossfader on A. Slowly sweep the crossfader ALL the way across to B.",
        onEnter: (c) => { c.ensureBeat("A", 100); c.ensureBeat("B", 100); c.setCross(0); }, highlight: "#crossfader",
        check: (c) => c.xfMin < 0.12 && c.xfMax > 0.88 },
      { text: "That's the simplest transition. Pros do it on a phrase boundary (every 16 or 32 bars) so it lands musically.",
        manual: true },
    ],
  },
  {
    id: "m2", cat: "Mixing", title: "EQ bass swap",
    blurb: "Hand the bassline from one track to the other — cleanly.",
    steps: [
      { text: "Two basslines at once = mud. First CUT the bass on Deck B: drag its LO knob right down.",
        onEnter: (c) => { c.ensureBeat("A", 100); c.ensureBeat("B", 100); c.setCross(0.5); }, highlight: '.knob[data-deck="B"][data-band="low"]',
        check: (c) => c.lowDb("B") < -12 },
      { text: "Now SWAP: bring Deck B's LO back up while cutting Deck A's LO. The low end hands over without ever doubling up.",
        highlight: '.knob[data-deck="B"][data-band="low"],.knob[data-deck="A"][data-band="low"]',
        check: (c) => c.lowDb("B") > -4 && c.lowDb("A") < -12 },
      { text: "Bass swapping with EQ is the secret to mixes that sound clean instead of cluttered.",
        manual: true },
    ],
  },

  // ---------------- SCRATCHING ----------------
  {
    id: "s1", cat: "Scratching", title: "Baby scratch",
    blurb: "The first scratch every turntablist learns.",
    steps: [
      { text: "The BABY SCRATCH is the foundation of all scratching. Hold RIGHT Ctrl and move one finger up & down on Deck A in steady back-and-forth strokes. Do 8.",
        onEnter: (c) => c.ensureBeat("A", 100), highlight: "#pad-A",
        target: 8, progress: (c) => c.scratch.A, check: (c) => c.scratch.A >= 8 },
      { text: "That's it — the same move Theodore stumbled onto as a teenager. Keep your wrist loose and the rhythm even; everything else is built on this.",
        manual: true },
    ],
  },
  {
    id: "s2", cat: "Scratching", title: "Forward / cut scratch",
    blurb: "Let only the forward push be heard.",
    steps: [
      { text: "A FORWARD scratch hides the back-stroke. Push the record forward, then use the CROSSFADER to cut the sound as you pull back. Try combining a few scratches with fader cuts.",
        onEnter: (c) => c.ensureBeat("A", 100), highlight: "#pad-A,#crossfader",
        progress: (c) => `${c.scratch.A} scratch · ${c.xfReversals} cut`,
        check: (c) => c.scratch.A >= 4 && c.xfReversals >= 3 },
      { text: "This 'cutting' is what Grandmaster Flash perfected — clean, rhythmic stabs of sound, no backward noise.",
        manual: true },
    ],
  },
  {
    id: "s3", cat: "Scratching", title: "The tear",
    blurb: "Break one stroke into several.",
    steps: [
      { text: "A TEAR splits a single stroke into pieces: move the record, briefly STOP, then keep going — fader stays open. Work through a bunch of stop-start strokes.",
        onEnter: (c) => c.ensureBeat("A", 100), highlight: "#pad-A",
        target: 10, progress: (c) => c.scratch.A, check: (c) => c.scratch.A >= 10 },
      { text: "The little stutter is the tear. It's your first taste of turning one sound into a rhythm of its own.",
        manual: true },
    ],
  },
  {
    id: "s4", cat: "Scratching", title: "The transformer",
    blurb: "Chop a sound into a wah-wah.",
    steps: [
      { text: "The TRANSFORMER chops a moving sound by flicking the fader open/closed — that 80s 'wah-wah'. Slowly move the record on Deck A while rapidly flicking the CROSSFADER back and forth.",
        onEnter: (c) => c.ensureBeat("A", 100), highlight: "#crossfader,#pad-A",
        target: 6, progress: (c) => `${c.xfReversals} cuts`, check: (c) => c.xfReversals >= 6 },
      { text: "Named after the robots' morph sound, the transformer was a defining move of mid-80s battle DJs.",
        manual: true },
    ],
  },
  {
    id: "s5", cat: "Scratching", title: "The flare",
    blurb: "Machine-gun clicks — the modern scratch.",
    steps: [
      { text: "The FLARE inserts quick fader 'clicks' INTO a scratch. Keep the record moving and snap the crossfader closed-and-back a couple of times mid-stroke (a '1-click' / '2-click' flare).",
        onEnter: (c) => c.ensureBeat("A", 100), highlight: "#crossfader,#pad-A",
        progress: (c) => `${c.scratch.A} scratch · ${c.xfReversals} click`,
        check: (c) => c.scratch.A >= 4 && c.xfReversals >= 4 },
      { text: "The flare (DJ Flare, made famous by DJ QBert) unlocked the fast, clicky modern style. Its turbo-charged cousin is the CRAB — tapping the fader with each finger against the thumb. That's your next mountain to climb.",
        manual: true },
    ],
  },

  {
    id: "s6", cat: "Scratching", title: "Scribble & chirp",
    blurb: "Speed and fader-coordination drills.",
    steps: [
      { text: "The SCRIBBLE is a super-fast baby scratch — tense your forearm and vibrate the record in tiny, rapid strokes (fader open). Go as fast as you can!",
        onEnter: (c) => c.ensureBeat("A", 100), highlight: "#pad-A",
        progress: (c) => `${c.scratchRate("A", 2)} / 8 fast`, check: (c) => c.scratchRate("A", 2) >= 8 },
      { text: "The CHIRP coordinates the fader with the scratch: cut the sound at the START and END of a push so it 'chirps' like a bird. Combine record pushes with quick crossfader cuts.",
        highlight: "#pad-A,#crossfader",
        progress: (c) => `${c.scratch.A} scratch · ${c.xfReversals} cut`, check: (c) => c.scratch.A >= 4 && c.xfReversals >= 4 },
      { text: "Scribbles bring blistering speed; chirps bring rhythm and melody. Both are staples of any battle routine.",
        manual: true },
    ],
  },

  // ---------------- BEAT JUGGLING ----------------
  {
    id: "bj", cat: "Beat juggling", title: "Beat juggling",
    blurb: "Rebuild a break live across two decks.",
    steps: [
      { text: "Beat juggling rearranges a break in real time using two copies of it. I've loaded the SAME beat on both decks. Drop a cue at the same spot on each — press SET on Deck A, then Deck B.",
        onEnter: (c) => { c.ensureBeat("A", 100); c.ensureBeat("B", 100); c.setCross(0); },
        highlight: '.set-btn[data-deck="A"],.set-btn[data-deck="B"]',
        check: (c) => c.flags.setCueA && c.flags.setCueB },
      { text: "Now juggle: bounce the crossfader between A and B while tapping each deck's CUE to re-trigger the bar — you're rebuilding the beat by hand. Bounce a few times, hitting BOTH cues.",
        highlight: '#crossfader,.cue-btn[data-deck="A"],.cue-btn[data-deck="B"]',
        progress: (c) => `${c.xfReversals} bounce`, check: (c) => c.xfReversals >= 4 && c.flags.cueA && c.flags.cueB },
      { text: "That's beat juggling — pioneered by Steve Dee and the X-Men (later the X-Ecutioners) in the early '90s. Whole new patterns, built by hand from one break.",
        manual: true },
    ],
  },

  // ---------------- CULTURE ----------------
  {
    id: "c1", cat: "Culture", title: "Where it all began",
    blurb: "A two-minute tour through turntablism's roots.",
    steps: [
      { text: "🎧 1970s, the Bronx. DJ Kool Herc notices dancers go off during a record's drum 'break', so he loops it across two copies — the breakbeat is born, and with it hip-hop.", manual: true },
      { text: "✋ 1975. A 12-year-old Theodore Livingston (Grand Wizzard Theodore) holds a record still under the needle and hears that now-iconic stutter — the SCRATCH. He debuts it publicly in 1977.", manual: true },
      { text: "⚡ Grandmaster Flash turns it into a science: 'quick-mix theory', cutting precisely between duplicate records, the clock theory for finding the break by eye.", manual: true },
      { text: "🌍 1983. GrandMixer DXT scratches all over Herbie Hancock's 'Rockit' — scratching explodes worldwide and lands on MTV.", manual: true },
      { text: "🏆 1990s. The flare, the crab and beat-juggling push the craft into virtuoso territory. DJ QBert & the Invisibl Skratch Piklz dominate DMC battles, and DJ Babu coins the word 'TURNTABLISM' — the DJ as instrumentalist. Now go make some noise.", manual: true },
    ],
  },
];

export class PracticeCoach {
  constructor({ engine, ui, loadBeat, onClose }) {
    this.engine = engine;
    this.ui = ui;
    this.loadBeat = loadBeat;      // (deck, bpm) -> AudioBuffer applied to deck
    this.onClose = onClose;
    this.beatBpm = { A: 100, B: 100 };
    this.lesson = null;
    this.stepIndex = 0;
    this.completing = false;
    this.highlighted = [];
    this.fs = null;
    this.tm = null;
    this.el = this._buildCard();
    document.body.append(this.el);
    this._resetCounters(); // so onJog/onCrossfade are safe before any lesson starts
  }

  // ---- state accessors used by lesson check()/progress() ----
  playing(id) { return this.engine.decks[id].playing; }
  lowDb(id) { return this.engine.decks[id].low.gain.value; }
  effBpm(id) { return this.beatBpm[id] * (1 + this.engine.decks[id].tempo / 100); }
  setCross(v) { this.engine.setCrossfade(v); this.ui.syncCrossfade(v); }

  ensureBeat(deck, bpm) {
    const d = this.engine.decks[deck];
    if (!d.buffer || this.beatBpm[deck] !== bpm) {
      this.loadBeat(deck, bpm);
      this.beatBpm[deck] = bpm;
    }
  }

  // ---- instrumentation fed from the engine ----
  onJog(id, rate) {
    const s = Math.sign(rate);
    if (s !== 0 && this._lastSign[id] && s !== this._lastSign[id] && Math.abs(rate) > 0.5) {
      this.scratch[id]++;
      this._revTimes[id].push(performance.now());
      if (this.fs) { this.fs.scratch++; this._fsActivity(); this._fsTiming(); }
      if (this.tm) this._timingHit();
    }
    if (s !== 0) this._lastSign[id] = s;
  }
  onCrossfade(v) {
    if (this._xfPrev != null) {
      const d = v - this._xfPrev;
      if (Math.abs(d) > 0.05) {
        const dir = Math.sign(d);
        if (this._xfDir && dir !== this._xfDir) { this.xfReversals++; if (this.fs) { this.fs.cuts++; this._fsActivity(); this._fsTiming(); } if (this.tm) this._timingHit(); }
        this._xfDir = dir;
        this._xfPrev = v;
      }
    } else this._xfPrev = v;
    this.xfMin = Math.min(this.xfMin, v);
    this.xfMax = Math.max(this.xfMax, v);
    if (this.fs) { this.fs.xfMin = Math.min(this.fs.xfMin, v); this.fs.xfMax = Math.max(this.fs.xfMax, v); }
  }
  notify(type) {
    if (this.lesson) this.flags[type] = true;
    if (this.fs) {
      if (type === "eq") this.fs.usedEQ = true;
      else if (type === "tempo") this.fs.usedTempo = true;
      else this.fs.usedCue = true; // cueA/B, setCueA/B, hotcue
      this._fsActivity();
    }
  }

  /** Number of scratch direction-changes on a deck within the last `win` seconds. */
  scratchRate(id, win) {
    const cut = performance.now() - win * 1000;
    return this._revTimes[id].filter((t) => t >= cut).length;
  }

  _resetCounters() {
    this.scratch = { A: 0, B: 0 };
    this._lastSign = { A: 0, B: 0 };
    this._revTimes = { A: [], B: [] };
    this.xfReversals = 0; this._xfDir = 0; this._xfPrev = null;
    this.xfMin = this.engine.crossfade; this.xfMax = this.engine.crossfade;
    this.flags = {};
    this.tm = null;
    this.stopMetronome();
    const beat = this.el.querySelector(".coach-beat");
    if (beat) beat.hidden = true;
  }

  // ---- lesson flow ----
  start(lessonId) {
    this.lesson = LESSONS.find((l) => l.id === lessonId);
    this.stepIndex = 0;
    this.el.hidden = false;
    this._startStep(0);
  }

  _startStep(i) {
    this.stepIndex = i;
    this.completing = false;
    this._resetCounters();
    const step = this.lesson.steps[i];
    step.onEnter?.(this);
    this._highlight(step.highlight);
    this._render();
  }

  update() {
    if (this.fs) { this._freestyleTick(); return; }
    if (!this.lesson || this.completing) return;
    const step = this.lesson.steps[this.stepIndex];
    if (this.tm && this.metro) this._renderBeat();
    if (step.progress) {
      const pv = this.el.querySelector(".coach-prog");
      if (pv) pv.textContent = String(step.progress(this));
    }
    if (step.check && step.check(this)) this._complete();
  }

  _complete() {
    this.completing = true;
    this._clearHighlight();
    this.el.querySelector(".coach-check").classList.add("show");
    setTimeout(() => this._advance(), 850);
  }

  _advance() {
    if (!this.lesson) return;
    if (this.stepIndex + 1 < this.lesson.steps.length) this._startStep(this.stepIndex + 1);
    else this._finish();
  }

  _onNext() {
    if (this.results) { this.results = false; this.startFreestyle(); }
    else if (this.fs) this._freestyleFinish();
    else this._advance();
  }

  _finish() {
    const title = this.lesson.title;
    this.lesson = null;
    this._clearHighlight();
    this.el.querySelector(".coach-title").textContent = "✓ Lesson complete";
    this.el.querySelector(".coach-text").innerHTML = `Nice work — you finished <b>${title}</b>.`;
    this.el.querySelector(".coach-obj").textContent = "";
    this.el.querySelector(".coach-prog").textContent = "";
    this.el.querySelector(".coach-check").classList.remove("show");
    this.el.querySelector(".coach-next").hidden = true;
    this.el.querySelector(".coach-skip").hidden = true;
    setTimeout(() => this.exit(), 1600);
  }

  skip() { if (this.lesson) this._advance(); }

  exit() {
    this.lesson = null;
    this.fs = null;
    this.results = false;
    this.tm = null;
    this.stopMetronome();
    this.el.querySelector(".coach-beat").hidden = true;
    this._clearHighlight();
    this.el.hidden = true;
    this.onClose?.();
  }

  // ---- Freestyle: a scored 30-second routine ----
  startFreestyle() {
    this.lesson = null;
    this.results = false;
    this._clearHighlight();
    this.ensureBeat("A", 100);
    this.ensureBeat("B", 100);
    this._resetCounters();
    this.setCross(0.5);
    this.engine.decks.A.play();
    this.engine.decks.B.play();
    this.fs = {
      scratch: 0, cuts: 0, usedEQ: false, usedCue: false, usedTempo: false,
      xfMin: this.engine.crossfade, xfMax: this.engine.crossfade,
      slots: new Set(), start: performance.now(), dur: 30,
      bpm: 100, timingHits: 0, timingEvents: 0,
    };
    this.recorder?.start();
    this.el.hidden = false;
    this.el.classList.remove("min");
    this.el.querySelector(".coach-title").textContent = "🔥 Freestyle";
    this.el.querySelector(".coach-obj").textContent = "";
    this.el.querySelector(".coach-prog").textContent = "";
    this.el.querySelector(".coach-check").classList.remove("show");
    this.el.querySelector(".coach-skip").hidden = true;
    const next = this.el.querySelector(".coach-next");
    next.hidden = false; next.textContent = "Stop";
  }

  _fsActivity() {
    if (!this.fs) return;
    const e = (performance.now() - this.fs.start) / 1000;
    this.fs.slots.add(Math.min(5, Math.floor(e / (this.fs.dur / 6))));
  }

  /** How close an action lands to the 8th-note grid (1 = on it, 0 = off). */
  _beatPulse() {
    if (!this.fs) return 0;
    const period = 60 / this.fs.bpm;                 // one beat
    const t = (performance.now() - this.fs.start) / 1000;
    const phase = t % period;
    return 1 - Math.min(phase, period - phase) / (period / 2);
  }
  _fsTiming() {
    const period = 60 / this.fs.bpm / 2;             // 8th-note grid
    const t = (performance.now() - this.fs.start) / 1000;
    const phase = t % period;
    const err = Math.min(phase, period - phase);
    this.fs.timingHits += Math.max(0, 1 - err / 0.09); // ±90 ms window
    this.fs.timingEvents++;
  }

  // ---- Metronome timing drills ----
  startTiming(bpm, target) {
    this.tm = { bpm, target, good: 0, fb: "", fbT: 0, fbCls: "", lastHitT: 0 };
    this.startMetronome(bpm);
    this.el.querySelector(".coach-beat").hidden = false;
  }

  startMetronome(bpm) {
    this.stopMetronome();
    const ctx = this.engine.ctx;
    const period = 60 / bpm;
    const t0 = ctx.currentTime + 0.12;
    this.metro = { bpm, t0, next: t0, beat: 0, timer: null };
    const schedule = () => {
      while (this.metro && this.metro.next < ctx.currentTime + 0.25) {
        this._click(this.metro.next, this.metro.beat % 4 === 0);
        this.metro.next += period;
        this.metro.beat++;
      }
      if (this.metro) this.metro.timer = setTimeout(schedule, 50);
    };
    schedule();
  }
  stopMetronome() {
    if (this.metro) { clearTimeout(this.metro.timer); this.metro = null; }
  }
  _click(time, accent) {
    const ctx = this.engine.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1050;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(g); g.connect(this.engine.master);
    osc.start(time); osc.stop(time + 0.06);
  }

  /** Grade an action against the metronome's beat grid (audio clock). */
  _gradeHit() {
    const period = 60 / this.tm.bpm;
    const t = this.engine.ctx.currentTime - this.metro.t0;
    const err = t - Math.round(t / period) * period; // + = late, - = early
    const a = Math.abs(err);
    if (a < 0.06) return { q: 1, label: "🎯 PERFECT", cls: "perfect" };
    if (a < 0.13) return { q: 0.6, label: err > 0 ? "🟡 a touch late" : "🟡 a touch early", cls: "ok" };
    return { q: 0, label: err > 0 ? "🔴 late" : "🔴 early", cls: "off" };
  }
  _timingHit() {
    if (!this.tm || !this.metro) return;
    const now = performance.now();
    if (now - this.tm.lastHitT < 110) return; // debounce double-reversals
    this.tm.lastHitT = now;
    const r = this._gradeHit();
    this.tm.fb = r.label; this.tm.fbT = now; this.tm.fbCls = r.cls;
    if (r.q >= 0.6) this.tm.good++;
  }
  _renderBeat() {
    const period = 60 / this.metro.bpm;
    const ph = (this.engine.ctx.currentTime - this.metro.t0) % period;
    const p = 1 - Math.min(ph, period - ph) / (period / 2);
    const dot = this.el.querySelector(".coach-bdot");
    dot.style.transform = `scale(${(0.5 + 0.6 * Math.max(0, p)).toFixed(2)})`;
    dot.style.opacity = (0.3 + 0.7 * Math.max(0, p)).toFixed(2);
    const fb = this.el.querySelector(".coach-fb");
    if (performance.now() - this.tm.fbT < 550) { fb.textContent = this.tm.fb; fb.className = "coach-fb " + this.tm.fbCls; }
    else fb.textContent = "";
  }

  _freestyleTick() {
    const fs = this.fs;
    const remaining = Math.max(0, fs.dur - (performance.now() - fs.start) / 1000);
    const onbeat = fs.timingEvents ? Math.round((fs.timingHits / fs.timingEvents) * 100) : 0;
    const p = this._beatPulse();
    const dot = `<span class="fs-beatdot" style="transform:scale(${(0.55 + 0.55 * p).toFixed(2)});opacity:${(0.35 + 0.65 * p).toFixed(2)}"></span>`;
    this.el.querySelector(".coach-text").innerHTML =
      `<div class="fs-timer">${dot}${remaining.toFixed(1)}<span>s</span></div>
       <div class="fs-live">Scratches <b>${fs.scratch}</b> · Cuts <b>${fs.cuts}</b> · On-beat <b>${onbeat}%</b></div>
       <div class="fs-live2">EQ ${fs.usedEQ ? "✓" : "–"} · Cues ${fs.usedCue ? "✓" : "–"} · Tempo ${fs.usedTempo ? "✓" : "–"}</div>
       <div class="fs-hint">Lock to the pulse — scratch, cut, EQ, juggle, transition!</div>`;
    if (remaining <= 0) this._freestyleFinish();
  }

  _score(fs) {
    const activity = Math.min(25, fs.scratch * 0.75);
    const cuts = Math.min(15, fs.cuts * 1.0);
    const timingAcc = fs.timingEvents ? fs.timingHits / fs.timingEvents : 0;
    const timing = Math.round(timingAcc * 20);
    const cats = [fs.scratch > 0, fs.cuts > 0, fs.usedEQ, fs.usedCue, fs.usedTempo, fs.xfMax - fs.xfMin > 0.7];
    const variety = Math.min(20, cats.filter(Boolean).length * 3.5);
    const range = fs.xfMax - fs.xfMin;
    const transition = range > 0.8 ? 10 : Math.round((range / 0.8) * 10);
    const consistency = Math.round((fs.slots.size / 6) * 10);
    const total = Math.min(100, Math.round(activity + cuts + timing + variety + transition + consistency));
    return {
      total, timingAcc: Math.round(timingAcc * 100),
      activity: Math.round(activity), cuts: Math.round(cuts), timing,
      variety: Math.round(variety), transition, consistency,
    };
  }

  _saveScore(total) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem("sxratch.scores") || "[]"); } catch {}
    const entry = { score: total, date: Date.now() };
    list.push(entry);
    list.sort((a, b) => b.score - a.score);
    list = list.slice(0, 5);
    try { localStorage.setItem("sxratch.scores", JSON.stringify(list)); } catch {}
    return { list, isBest: list[0] === entry, entry };
  }

  _bar(label, val, max) {
    return `<div class="fs-bar"><span>${label}</span><div class="fs-track"><i style="width:${Math.round((val / max) * 100)}%"></i></div><b>${val}/${max}</b></div>`;
  }

  _freestyleFinish() {
    const fs = this.fs;
    this.fs = null;
    this.results = true;
    this.engine.decks.A.pause();
    this.engine.decks.B.pause();
    const s = this._score(fs);
    const rank = s.total >= 92 ? "🏆 Turntable Wizard" : s.total >= 78 ? "🔥 Battle DJ" : s.total >= 60 ? "🎧 Club Ready" : s.total >= 40 ? "🎉 Block Party" : "🛏 Bedroom DJ";
    const tips = [];
    if (fs.scratch < 12) tips.push("More scratching — keep that record moving.");
    if (fs.cuts < 6) tips.push("Use the crossfader to cut & chop the sound.");
    if (s.timingAcc < 55) tips.push("Lock your moves to the beat — watch the pulsing dot.");
    if (!fs.usedEQ) tips.push("Shape the mix with the EQ knobs.");
    if (fs.xfMax - fs.xfMin < 0.7) tips.push("Throw a full crossfade transition A↔B.");
    if (fs.slots.size < 5) tips.push("Keep the energy up across the whole 30s.");
    if (!tips.length) tips.push("Clean, on-beat, varied and relentless — that's the level. 🔥");

    const { list, isBest, entry } = this._saveScore(s.total);
    const board = list.map((e, i) =>
      `<li class="${e === entry ? "me" : ""}"><span>#${i + 1}</span><b>${e.score}</b><em>${new Date(e.date).toLocaleDateString()}</em></li>`
    ).join("");

    this.el.querySelector(".coach-title").textContent = "🔥 Freestyle — result";
    this.el.querySelector(".coach-text").innerHTML =
      `<div class="fs-score">${s.total}<span>/100</span></div>
       <div class="fs-rank">${rank}${isBest ? ' <span class="fs-best">NEW BEST!</span>' : ""}</div>
       <div class="fs-bars">
         ${this._bar("Activity", s.activity, 25)}
         ${this._bar("Crossfader", s.cuts, 15)}
         ${this._bar("Timing", s.timing, 20)}
         ${this._bar("Variety", s.variety, 20)}
         ${this._bar("Transition", s.transition, 10)}
         ${this._bar("Consistency", s.consistency, 10)}
       </div>
       <div class="fs-onbeat">On-beat accuracy: <b>${s.timingAcc}%</b></div>
       <ul class="fs-tips">${tips.map((t) => `<li>${t}</li>`).join("")}</ul>
       <div class="fs-board-title">Top scores</div>
       <ol class="fs-board">${board}</ol>
       <div class="fs-playback"></div>`;
    const next = this.el.querySelector(".coach-next");
    next.hidden = false; next.textContent = "Try again";

    this.recorder?.stop((url) => this._addPlayback(url));
  }

  _addPlayback(url) {
    const box = this.el.querySelector(".fs-playback");
    if (!url || !box) return;
    box.innerHTML = `<button class="btn fs-play">▶ Hear your routine</button><a class="btn fs-dl" download="sxratch-routine.webm">⤓ Save</a>`;
    const audio = new Audio(url);
    const btn = box.querySelector(".fs-play");
    btn.addEventListener("click", () => {
      if (audio.paused) { audio.play(); btn.textContent = "⏸ Pause"; }
      else { audio.pause(); btn.textContent = "▶ Hear your routine"; }
    });
    audio.onended = () => { btn.textContent = "▶ Hear your routine"; };
    box.querySelector(".fs-dl").href = url;
  }

  // ---- rendering ----
  _buildCard() {
    const el = document.createElement("div");
    el.id = "coach";
    el.hidden = true;
    el.innerHTML = `
      <div class="coach-head">
        <span class="coach-title"></span>
        <div class="coach-head-btns">
          <button class="coach-min" title="Minimize">–</button>
          <button class="coach-x" title="Exit practice">✕</button>
        </div>
      </div>
      <div class="coach-body">
        <div class="coach-text"></div>
        <div class="coach-meta"><span class="coach-obj"></span><span class="coach-prog"></span></div>
        <div class="coach-beat" hidden><span class="coach-bdot"></span><span class="coach-fb"></span></div>
        <div class="coach-check">✓</div>
        <div class="coach-actions">
          <button class="btn coach-skip">Skip</button>
          <button class="btn primary coach-next" hidden>Got it →</button>
        </div>
      </div>`;
    el.querySelector(".coach-x").addEventListener("click", () => this.exit());
    el.querySelector(".coach-skip").addEventListener("click", () => this.skip());
    el.querySelector(".coach-next").addEventListener("click", () => this._onNext());
    el.querySelector(".coach-min").addEventListener("click", () => el.classList.toggle("min"));
    this._makeDraggable(el, el.querySelector(".coach-head"));
    return el;
  }

  _render() {
    const l = this.lesson;
    if (!l) return;
    const step = l.steps[this.stepIndex];
    this.el.querySelector(".coach-title").textContent = `${l.title} · ${this.stepIndex + 1}/${l.steps.length}`;
    this.el.querySelector(".coach-text").innerHTML = step.text;
    this.el.querySelector(".coach-obj").textContent = step.progress ? "Progress:" : "";
    this.el.querySelector(".coach-prog").textContent = step.progress ? String(step.progress(this)) : "";
    this.el.querySelector(".coach-check").classList.remove("show");
    this.el.querySelector(".coach-next").hidden = !step.manual;
    this.el.querySelector(".coach-skip").hidden = !!step.manual;
  }

  _highlight(sel) {
    this._clearHighlight();
    if (!sel) return;
    document.querySelectorAll(sel).forEach((node) => {
      node.classList.add("coach-target");
      this.highlighted.push(node);
    });
  }
  _clearHighlight() {
    this.highlighted.forEach((n) => n.classList.remove("coach-target"));
    this.highlighted = [];
  }

  _makeDraggable(el, handle) {
    let active = false, ox = 0, oy = 0, id = null;
    handle.style.cursor = "move";
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      active = true; id = e.pointerId;
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      el.style.right = "auto"; el.style.bottom = "auto";
      try { handle.setPointerCapture(id); } catch {}
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!active || e.pointerId !== id) return;
      el.style.left = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, e.clientX - ox)) + "px";
      el.style.top = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - oy)) + "px";
    });
    const end = () => { active = false; };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
}
