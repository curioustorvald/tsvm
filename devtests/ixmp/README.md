# Ixmp headless engine tests

Standalone JVM tests that drive the **real compiled tsvm_core engine** (no
window, no audio hardware — OpenAL-soft null driver) to verify the Taud
engine's Ixmp ("instrument extra samples") support end to end.

Verified 2026-06-11: all four tests PASS against the engine as of that date —
the Ixmp playback path (terranmon TODO "Expectedly not working") in fact
works; the bugs found and fixed were in the surrounding plumbing
(`uploadInstrument` 192-byte cap, stale `extraPatches` across
`uploadSampleInstBlob`, and the capture path losing Ixmp on save).

## Tests

- **IxmpTest** — synthetic song: base sample at pool 0, Ixmp patch sample at
  4096 over pitch rect 0x6000..0x7000. Asserts the voice's active-sample
  snapshot switches to the patch for in-rectangle triggers and falls back to
  base outside.
- **IxmpFileTest** — loads a real .taud through the exact `taud.mjs
  uploadTaudFile` sequence (blob → patterns → cues → Ixmp walk), plays it,
  and cross-checks every fresh trigger's `activeSamplePtr` against the file's
  own Ixmp rectangle table. Args: path to .taud (default `DOOM-E1M1.taud`).
- **StaleTest** — `uploadSampleInstBlob` must clear previously installed
  patches (whole-image replace), and `uploadInstrument` must accept the full
  256-byte record (byte 196 round-trip).
- **RoundTripTest** — `getInstrumentPatches` must byte-exactly invert
  `uploadInstrumentPatches` (used by `captureTrackerDataToFile` to preserve
  Ixmp on save).
- **PatchEnvTest** — per-patch envelope support (variable-length Ixmp, 2026-06-13).
  Base instrument carries a slow 2 s vol-env attack; an Ixmp patch over a pitch rect
  carries its own fast 0.1 s attack ('v' block, looping samples so voices sustain).
  Asserts the in-rect note reaches full envelope volume (1.0) while the out-of-rect
  note is still climbing (< 0.5) — i.e. the engine applies the patch's envelope, not
  the base instrument's. Also round-trips a patch carrying a 'v' block byte-exactly.
- **MetaTest** — Metainstrument layering (terranmon.txt "Metainstrument
  definition", 2026-06-13). Builds two normal instruments + two metas and drives
  the engine SYNCHRONOUSLY (calls `generateTrackerAudio` on the test thread so the
  background-voice pool can be read without racing the render thread). Asserts a
  meta trigger fans out into a foreground voice + tracked background "layer child",
  the child tracks the layer's detune (+1 oct) and distinct sample, the mix-volume
  octet maps to the right gain, velocity-conditional layers gate correctly, and
  key-off propagates to the child. NB: read kotlin.collections.ArrayDeque via
  `Iterable`, not `java.util.ArrayDeque`.
- **AuxBinMetaTest** — auxiliary instrument bin ($100..$3FF; terranmon.txt:2036-2048,
  2026-07-01). Same shape as MetaTest, but the two layer SUBINSTRUMENTS live in the aux
  bin — one in bank 0 (0x101) and one in bank 2 (0x305), reachable only through a
  Metainstrument's layer table — and the meta layer records encode the 10-bit instrument
  index (low 8 bits in byte 0, bits 8..9 in bits 6..7 of the volume-start byte). Asserts
  the meta fans out into voices that play the aux-bin instruments across banks (detune /
  mix / velocity-gate / key-off all correct), AND that the MMIO-48-banked 655360 window
  round-trips: a poke under each bank lands in instruments[256 + bank*256].
- **MetaFileTest** — end-to-end: loads a real `midi2taud --max-layers N` output
  (default `/tmp/m_e1m1_meta.taud`) through the `taud.mjs#uploadTaudFile` byte
  sequence, asserts ≥1 Metainstrument was parsed from the instrument bin, and
  drives playback synchronously to confirm notes fan out into ≥1 background layer
  child. (Timbres-of-Heaven E1M1 hits 8 simultaneous layer children.)
- **FastFadeTest** — fast note-fade (note word **0x0004**; added 2026-06-14). The
  engine half of midi2taud's SF2 exclusiveClass percussion choke (a closed hi-hat
  silencing a ringing open hi-hat — FluidSynth `fluid_voice_kill_excl`). Two voices play
  the same looping long-hold instrument; voice 0 gets 0x0004 at row 12. Asserts voice 0
  fades to silence in ~0.3 s while the control voice keeps ringing, and that the fall is
  gradual (a fade, not ^^CUT's hard stop).
- **KeyLiftTest** — "Key Lift" NNA (instrument flag byte 186 bit 5, pattern
  0b100; added 2026-06-12): on key-off the volume-envelope playhead jumps
  straight to the sustain-end node so the release nodes play immediately —
  MIDI-exact key-up, vs IT note-off which still walks the remaining
  hold/decay first ("sustain pedal" wash on SF2 imports). Asserts both the
  NNA-ghost and pattern-KEY_OFF paths die within the release time while a
  traditional Note Off instrument is still ringing.
- **MetaKeyOffFadeTest** — Metainstrument layer-child KEY_OFF race (fixed
  2026-06-15). Layer children inherit the parent's key-off via the per-tick
  background sync, but only while the parent is ACTIVE. With a FAST volume
  fadeout (fo=0xFFF / 1067 — a ~1-tick cut, which SF2 presets with a short
  releaseVolEnv routinely get) the foreground voice deactivates in the SAME tick
  the KEY_OFF fires, before the sync runs, so the child was detached as an orphan
  that never picked up the release and rang on (looping at its sustain level)
  until the next note. Symptom: long tails on multi-layer SF2 presets with a
  short release, e.g. Timbres of Heaven's sustained "Ult. Overdriven Gt."
  (37 zones → 4 layers; reported "decays extremely slowly"). Drives one 2-layer
  meta note then KEY_OFF; asserts the child both inherits the key-off and stops
  ringing afterwards. (MetaTest's slow/zero-fadeout instruments don't hit the
  race — the parent survives — so this test guards the fast-fadeout case the fix
  added: the inactive-parent branch now inherits the release before detaching.)

## Running

```sh
JDK=~/Documents/openjdk/jdk-21.0.2-x86
CP="out/production/tsvm_core:$(ls lib/*.jar | grep -v -E 'sources|javadoc' | tr '\n' ':')"
$JDK/bin/javac -cp "$CP" devtests/ixmp/*.java -d /tmp/ixmptest
ALSOFT_DRIVERS=null $JDK/bin/java -cp "/tmp/ixmptest:$CP" IxmpFileTest DOOM-E1M1.taud
```

`ALSOFT_DRIVERS=null` makes OpenAL-soft use its silent null backend so the
tests run on machines without a sound device. Rebuild the project in IntelliJ
first so `out/production/tsvm_core` reflects current sources.

NB: the synchronous-drive tests (MetaTest, AuxBinMetaTest, MetaFileTest, …) must call
`audio.play(0)` before the `generateTrackerAudio` loop — `generateTrackerAudio` only
advances rows/cues while `playhead.isPlaying` (AudioAdapter.kt `val advancing =
playhead.isPlaying`); without it the song never starts and every assertion fails.
