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
 * Headless test for the Metainstrument layer-child KEY_OFF race (fixed 2026-06-15).
 *
 * A released meta note must release ALL its layers, not just the foreground (layer 0).
 * Layer children inherit the parent's key-off via the per-tick background-voice sync, but
 * only while the parent is still ACTIVE. When the foreground layer has a FAST volume
 * fadeout (e.g. fo=4095 / 1067 — a ~1-tick cut, which SF2 presets with a short releaseVolEnv
 * routinely get), the parent voice deactivates in the SAME tick the KEY_OFF fires — before
 * the sync runs — so the child was detached as an orphan that never picked up the release
 * and rang on, looping at its sustain level, until the next note displaced it. Symptom:
 * long tails on multi-layer SF2 presets with a short release, e.g. Timbres of Heaven's
 * sustained "Ult. Overdriven Gt." (37 zones -> 4 layers; reported "decays extremely slowly").
 *
 *   inst1 -> sample A @0   ; inst2 -> sample B @4096   (looping + FAST fadeout fo=4095)
 *   inst3 = layered { L0: inst1 oct0 ; L1: inst2 +1oct }
 *   row 0  note 0x5000 inst3 V63 -> fg inst1 + child inst2 (both looping/sustaining)
 *   row 16 KEY_OFF               -> fg fades out in ~1 tick; the child MUST also key-off
 *                                   and fade, not ring on.
 *
 * MetaTest already covers the slow/zero-fadeout case (parent survives, child inherits via
 * the active branch); this test covers the fast-fadeout race the fix added.
 */
public class MetaKeyOffFadeTest {

    static Object getField(Object o, String name) throws Exception {
        Class<?> c = o.getClass();
        while (c != null) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(o); }
            catch (NoSuchFieldException e) { c = c.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }

    // backgroundVoices is a kotlin.collections.ArrayDeque (implements Iterable).
    static Object firstLayerChild(Object ts, int ch) throws Exception {
        for (Object v : (Iterable<?>) getField(ts, "backgroundVoices"))
            if ((Boolean) getField(v, "isLayerChild") && (Integer) getField(v, "sourceChannel") == ch
                && (Boolean) getField(v, "active")) return v;
        return null;
    }

    /** Count any background voice that ORIGINATED on channel [ch] and is still active —
     *  including detached orphans (isLayerChild cleared), which is exactly what a ringing
     *  unreleased layer child becomes. */
    static int activeBgFromChannel(Object ts, int ch) throws Exception {
        int n = 0;
        for (Object v : (Iterable<?>) getField(ts, "backgroundVoices"))
            if ((Integer) getField(v, "sourceChannel") == ch && (Boolean) getField(v, "active")) n++;
        return n;
    }

