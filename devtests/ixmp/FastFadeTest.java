import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.backends.lwjgl3.audio.OpenALLwjgl3Audio;
import net.torvald.tsvm.*;
import net.torvald.tsvm.peripheral.AudioAdapter;
import net.torvald.tsvm.peripheral.VMProgramRom;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashMap;

/**
 * Fast note-fade (note word 0x0004) behavioural test — the engine half of the SF2
 * exclusiveClass percussion choke that midi2taud emits (a closed hi-hat silencing a
 * ringing open hi-hat). Models FluidSynth's fluid_voice_kill_excl: a quick (~0.3 s)
 * note-fade while the sample keeps playing, distinct from ^^CUT's hard stop.
 *
 * Two voices play the SAME looping, long-hold instrument (it rings at full level for
 * seconds). At row 12 voice 0 gets note 0x0004; voice 1 (control) gets nothing.
 *
 * PASS:
 *   - both voices ring at full before row 12 (env×fade > 0.8),
 *   - voice 0 falls to silence (env×fade < 0.05) within ~0.5 s of the fast-fade,
 *   - voice 1 is STILL ringing then (env×fade > 0.8) — the fade is voice-local,
 *   - the fall is GRADUAL (≥3 chunks from half to zero), proving a fade not a cut.
 *
 * Driven SYNCHRONOUSLY (generateTrackerAudio on the test thread) for determinism.
 */
public class FastFadeTest {

    static Object getField(Object o, String name) throws Exception {
        Class<?> c = o.getClass();
        while (c != null) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(o); }
            catch (NoSuchFieldException e) { c = c.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }

    // Looping sample, vol-env holds ≈63 for several seconds (well past the test window).
    static int[] makeInst() {
        int[] inst = new int[256];
        inst[4] = 2048 & 0xFF; inst[5] = 2048 >> 8;          // length 2048
        inst[6] = 8363 & 0xFF; inst[7] = 8363 >> 8;          // rate
        inst[10] = 0; inst[12] = 0; inst[13] = 8;            // loop 0..2048
        inst[14] = 1;                                        // forward loop
        inst[15] = 0x00; inst[16] = 0x20;                    // vol LOOP word: P only
        // env nodes: (63,~4.5s) (54,~1.25s) (40,~0.13s)=sustain (12,~0.3s) (0,0)
        int[][] env = { {63,196}, {54,136}, {40,32}, {12,70}, {0,0} };
        for (int k = 0; k < env.length; k++) { inst[21 + k*2] = env[k][0]; inst[22 + k*2] = env[k][1]; }
        for (int k = 0; k < 25; k++) { inst[71 + k*2] = 0x80; inst[121 + k*2] = 0x80; }
        inst[171] = 255;
        inst[172] = 0;                                       // no instrument fadeout (control must not fade)
        inst[177] = 0x80;
        inst[178] = 0x00; inst[179] = 0x50;
        inst[182] = 255; inst[183] = 255;
        inst[186] = 0b000000;                                // NNA Note Off (irrelevant — no retrigger)
        inst[189] = 0x22; inst[190] = 0x02;                  // SUSTAIN: node 2..2
        inst[196] = 255;
        return inst;
    }

    static double envFade(Object v) throws Exception {
        if (!(Boolean) getField(v, "active")) return 0.0;
        return (Double) getField(v, "envVolume") * (Double) getField(v, "fadeoutVolume");
    }

    public static void main(String[] args) throws Exception {
        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);
        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(),
                       new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
        AudioAdapter snd = new AudioAdapter(vm);
        vm.getPeripheralTable()[1] = new PeripheralEntry(snd);
        AudioJSR223Delegate audio = new AudioJSR223Delegate(vm);

        audio.setSampleBank(0);
        for (int i = 0; i < 2048; i++) snd.poke((long) i, (byte) (i % 256));
        audio.uploadInstrument(1, makeInst());

