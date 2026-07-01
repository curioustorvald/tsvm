import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.backends.lwjgl3.audio.OpenALLwjgl3Audio;
import net.torvald.tsvm.*;
import net.torvald.tsvm.peripheral.AudioAdapter;
import net.torvald.tsvm.peripheral.VMProgramRom;

import java.lang.reflect.Field;
import java.util.HashMap;

/**
 * Key Lift (instrument flag byte 186 bit 5, NNA pattern 0b100) behavioural test.
 *
 * Two identical instruments mimic an SF2 guitar envelope — hold ≈ 4.5 s,
 * slow decay to sustain node 2 (value 40), release ≈ 0.43 s — except slot 1
 * has Key Lift and slot 2 has traditional NNA Note Off. Both voices play the
 * same two-note line (retrigger at row 2 → NNA ghost; explicit KEY_OFF at
 * row 12). MIDI-correct behaviour: the released note's envelope jumps to the
 * release nodes and dies in ~0.45 s. IT note-off behaviour: the envelope
 * still walks ~4.5 s of hold first — the "sustain pedal" bug.
 *
 * PASS: keylift ghost+foreground envVolume ≈ 0 within 0.7 s of release,
 *       while the plain instrument's are still ≥ 0.8.
 */
public class KeyLiftTest {

    static Object getField(Object o, String name) throws Exception {
        Class<?> c = o.getClass();
        while (c != null) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(o); }
            catch (NoSuchFieldException e) { c = c.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }

    static int[] makeInst(int flag186) {
        int[] inst = new int[256];
        inst[4] = 2048 & 0xFF; inst[5] = 2048 >> 8;          // length
        inst[6] = 8363 & 0xFF; inst[7] = 8363 >> 8;          // rate
        inst[10] = 0; inst[12] = 0; inst[13] = 8;            // loop 0..2048
        inst[14] = 1;                                        // forward loop
        inst[15] = 0x00; inst[16] = 0x20;                    // vol LOOP word: P only
        // env nodes: (63,~4.5s) (54,~1.25s) (40,~0.13s)=sustain (12,~0.3s) (0,0)
        int[][] env = { {63,196}, {54,136}, {40,32}, {12,70}, {0,0} };
        for (int k = 0; k < env.length; k++) {
            inst[21 + k*2] = env[k][0]; inst[22 + k*2] = env[k][1];
        }
        for (int k = 0; k < 25; k++) { inst[71 + k*2] = 0x80; inst[121 + k*2] = 0x80; }
        inst[171] = 255;
        inst[172] = 4;                                       // slow safety fade
        inst[177] = 0x80;
        inst[178] = 0x00; inst[179] = 0x50;
        inst[182] = 255; inst[183] = 255;
        inst[186] = flag186;
        inst[189] = 0x22; inst[190] = 0x02;                  // SUSTAIN: b, node 2..2
        inst[196] = 255;
        return inst;
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

        audio.uploadInstrument(1, makeInst(0b100000));       // Key Lift
        audio.uploadInstrument(2, makeInst(0b000000));       // traditional Note Off

        // Pattern per voice: row0 trigger, row2 retrigger (NNA), row12 KEY_OFF.
        for (int slot = 1; slot <= 2; slot++) {
            int[] pat = new int[512];
            for (int r = 0; r < 64; r++) { pat[r*8+3] = 0xC0; pat[r*8+4] = 0xC0; }
            pat[0] = 0x00; pat[1] = 0x50; pat[2] = slot; pat[3] = 0x3F;
            pat[2*8] = 0x00; pat[2*8+1] = 0x48; pat[2*8+2] = slot; pat[2*8+3] = 0x3F;
            pat[12*8] = 0x01;                                 // KEY_OFF
            audio.uploadPattern(slot - 1, pat);
        }
        int[] cue = new int[32];
        cue[0] = 0x01; cue[10] = 0x00; cue[20] = 0x00;        // v0=pat0, v1=pat1
        for (int i = 1; i < 10; i++) { cue[i] = 0xFF; cue[10+i] = 0xFF; cue[20+i] = 0xFF; }
        cue[30] = 0x01;                                       // HALT
        audio.uploadCue(0, cue);

        audio.setTrackerMode(0);
        audio.setBPM(0, 125);                                 // row = 120 ms
        audio.setTickRate(0, 6);
        audio.setMasterVolume(0, 255);
        audio.setCuePosition(0, 0);
        audio.play(0);

        Object playhead = ((Object[]) getField(snd, "playheads"))[0];
        Object ts = getField(playhead, "trackerState");
        Object[] voices = (Object[]) getField(ts, "voices");

        // Sample ghost + foreground envelopes at the two checkpoints:
        //   t≈900 ms  (0.66 s after the row-2 NNA release)
        //   t≈2150 ms (0.71 s after the row-12 KEY_OFF)
        double ghostLift = -1, ghostPlain = -1, fgLift = -1, fgPlain = -1;
        long t0 = System.currentTimeMillis();
        while (System.currentTimeMillis() - t0 < 3000) {
            long ms = System.currentTimeMillis() - t0;
            if (ms >= 900 && ghostLift < 0) {
                ghostLift = ghostPlain = 0;
                Iterable<?> bgs = (Iterable<?>) getField(ts, "backgroundVoices");
                for (Object bg : bgs) {
                    int ch = (Integer) getField(bg, "sourceChannel");
                    boolean act = (Boolean) getField(bg, "active");
                    double ev = (Double) getField(bg, "envVolume")
                              * (Double) getField(bg, "fadeoutVolume");
                    if (!act) ev = 0;
                    if (ch == 0) ghostLift  = Math.max(ghostLift,  ev);
                    if (ch == 1) ghostPlain = Math.max(ghostPlain, ev);
                }
                System.out.printf("t=%dms ghost env×fade: keylift=%.3f plain=%.3f%n",
                                  ms, ghostLift, ghostPlain);
            }
            if (ms >= 2150 && fgLift < 0) {
                boolean a0 = (Boolean) getField(voices[0], "active");
                boolean a1 = (Boolean) getField(voices[1], "active");
                fgLift  = a0 ? (Double) getField(voices[0], "envVolume")
                             * (Double) getField(voices[0], "fadeoutVolume") : 0;
                fgPlain = a1 ? (Double) getField(voices[1], "envVolume")
                             * (Double) getField(voices[1], "fadeoutVolume") : 0;
                System.out.printf("t=%dms foreground env×fade after KEY_OFF: "
                                  + "keylift=%.3f plain=%.3f%n", ms, fgLift, fgPlain);
                break;
            }
            Thread.sleep(5);
        }

        boolean ok = ghostLift >= 0 && ghostLift < 0.05 && ghostPlain > 0.8
                  && fgLift    >= 0 && fgLift    < 0.05 && fgPlain    > 0.8;
        System.out.println("ghost release (NNA):    " + (ghostLift < 0.05 && ghostPlain > 0.8 ? "PASS" : "FAIL"));
        System.out.println("foreground (KEY_OFF):   " + (fgLift < 0.05 && fgPlain > 0.8 ? "PASS" : "FAIL"));
        System.out.println(ok ? "KEYLIFT: ALL PASS" : "KEYLIFT: FAIL");
        System.exit(ok ? 0 : 1);
    }
}
