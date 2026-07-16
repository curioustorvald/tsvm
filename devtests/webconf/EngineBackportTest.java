import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.backends.lwjgl3.audio.OpenALLwjgl3Audio;
import net.torvald.tsvm.AudioJSR223Delegate;
import net.torvald.tsvm.PeripheralEntry;
import net.torvald.tsvm.TheRealWorld;
import net.torvald.tsvm.VM;
import net.torvald.tsvm.VMWatchdog;
import net.torvald.tsvm.peripheral.AudioAdapter;
import net.torvald.tsvm.peripheral.VMProgramRom;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;

/**
 * Headless scenario tests for the engine fixes backported from Microtone.js
 * (2026-07-16): each leg mirrors the corresponding web test in
 * microtone-worker/test/node/engine-scenarios.test.js so the two engines'
 * TARGETED behaviours stay in lockstep (the corpus conformance dumps prove
 * the fixes change nothing on ordinary playback; these prove they DO change
 * the intended scenarios).
 *
 *   1. item 43 — note 0 + instrument + pitch effect F re-triggers the note at
 *      the voice's current pitch (was: latch-only, silent).
 *   2. item 44/25 — setTrackerRow clears NNA ghosts, S$Bx pattern-loop +
 *      Ditto memory, pattern-delay/sex/fine-delay state, pending interrupts.
 *   3. item 45 — muting a channel silences its metainstrument layer children
 *      (background voices) too.
 *   4. item 23 — getVoiceNote follows the per-tick sounding pitch (arpeggio
 *      deviates) while Voice.noteVal stays at the base note.
 *   5. displayInst — getVoiceInstrument reports the pattern-level meta slot,
 *      not the layer child the trigger resolved to.
 *
 * Build/run: see devtests/ixmp/README.md (same classpath recipe;
 * ALSOFT_DRIVERS=null for the silent OpenAL backend). Drives
 * generateTrackerAudio synchronously like MetaTest, so voice state can be
 * read without racing the render thread.
 */
public class EngineBackportTest {

    static Object getField(Object o, String name) throws Exception {
        Class<?> c = o.getClass();
        while (c != null) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(o); }
            catch (NoSuchFieldException e) { c = c.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }

