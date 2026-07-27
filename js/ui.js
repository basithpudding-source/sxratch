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

    // Screen-reader plumbing: toasts double as polite status announcements,
    // and announce() drives an offscreen assertive region for events that
    // must interrupt (recording started/stopped, engine failures).
    if (this.toastEl) {
      this.toastEl.setAttribute("role", "status");
      this.toastEl.setAttribute("aria-live", "polite");
    }
    this.announceEl = document.createElement("div");
    this.announceEl.setAttribute("aria-live", "assertive");
    this.announceEl.setAttribute("role", "alert");
    this.announceEl.className = "sr-only";
    document.body.appendChild(this.announceEl);
  }

  /** Assertive screen-reader announcement (visually hidden). */
  announce(msg) {
    // Clear first so repeating the same message is re-announced.
    this.announceEl.textContent = "";
    requestAnimationFrame(() => { this.announceEl.textContent = msg; });
  }

  /**
   * Trap Tab focus inside an open dialog, close on Esc via the app's global
   * handler, and restore focus to the previously-focused element on close.
   * Returns a release() function. Also stamps dialog ARIA roles.
   */
  trapFocus(dialogEl) {
    dialogEl.setAttribute("role", "dialog");
    dialogEl.setAttribute("aria-modal", "true");
    const opener = document.activeElement;
    const focusables = () => [...dialogEl.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )].filter((e) => !e.disabled && e.offsetParent !== null);
    const onKey = (e) => {
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0], lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
    };
    dialogEl.addEventListener("keydown", onKey);
    (focusables()[0] || dialogEl).focus?.();
    return () => {
      dialogEl.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
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
