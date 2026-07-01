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
import java.util.HashMap;

/**
 * Per-patch volume-envelope test (variable-length Ixmp, 2026-06-13).
 *
 * The base instrument carries a SLOW 2 s volume-envelope attack; an Ixmp patch over a
 * pitch rectangle carries its OWN fast 0.1 s attack ('v' block). One voice is triggered
 * first outside the patch rect (slow attack) and later inside it (fast attack). If the
 * engine applies the per-patch envelope, the in-rect note reaches full envelope volume
 * almost immediately while the out-of-rect note is still climbing. If it (wrongly) used
 * the base instrument's envelope for both, the two would rise at the same slow rate.
 *
 * Also round-trips a patch that carries a 'v' block through
 * uploadInstrumentPatches → getInstrumentPatches and asserts byte-exact identity.
 */
public class PatchEnvTest {

    static Object getField(Object o, String name) throws Exception {
        Class<?> c = o.getClass();
        while (c != null) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(o); }
            catch (NoSuchFieldException e) { c = c.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }

    // Build one variable-length patch: common 31 bytes (version i|v) + 54-byte vol-env block.
    static int[] buildPatchWithVolEnv(int attackMinifloat) {
        int[] p = new int[31 + 54];
        p[0] = 0x03;                                   // version: i | v
        p[1] = 0x00; p[2] = 0x60;                      // pitchStart 0x6000
        p[3] = 0x00; p[4] = 0x70;                      // pitchEnd   0x7000
        p[5] = 0;    p[6] = 63;                        // volume 0..63
        // samplePtr 0 (bytes 7-10 already 0)
        p[11] = 2048 & 0xFF; p[12] = 2048 >> 8;        // sampleLength
        p[17] = 2048 & 0xFF; p[18] = 2048 >> 8;        // loopEnd 2048 (loopStart 0)
        p[19] = 8363 & 0xFF; p[20] = 8363 >> 8;        // samplingRate
        p[23] = 1;                                     // loopMode = forward loop (sustain voice)
        p[24] = 0xFF;                                  // defaultPan: no override
        p[25] = 0;                                     // DNV: no override
        p[30] = 0xFF;                                  // vibWaveform: no override
        // 'v' block: LOOP word (P present, no loop) + SUSTAIN word (0) + 25 nodes.
        int o = 31;
        p[o] = 0x00; p[o+1] = 0x20;                    // vol LOOP word = 0x2000 (P)
        p[o+2] = 0x00; p[o+3] = 0x00;                  // vol SUSTAIN word = 0
        // node 0 = (value 0, attack time), node 1.. = (63, hold).
        p[o+4]   = 0;  p[o+5]   = attackMinifloat;
        for (int k = 1; k < 25; k++) { p[o+4 + k*2] = 63; p[o+4 + k*2 + 1] = 0; }
        return p;
    }

    public static void main(String[] args) throws Exception {
        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);

        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(),
                       new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
        AudioAdapter snd = new AudioAdapter(vm);
        vm.getPeripheralTable()[1] = new PeripheralEntry(snd);
        AudioJSR223Delegate audio = new AudioJSR223Delegate(vm);

        // Sample pool: a single 2048-byte ramp at offset 0 (used by base AND patch).
        audio.setSampleBank(0);
        for (int i = 0; i < 2048; i++) snd.poke((long) i, (byte) (i % 256));

        // Base instrument (slot 1) with a SLOW 2 s vol-env attack (0xA0 minifloat).
        int[] inst = new int[256];
        inst[4] = 2048 & 0xFF; inst[5] = 2048 >> 8;    // sample length
        inst[6] = 8363 & 0xFF; inst[7] = 8363 >> 8;    // samplingRate
        inst[12] = 2048 & 0xFF; inst[13] = 2048 >> 8;  // loopEnd 2048 (loopStart 0)
        inst[14] = 1;                                  // sample flags: forward loop (sustain voice)
        inst[15] = 0x00; inst[16] = 0x20;              // vol LOOP word 0x2000 (P)
        inst[21] = 0;    inst[22] = 0xA0;              // vol node 0 = (0, 2 s)
        for (int k = 1; k < 25; k++) { inst[21 + k*2] = 63; inst[21 + k*2 + 1] = 0; }
        for (int k = 0; k < 25; k++) { inst[71 + k*2] = 0x80; inst[121 + k*2] = 0x80; inst[201 + k*2] = 0x80; }
        inst[171] = 255;                               // IGV
        inst[177] = 0x80;                              // default pan centre
        inst[178] = 0x00; inst[179] = 0x50;            // PPC = 0x5000
        inst[182] = 255; inst[183] = 255;              // IFC/IFR off
        inst[186] = 0b10;                              // NNA = continue (note holds)
        audio.uploadInstrument(1, inst);

