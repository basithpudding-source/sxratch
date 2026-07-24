# Sxratch sample assets

## FluidR3_GM/

Per-note MP3 renderings of the **FluidR3 GM** soundfont, in the MIDI.js
one-file-per-instrument format. Only the 14 General MIDI programs the Song
Builder actually uses are included (see `GM_PROGRAMS` in `js/instruments.js`).

Self-hosting these (instead of fetching them from a third-party CDN at runtime)
gives the Sampled · GM engine reliability, first-party caching through the
service worker (so it works offline after first use), and no external
dependency at release time. The loader still falls back to the
[gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) CDN
if a local file is missing.

Regenerate / update with:

```bash
npm run samples
```

**License:** FluidR3 GM was created by Frank Wen and is distributed under the
MIT license; the MP3 renderings come from the gleitz/midi-js-soundfonts
project, also MIT. Copyright and license text:
<https://github.com/gleitz/midi-js-soundfonts/blob/master/LICENSE.md>

The sampled **drum kits** are *not* redistributed here: they are fetched at
runtime directly from the Tone.js example-audio host by the user's browser
(licensing of those recordings is less clearly documented, so Sxratch does not
ship copies). The default synthesized drum kits require no assets at all.