        // voice 0: trigger row 0, fast-fade (0x0004) row 12.  voice 1: trigger only.
        int[] p0 = new int[512], p1 = new int[512];
        for (int r = 0; r < 64; r++) { p0[r*8+3]=0xC0; p0[r*8+4]=0xC0; p1[r*8+3]=0xC0; p1[r*8+4]=0xC0; }
        p0[0]=0x00; p0[1]=0x50; p0[2]=1; p0[3]=0x3F;          // trigger 0x5000 inst1 vol3F
        p0[12*8]=0x04; p0[12*8+1]=0x00;                       // note 0x0004 = fast fade
        p1[0]=0x00; p1[1]=0x50; p1[2]=1; p1[3]=0x3F;
        audio.uploadPattern(0, p0);
        audio.uploadPattern(1, p1);

        int[] cue = new int[32];
        cue[0] = 0x01; cue[10] = 0x00; cue[20] = 0x00;        // v0=pat0, v1=pat1
        for (int i = 1; i < 10; i++) { cue[i]=0xFF; cue[10+i]=0xFF; cue[20+i]=0xFF; }
        cue[30] = 0x01;                                       // HALT at end of cue
        audio.uploadCue(0, cue);

        audio.setTrackerMode(0);
        audio.setBPM(0, 125);                                 // row = 120 ms = 7.5 chunks
        audio.setTickRate(0, 6);
        audio.setMasterVolume(0, 255);
        audio.setCuePosition(0, 0);

        Object playhead = ((Object[]) getField(snd, "playheads"))[0];
        Object ts = getField(playhead, "trackerState");
        Object[] voices = (Object[]) getField(ts, "voices");
        Method genAudio = null;
        for (Method m : snd.getClass().getDeclaredMethods())
            if (m.getName().contains("generateTrackerAudio")) { genAudio = m; break; }
        genAudio.setAccessible(true);

        // row 12 ≈ chunk 90 (7.5 chunks/row). Sample env×fade across the fade.
        double v0Before = -1, v1Before = -1;
        int firstBelow50 = -1, firstBelow05 = -1;
        double v0After = -1, v1After = -1;
        for (int chunk = 0; chunk < 180; chunk++) {
            if (genAudio.invoke(snd, playhead) == null) break;
            double v0 = envFade(voices[0]), v1 = envFade(voices[1]);
            if (chunk == 88) { v0Before = v0; v1Before = v1; }
            if (chunk > 90) {
                if (firstBelow50 < 0 && v0 < 0.5) firstBelow50 = chunk;
                if (firstBelow05 < 0 && v0 < 0.05) firstBelow05 = chunk;
            }
            if (chunk == 140) { v0After = v0; v1After = v1; }
        }

        System.out.printf("before fade (chunk88): v0=%.3f v1=%.3f%n", v0Before, v1Before);
        System.out.printf("fade crossings: <0.5 @chunk %d, <0.05 @chunk %d (row12≈chunk90)%n",
                          firstBelow50, firstBelow05);
        System.out.printf("after fade (chunk140): v0=%.3f v1=%.3f%n", v0After, v1After);

        boolean rang   = v0Before > 0.8 && v1Before > 0.8;
        boolean faded  = v0After >= 0 && v0After < 0.05;
        boolean local  = v1After > 0.8;                                   // control still ringing
        boolean fast   = firstBelow05 >= 0 && (firstBelow05 - 90) <= 40;  // done within ~0.6 s
        boolean gradual = firstBelow50 >= 0 && firstBelow05 >= 0 && (firstBelow05 - firstBelow50) >= 3;

        System.out.println("both rang before:       " + (rang   ? "PASS" : "FAIL"));
        System.out.println("voice 0 fast-faded:     " + (faded  ? "PASS" : "FAIL"));
        System.out.println("control still ringing:  " + (local  ? "PASS" : "FAIL"));
        System.out.println("fade is quick:          " + (fast   ? "PASS" : "FAIL"));
        System.out.println("fade is gradual (≠cut): " + (gradual? "PASS" : "FAIL"));
        boolean ok = rang && faded && local && fast && gradual;
        System.out.println(ok ? "FASTFADE: ALL PASS" : "FASTFADE: FAIL");
        System.exit(ok ? 0 : 1);
    }
}