    /** A looping single-sample instrument with a FAST volume fadeout (fo=4095, a ~1-tick
     *  cut) and NNA = Note Fade, so a key-off deactivates the voice within a tick. */
    static int[] normalInstFast(int ptr, int len) {
        int[] inst = new int[256];
        inst[0] = ptr & 0xFF; inst[1] = (ptr >> 8) & 0xFF; inst[2] = (ptr >> 16) & 0xFF; inst[3] = (ptr >> 24) & 0xFF;
        inst[4] = len & 0xFF; inst[5] = (len >> 8) & 0xFF;
        inst[6] = 8363 & 0xFF; inst[7] = 8363 >> 8;
        inst[12] = len & 0xFF; inst[13] = (len >> 8) & 0xFF;   // loop end
        inst[14] = 1;                                          // forward loop (sustains forever)
        inst[15] = 0x20; inst[16] = 0x20;                      // vol LOOP word b|P (sustain)
        inst[21] = 63;
        for (int k = 0; k < 25; k++) { inst[71 + k*2] = 0x80; inst[121 + k*2] = 0x80; }
        inst[171] = 255;                                       // IGV
        inst[172] = 0xFF; inst[173] = 0x0F;                    // Volume Fadeout = 0xFFF (1-tick cut)
        inst[177] = 0x80; inst[178] = 0x00; inst[179] = 0x50;
        inst[182] = 255; inst[183] = 255; inst[186] = 0b11;    // NNA = Note Fade
        return inst;
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

    public static void main(String[] args) throws Exception {
        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);
        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(),
                       new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
        AudioAdapter snd = new AudioAdapter(vm);
        vm.getPeripheralTable()[1] = new PeripheralEntry(snd);
        AudioJSR223Delegate audio = new AudioJSR223Delegate(vm);

        audio.setSampleBank(0);
        for (int i = 0; i < 2048; i++) {
            snd.poke((long) i,        (byte) (i % 256));
            snd.poke((long) (4096+i), (byte) (255 - (i % 256)));
        }
        audio.uploadInstrument(1, normalInstFast(0, 2048));
        audio.uploadInstrument(2, normalInstFast(4096, 2048));
        audio.uploadInstrument(3, metaInst(new int[][]{
            {1, 159, 0,    0x0000, 0xFFFF, 0x00, 0x3F},
            {2, 159, 4096, 0x0000, 0xFFFF, 0x00, 0x3F},
        }));

        int[] pat = new int[512];
        for (int r = 0; r < 64; r++) { pat[r*8+3] = 0xC0; pat[r*8+4] = 0xC0; }
        pat[0]    = 0x00; pat[1]    = 0x50; pat[2]    = 3; pat[3]    = 0x3F;   // note 0x5000 inst3 V63
        pat[16*8] = 0x01; pat[16*8+1]= 0x00;                                   // KEY_OFF
        audio.uploadPattern(0, pat);

        int[] cue = new int[32];
        cue[0] = 0x0F; cue[10] = 0x0F; cue[20] = 0x0F;
        for (int i = 1; i < 10; i++) { cue[i] = 0xFF; cue[10+i] = 0xFF; cue[20+i] = 0xFF; }
        cue[30] = 0x01;
        audio.uploadCue(0, cue);

        audio.setTrackerMode(0);
        audio.setBPM(0, 125); audio.setTickRate(0, 6);
        audio.setMasterVolume(0, 255); audio.setCuePosition(0, 0);

        Object playhead = ((Object[]) getField(snd, "playheads"))[0];
        Object ts = getField(playhead, "trackerState");
        Object fg = ((Object[]) getField(ts, "voices"))[0];

        Method genAudio = null;
        for (Method m : snd.getClass().getDeclaredMethods())
            if (m.getName().contains("generateTrackerAudio")) { genAudio = m; break; }
        if (genAudio == null) { System.out.println("generateTrackerAudio not found"); System.exit(2); }
        genAudio.setAccessible(true);

        final int SPR = 3840;  // samples/row = 32000 * 2.5/125 * 6
        long samples = 0;
        boolean okFanout = false;          // before key-off: a layer child sounds
        Object child = null;               // captured child reference (survives detach/removal)
        boolean okChildKeyoff = false;     // after key-off: child picked up the release
        boolean ringAfter = false;         // after key-off: any voice from ch0 still ringing

        while (samples < 30L * SPR) {
            Object ret = genAudio.invoke(snd, playhead);
            if (ret == null) break;
            samples += 512;
            int row = (int) (samples / SPR);

            if (row >= 2 && row <= 14) {
                Object c = firstLayerChild(ts, 0);
                if (c != null) { child = c; okFanout = true; }
            } else if (row >= 24 && row <= 29) {
                // Well after the row-16 KEY_OFF: the foreground has fast-faded out; the child
                // must have keyed off too and stopped sounding (no orphaned ring).
                if (child != null && (Boolean) getField(child, "keyOff")) okChildKeyoff = true;
                if (activeBgFromChannel(ts, 0) > 0) ringAfter = true;
            }
        }

        boolean fgGone = !(Boolean) getField(fg, "active");
        System.out.println("fan-out before key-off (child sounds):    " + (okFanout ? "PASS" : "FAIL"));
        System.out.println("foreground faded out after key-off:       " + (fgGone ? "PASS" : "FAIL"));
        System.out.println("child inherited key-off (not orphaned):   " + (okChildKeyoff ? "PASS" : "FAIL"));
        System.out.println("no layer child rings on after key-off:    " + (!ringAfter ? "PASS" : "FAIL"));
        boolean all = okFanout && fgGone && okChildKeyoff && !ringAfter;
        System.out.println(all ? "META-KEYOFF-FADE: ALL PASS" : "META-KEYOFF-FADE: FAILURES PRESENT");
        System.exit(all ? 0 : 1);
    }
}