        // Patch over pitch 0x6000..0x7000 with a FAST 0.1 s attack (0x1A minifloat).
        int[] patch = buildPatchWithVolEnv(0x1A);
        audio.uploadInstrumentPatches(1, patch);

        // --- Round-trip check (variable-length, with 'v' block) ---
        int[] back = audio.getInstrumentPatches(1);
        boolean rtOk = back.length == patch.length;
        if (rtOk) for (int i = 0; i < patch.length; i++) if ((back[i] & 0xFF) != (patch[i] & 0xFF)) { rtOk = false; break; }
        System.out.println("round-trip (v-block, " + patch.length + " bytes): " + (rtOk ? "PASS" : "FAIL"));

        // Pattern 0: row 0 base note 0x5000 (slow), row 8 patch note 0x6800 (fast).
        int[] pat = new int[512];
        for (int r = 0; r < 64; r++) { pat[r*8+3] = 0xC0; pat[r*8+4] = 0xC0; }
        pat[0]    = 0x00; pat[1]    = 0x50; pat[2]    = 1; pat[3]    = 0x3F;   // base
        pat[8*8]  = 0x00; pat[8*8+1]= 0x68; pat[8*8+2]= 1; pat[8*8+3]= 0x3F;   // patch
        audio.uploadPattern(0, pat);

        int[] cue = new int[32];
        cue[0] = 0x0F; cue[10] = 0x0F; cue[20] = 0x0F;
        for (int i = 1; i < 10; i++) { cue[i] = 0xFF; cue[10+i] = 0xFF; cue[20+i] = 0xFF; }
        cue[30] = 0x01;                                // HALT after this cue
        audio.uploadCue(0, cue);

        audio.setTrackerMode(0);
        audio.setBPM(0, 125);
        audio.setTickRate(0, 6);                       // row = 120 ms
        audio.setMasterVolume(0, 255);
        audio.setCuePosition(0, 0);
        audio.play(0);

        Object playhead = ((Object[]) getField(snd, "playheads"))[0];
        Object ts = getField(playhead, "trackerState");
        Object voice = ((Object[]) getField(ts, "voices"))[0];

        // Track the MAX envelope each note reaches. The base note (slow 2 s attack) only
        // holds for the 8 rows before the patch note replaces it on voice 0, so it never
        // climbs far; the patch note (fast 0.1 s attack) holds for the rest of the pattern
        // and completes its attack. (The null AL backend's non-realtime clock affects both
        // notes equally, so this comparison is rate-independent.)
        double baseMaxEnv = 0, patchMaxEnv = 0;
        long t0 = System.currentTimeMillis();
        while (System.currentTimeMillis() - t0 < 4000) {
            int nv = (Integer) getField(voice, "noteVal");
            boolean act = (Boolean) getField(voice, "active");
            double env = (Double) getField(voice, "envVolume");
            if (act && nv == 0x5000) baseMaxEnv = Math.max(baseMaxEnv, env);
            if (act && nv == 0x6800) patchMaxEnv = Math.max(patchMaxEnv, env);
            Thread.sleep(3);
        }

        System.out.printf("base note  max env (2 s attack, 8-row window): %.3f (expect < 0.5)%n", baseMaxEnv);
        System.out.printf("patch note max env (0.1 s attack, holds):      %.3f (expect > 0.95)%n", patchMaxEnv);
        boolean slowOk = baseMaxEnv < 0.5;        // slow attack never gets far in its short window
        boolean fastOk = patchMaxEnv > 0.95;      // fast attack completes (per-patch env applied)
        System.out.println("base slow attack:  " + (slowOk ? "PASS" : "FAIL"));
        System.out.println("patch fast attack: " + (fastOk ? "PASS" : "FAIL"));
        boolean all = rtOk && slowOk && fastOk;
        System.out.println(all ? "PATCHENV: ALL PASS" : "PATCHENV: FAILURES PRESENT");
        System.exit(all ? 0 : 1);
    }
}
