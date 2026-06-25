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
    btn.textContent = playing ? "❚❚" : "▶";
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
