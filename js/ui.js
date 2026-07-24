// Sxratch UI helpers: display updates, toasts, button state.

export class UI {
  constructor(engine) {
    this.engine = engine;
    this.waves = { A: null, B: null };
    this.onCrossfadeChange = null;
    this.toastEl = document.getElementById("toast");
    this.toastTimer = null;
    this.titleEl = { A: document.getElementById("title-A"), B: document.getElementById("title-B") };
    this.timeEl = { A: document.getElementById("time-A"), B: document.getElementById("time-B") };
    this.playBtn = { A: document.getElementById("play-A"), B: document.getElementById("play-B") };
    this.crossfadeSet = null; // registered by app to the custom crossfader's setter
    this.bpmEl = { A: null, B: null }; // live BPM readouts (registered by the deck console)
  }

  /**
   * Update a deck's BPM readout. Shows the *effective* tempo (track BPM ×
   * pitch fader) — and "--" when the BPM genuinely isn't known, never a fake.
   */
  setBpm(deck, known) {
    const el = this.bpmEl[deck];
    if (!el) return;
    const d = this.engine.decks[deck];
    el.textContent = known && d.buffer
      ? (d.bpm * (1 + d.tempo / 100)).toFixed(1)
      : "--";
  }

  setWaveform(deck, wave) { this.waves[deck] = wave; }

  formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  setTitle(deck, name) {
    this.titleEl[deck].textContent = name || "No track loaded";
  }

  updatePosition(deck, position) {
    const d = this.engine.decks[deck];
    if (this.waves[deck]) this.waves[deck].setPosition(position);
    const cur = position * d.duration;
    this.timeEl[deck].textContent = `${this.formatTime(cur)} / ${this.formatTime(d.duration)}`;
  }

  setPlaying(deck, playing) {
    const btn = this.playBtn[deck];
    btn.classList.toggle("playing", playing);
    btn.innerHTML = playing
      ? '<span aria-hidden="true">❚❚</span><span>PAUSE</span>'
      : '<span aria-hidden="true">▶</span><span>PLAY</span>';
  }

  syncCrossfade(v) {
    if (this.crossfadeSet) this.crossfadeSet(v, false); // update slider without re-firing
  }

  flash(deck) {
    const btn = this.playBtn[deck];
    btn.animate(
      [{ filter: "brightness(1.8)" }, { filter: "brightness(1)" }],
      { duration: 220 }
    );
  }

  toast(msg) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove("show"), 1600);
  }
}
// (BPM readouts intentionally show "--" until a tempo is actually known.)