    static void setField(Object o, String name, Object v) throws Exception {
        Class<?> c = o.getClass();
        while (c != null) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); f.set(o, v); return; }
            catch (NoSuchFieldException e) { c = c.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }

    /** A looping single-sample instrument so voices sustain (MetaTest twin). */
    static int[] loopingInst(int ptr, int len) {
        int[] inst = new int[256];
        inst[0] = ptr & 0xFF; inst[1] = (ptr >> 8) & 0xFF; inst[2] = (ptr >> 16) & 0xFF; inst[3] = (ptr >> 24) & 0xFF;
        inst[4] = len & 0xFF; inst[5] = (len >> 8) & 0xFF;
        inst[6] = 8363 & 0xFF; inst[7] = 8363 >> 8;
        inst[12] = len & 0xFF; inst[13] = (len >> 8) & 0xFF;   // loop end
        inst[14] = 1;                                          // forward loop
        inst[15] = 0x20; inst[16] = 0x20;                      // vol LOOP word b|P
        inst[21] = 63;                                         // vol-env terminator VALUE 0x3F
        for (int k = 0; k < 25; k++) { inst[71 + k*2] = 0x80; inst[121 + k*2] = 0x80; }
        inst[171] = 255; inst[177] = 0x80; inst[179] = 0x50;
        inst[182] = 255; inst[183] = 255; inst[186] = 0b10;    // NNA continue
        return inst;
    }

    /** Short NON-looping sample instrument (item-43 leg; web test twin). */
    static int[] shortInst(int len) {
        int[] rec = new int[256];
        rec[4] = len & 0xFF; rec[5] = (len >> 8) & 0xFF;
        rec[6] = 32000 & 0xFF; rec[7] = 32000 >> 8;
        rec[14] = 0;                                           // no loop
        rec[21] = 0x3F;                                        // vol-env terminator VALUE 0x3F
        rec[171] = 255; rec[196] = 255;
        return rec;
    }

    /** layers: rows of {instIdx, mixOctet, detune, pStart, pEnd, vStart, vEnd}. */
    static int[] metaInst(int[][] layers) {
        int[] r = new int[256];
        r[0] = 0; r[1] = layers.length & 0xFF; r[2] = 0xFF; r[3] = 0xFF;
        int o = 4;
        for (int[] L : layers) {
            r[o] = L[0] & 0xFF; r[o+1] = L[1] & 0xFF;
            r[o+2] = L[2] & 0xFF; r[o+3] = (L[2] >> 8) & 0xFF;
            r[o+4] = L[3] & 0xFF; r[o+5] = (L[3] >> 8) & 0xFF;
            r[o+6] = L[4] & 0xFF; r[o+7] = (L[4] >> 8) & 0xFF;
            r[o+8] = L[5] & 0xFF; r[o+9] = L[6] & 0xFF;
            o += 10;
        }
        return r;
    }

    /** Blank 64-row pattern with the converter's empty vol/pan bytes (0xC0). */
    static int[] blankPattern() {
        int[] pat = new int[512];
        for (int r = 0; r < 64; r++) { pat[r*8+3] = 0xC0; pat[r*8+4] = 0xC0; }
        return pat;
    }

    /** v2 cue: every channel empty (0x7FFF) except ch0 → pattern 0. */
    static int[] cueCh0Pat0() {
        int[] cue = new int[64];
        for (int ch = 0; ch < 32; ch++) { cue[ch*2] = 0xFF; cue[ch*2+1] = 0x7F; }
        cue[0] = 0; cue[1] = 0;
        return cue;
    }

    static int pass = 0, fail = 0;
    static void check(String name, boolean ok) {
        System.out.println((ok ? "PASS " : "FAIL ") + name);
        if (ok) pass++; else fail++;
    }

    public static void main(String[] args) throws Exception {
        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);
        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(),
                       new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
        AudioAdapter snd = new AudioAdapter(vm);
        vm.getPeripheralTable()[1] = new PeripheralEntry(snd);
        AudioJSR223Delegate audio = new AudioJSR223Delegate(vm);

        Method genAudio = null;
        for (Method m : snd.getClass().getDeclaredMethods())
            if (m.getName().contains("generateTrackerAudio")) { genAudio = m; break; }
        genAudio.setAccessible(true);

        Object playhead = ((Object[]) getField(snd, "playheads"))[0];
        Object ts = getField(playhead, "trackerState");
        Object fg = ((Object[]) getField(ts, "voices"))[0];

        // ── shared setup: samples + instruments ─────────────────────────────
        audio.setSampleBank(0);
        for (int i = 0; i < 2048; i++) {
            snd.poke((long) i,        (byte) (i % 256));         // ptr 0: ramp (looping insts)
            snd.poke((long) (4096+i), (byte) (255 - (i % 256))); // ptr 4096
        }
        // ptr 8192: 2000-frame one-shot — ends inside row 0 (3840 samples/row) but,
        // once re-triggered at row 1, still sounds when the assertions sample it.
        for (int i = 0; i < 2000; i++) snd.poke((long) (8192+i), (byte) (128 + 40));
        audio.uploadInstrument(1, loopingInst(0, 2048));
        audio.uploadInstrument(2, loopingInst(4096, 2048));
        audio.uploadInstrument(3, metaInst(new int[][]{
            {1, 159, 0,    0x0000, 0xFFFF, 0x00, 0x3F},
            {2, 159, 4096, 0x0000, 0xFFFF, 0x00, 0x3F},
        }));
        int[] shortRec = shortInst(2000);
        shortRec[0] = 8192 & 0xFF; shortRec[1] = 8192 >> 8;
        audio.uploadInstrument(5, shortRec);

        audio.setTrackerMode(0);
        audio.setBPM(0, 125); audio.setTickRate(0, 6);
        audio.setMasterVolume(0, 255);

        // ════ leg 1: item 43 — note0 + inst + F re-triggers at current pitch ════
        {
            int[] pat = blankPattern();
            pat[0] = 0x00; pat[1] = 0x50; pat[2] = 5;                         // row 0: C4, short inst 5
            pat[8+2] = 5; pat[8+5] = 0x0F; pat[8+6] = 0x01; pat[8+7] = 0x01;  // row 1: note 0, inst 5, F $0101
            audio.uploadPattern(0, pat);
            audio.uploadCue(0, cueCh0Pat0());
            audio.setCuePosition(0, 0);
            audio.setTrackerRow(0, 0);
            audio.play(0);
            long samples = 0;
            while (samples < 3072) { genAudio.invoke(snd, playhead); samples += 512; } // mid row 0 (< 3840); 2000-frame note over
            boolean idleAfterShortNote = !((Boolean) getField(fg, "active"));
            int remembered = (Integer) getField(fg, "noteVal");
            while (samples < 4608) { genAudio.invoke(snd, playhead); samples += 512; } // into row 1
            boolean retriggered = (Boolean) getField(fg, "active");
            int instId = (Integer) getField(fg, "instrumentId");
            double spos = (Double) getField(fg, "samplePos");
            audio.stop(0);
            check("item43: short row-0 note ended, voice idle", idleAfterShortNote);
            check("item43: voice remembers the last note", remembered >= 0x20);
            check("item43: note0 + inst + F re-triggered the note", retriggered);
            check("item43: re-trigger bound inst 5 from sample start", instId == 5 && spos < 2000);
        }

        // ════ leg 2: item 44/25 — setTrackerRow clears transient play state ════
        {
            // Real background voices via a meta jam, then poke the rest by reflection.
            audio.jamNote(0, 0, 0x5000, 3);
            Iterable<?> bgs = (Iterable<?>) getField(ts, "backgroundVoices");
            int bgCount = 0; for (Object b : bgs) if ((Boolean) getField(b, "active")) bgCount++;
            Object[] voices = (Object[]) getField(ts, "voices");
            setField(ts, "patternDelayActive", true);
            setField(ts, "patternDelayRemaining", 4);
            setField(ts, "sexWinningChannel", 7);
            setField(ts, "finePatternDelayExtra", 2);
            ((java.util.concurrent.atomic.AtomicInteger) getField(ts, "pendingInterrupts")).set(0b101);
            setField(ts, "pendingRowJump", 12);
            setField(ts, "pendingRowJumpLocal", true);
            setField(voices[3], "dittoActive", true);
            setField(voices[3], "dittoSourceStart", 4);
            setField(voices[3], "dittoLength", 2);
            setField(voices[3], "dittoEndRow", 10);
            setField(voices[5], "loopStartRow", 8);
            setField(voices[5], "loopCount", 3);

            audio.setTrackerRow(0, 0);

            boolean bgAllOff = true;
            for (Object b : (Iterable<?>) getField(ts, "backgroundVoices"))
                if ((Boolean) getField(b, "active")) bgAllOff = false;
            check("item44: meta jam spawned a background layer child", bgCount >= 1);
            check("item44: NNA ghosts / layer children deactivated", bgAllOff);
            check("item44: foreground voices silenced", !((Boolean) getField(voices[0], "active")));
            check("item44: pattern-delay state cleared",
                  !((Boolean) getField(ts, "patternDelayActive")) &&
                  (Integer) getField(ts, "patternDelayRemaining") == 0 &&
                  (Integer) getField(ts, "sexWinningChannel") == -1 &&
                  (Integer) getField(ts, "finePatternDelayExtra") == 0);
            check("item44: pending interrupts cleared",
                  ((java.util.concurrent.atomic.AtomicInteger) getField(ts, "pendingInterrupts")).get() == 0);
            check("item44: pending row jump cleared",
                  (Integer) getField(ts, "pendingRowJump") == -1 &&
                  !((Boolean) getField(ts, "pendingRowJumpLocal")));
            check("item44: Ditto memory cleared",
                  !((Boolean) getField(voices[3], "dittoActive")) &&
                  (Integer) getField(voices[3], "dittoSourceStart") == 0 &&
                  (Integer) getField(voices[3], "dittoLength") == 0 &&
                  (Integer) getField(voices[3], "dittoEndRow") == 0);
            check("item44: S$Bx pattern-loop memory cleared",
                  (Integer) getField(voices[5], "loopStartRow") == 0 &&
                  (Integer) getField(voices[5], "loopCount") == 0);
            // drain the deactivated ghosts through one silent render so leg 3 starts clean
            genAudio.invoke(snd, playhead);
        }

        // ════ leg 3: item 45 — channel mute covers layer children ════
        // ════ leg 5: displayInst — getVoiceInstrument reports the meta slot ════
        {
            audio.jamNote(0, 0, 0x5000, 3);
            int bgCount = 0;
            for (Object b : (Iterable<?>) getField(ts, "backgroundVoices"))
                if ((Boolean) getField(b, "active")) bgCount++;
            check("item45: meta $3 spawns a background layer child", bgCount >= 1);
            check("displayInst: getVoiceInstrument reports the meta slot (3), voice plays child (1)",
                  audio.getVoiceInstrument(0, 0) == 3 &&
                  (Integer) getField(fg, "instrumentId") == 1);

            double loud = rms(genAudio, snd, playhead, 30);
            check("item45: sounds while unmuted", loud > 1.0);

            audio.jamNote(0, 0, 0x5000, 3);   // re-jam (rms drains jam state over time)
            audio.setVoiceMute(0, 0, true);
            double muted = rms(genAudio, snd, playhead, 30);
            audio.setVoiceMute(0, 0, false);
            audio.jamStop(0);
            check(String.format("item45: muted RMS %.3f << unmuted %.3f (layer child silenced too)", muted, loud),
                  muted < loud * 0.05);
            genAudio.invoke(snd, playhead);
        }

        // ════ leg 4: item 23 — getVoiceNote follows the per-tick arpeggio pitch ════
        {
            int[] pat = blankPattern();
            pat[0] = 0x00; pat[1] = 0x50;   // note 0x5000
            pat[2] = 1;                     // inst 1 (looping)
            pat[5] = 0x13;                  // OP_J arpeggio
            pat[6] = 0x04; pat[7] = 0x03;   // arg $0304
            audio.uploadPattern(0, pat);
            audio.uploadCue(0, cueCh0Pat0());
            audio.setCuePosition(0, 0);
            audio.setTrackerRow(0, 0);
            audio.play(0);
            Set<Integer> seen = new HashSet<>();
            boolean baseStable = true;
            for (int i = 0; i < 8; i++) {          // 8 × 512 = 4096 samples ≈ 6.4 ticks
                genAudio.invoke(snd, playhead);
                seen.add(audio.getVoiceNote(0, 0));
                if ((Integer) getField(fg, "noteVal") != 0x5000) baseStable = false;
            }
            audio.stop(0);
            boolean deviates = false;
            for (int p : seen) if (p != 0x5000 && p != 0) deviates = true;
            check("item23: base noteVal never moves under arpeggio", baseStable);
            check("item23: getVoiceNote deviates from base per tick", deviates);
            check("item23: getVoiceNote varies across ticks", seen.size() >= 2);
        }

        System.out.println("── " + pass + " pass, " + fail + " fail");
        System.exit(fail == 0 ? 0 : 1);
    }

    /** RMS (around the u8 midpoint 128) of `chunks` × 512-sample stereo chunks. */
    static double rms(Method genAudio, AudioAdapter snd, Object playhead, int chunks) throws Exception {
        double sum = 0; long n = 0;
        for (int c = 0; c < chunks; c++) {
            byte[] out = (byte[]) genAudio.invoke(snd, playhead);
            if (out == null) break;
            for (byte b : out) { double d = (b & 0xFF) - 128; sum += d * d; n++; }
        }
        return n == 0 ? 0 : Math.sqrt(sum / n);
    }
}
