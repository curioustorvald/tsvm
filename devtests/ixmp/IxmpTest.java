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

/**
 * Headless integration test for the Taud engine's Ixmp ("instrument extra
 * samples") support. Builds a synthetic song entirely through the JS-facing
 * delegate API:
 *   - sample A (square-ish ramp) at pool offset 0      <- base instrument
 *   - sample B at pool offset 4096                     <- Ixmp patch, pitch 0x6000..0x7000
 *   - pattern: row 0 note 0x5000 (base), row 8 note 0x6800 (patch),
 *              row 16 note 0x5000 (base again), row 24 KEY_OFF
 * then plays it and polls voice 0's active-sample snapshot.
 *
 * PASS criteria: activeSamplePtr is 0 after row 0, 4096 after row 8, 0 after row 16.
 */
public class IxmpTest {

    static Object getField(Object o, String name) throws Exception {
        Class<?> c = o.getClass();
        while (c != null) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(o);
            } catch (NoSuchFieldException e) { c = c.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }

    public static void main(String[] args) throws Exception {
        // ── Boot a minimal GDX audio backend (no window, null AL driver ok) ──
        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);

        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(),
                       new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
        AudioAdapter snd = new AudioAdapter(vm);
        vm.getPeripheralTable()[1] = new PeripheralEntry(snd);
        AudioJSR223Delegate audio = new AudioJSR223Delegate(vm);

        // ── Sample pool: A at 0, B at 4096, each 2048 bytes ──
        audio.setSampleBank(0);
        for (int i = 0; i < 2048; i++) {
            snd.poke((long) i,        (byte) (i % 256));            // sample A
            snd.poke((long) (4096+i), (byte) (255 - (i % 256)));    // sample B
        }

        // ── Base instrument record (slot 1) ──
        int[] inst = new int[192];
        // ptr=0 (bytes 0-3 already 0)
        inst[4] = 2048 & 0xFF; inst[5] = 2048 >> 8;     // length
        inst[6] = 8363 & 0xFF; inst[7] = 8363 >> 8;     // samplingRate (C4 speed)
        // loop 0..0, flags 0 = no loop
        inst[15] = 0x20; inst[16] = 0x20;               // vol LOOP word: b|P (0x2020)
        inst[21] = 63;                                  // vol env node 0 = full
        for (int k = 0; k < 25; k++) { inst[71 + k*2] = 0x80; inst[121 + k*2] = 0x80; }
        inst[171] = 255;                                // IGV
        inst[177] = 0x80;                               // default pan centre
        inst[178] = 0x00; inst[179] = 0x50;             // PPC = 0x5000
        inst[182] = 255; inst[183] = 255;               // IFC/IFR off
        inst[186] = 0b01;                               // NNA = cut
        audio.uploadInstrument(1, inst);

        // ── Ixmp patch: pitch 0x6000..0x7000 → sample B ──
        int[] p = new int[31];
        p[0] = 1;                                       // version
        p[1] = 0x00; p[2] = 0x60;                       // pitchStart 0x6000
        p[3] = 0x00; p[4] = 0x70;                       // pitchEnd   0x7000
        p[5] = 0;    p[6] = 63;                         // volume 0..63
        p[7] = 0x00; p[8] = 0x10; p[9] = 0; p[10] = 0;  // samplePtr 4096
        p[11] = 2048 & 0xFF; p[12] = 2048 >> 8;         // sampleLength
        // playStart 0, loop 0..0
        p[19] = 8363 & 0xFF; p[20] = 8363 >> 8;         // samplingRate
        // detune 0, loopMode 0
        p[24] = 0xFF;                                   // defaultPan: no override
        p[25] = 0;                                      // DNV: no override
        p[30] = 0xFF;                                   // vibWaveform: no override
        audio.uploadInstrumentPatches(1, p);
        System.out.println("patch count = " + audio.getInstrumentPatchCount(1));

        // ── Pattern 0 ──
        int[] pat = new int[512];
        for (int r = 0; r < 64; r++) { pat[r*8+3] = 0xC0; pat[r*8+4] = 0xC0; } // empty vol/pan
        // row 0: note 0x5000 inst 1 vol SET 63
        pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1; pat[3] = 0x3F;
        // row 8: note 0x6800 inst 1 vol SET 63  → must hit the patch
        pat[8*8] = 0x00; pat[8*8+1] = 0x68; pat[8*8+2] = 1; pat[8*8+3] = 0x3F;
        // row 16: note 0x5000 inst 1 again → back to base
        pat[16*8] = 0x00; pat[16*8+1] = 0x50; pat[16*8+2] = 1; pat[16*8+3] = 0x3F;
        // row 24: KEY_OFF
        pat[24*8] = 0x01; pat[24*8+1] = 0x00;
        audio.uploadPattern(0, pat);

        // ── Cue 0: voice 0 → pattern 0, voices 1-19 → 0xFFF; HALT ──
        int[] cue = new int[32];
        cue[0] = 0x0F; cue[10] = 0x0F; cue[20] = 0x0F;  // v0=0x000, v1=0xFFF
        for (int i = 1; i < 10; i++) { cue[i] = 0xFF; cue[10+i] = 0xFF; cue[20+i] = 0xFF; }
        cue[30] = 0x01;                                  // HALT after this cue
        audio.uploadCue(0, cue);

        // ── Configure playhead 0 and play ──
        audio.setTrackerMode(0);
        audio.setBPM(0, 125);
        audio.setTickRate(0, 6);
        audio.setMasterVolume(0, 255);
        audio.setCuePosition(0, 0);
        audio.play(0);

        // ── Poll voice 0 state. Row duration at 125 BPM speed 6 = 120 ms. ──
        Object playhead = ((Object[]) getField(snd, "playheads"))[0];
        Object ts = getField(playhead, "trackerState");
        Object voice = ((Object[]) getField(ts, "voices"))[0];

        boolean okBase1 = false, okPatch = false, okBase2 = false;
        long t0 = System.currentTimeMillis();
        int lastPtr = -1;
        while (System.currentTimeMillis() - t0 < 4000) {
            int ptr     = (Integer) getField(voice, "activeSamplePtr");
            int nv      = (Integer) getField(voice, "noteVal");
            boolean act = (Boolean) getField(voice, "active");
            double rate = (Double)  getField(voice, "playbackRate");
            long ms = System.currentTimeMillis() - t0;
            if (ptr != lastPtr) {
                System.out.printf("t=%4dms active=%b noteVal=0x%04X activePtr=%d rate=%.4f%n",
                                  ms, act, nv, ptr, rate);
                lastPtr = ptr;
            }
            // rows: 0..7 base (note 0x5000), 8..15 patch (0x6800), 16+ base
            if (act && nv == 0x5000 && ptr == 0    && ms < 900)               okBase1 = true;
            if (act && nv == 0x6800 && ptr == 4096 && ms > 1000 && ms < 1850) okPatch = true;
            if (act && nv == 0x5000 && ptr == 0    && ms > 2000 && ms < 2800) okBase2 = true;
            Thread.sleep(10);
        }

        System.out.println("base trigger (row 0):  " + (okBase1 ? "PASS" : "FAIL"));
        System.out.println("patch trigger (row 8): " + (okPatch ? "PASS" : "FAIL"));
        System.out.println("base again (row 16):   " + (okBase2 ? "PASS" : "FAIL"));
        System.out.println((okBase1 && okPatch && okBase2) ? "IXMP: ALL PASS" : "IXMP: FAILURES PRESENT");
        System.exit((okBase1 && okPatch && okBase2) ? 0 : 1);
    }
}
