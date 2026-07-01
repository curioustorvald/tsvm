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
 * Headless test for Metainstrument layering (terranmon.txt "Metainstrument definition").
 * Drives the engine SYNCHRONOUSLY (calls generateTrackerAudio on this thread) so the
 * background-voice pool can be inspected without racing the render thread.
 *
 *   inst1 -> sample A @0   ; inst2 -> sample B @4096   (looping, so voices sustain)
 *   inst3 = layered { L0: inst1 oct0 unity full ; L1: inst2 +1oct mix=111(-6dB) full }
 *   inst4 = layered { L0: inst1 full ; L1: inst2 +1oct vol 0x30..0x3F (high-velocity only) }
 *   row 0  note 0x5000 inst3 V63 -> fg inst1@0x5000/ptr0 + child inst2@0x6000/ptr4096 gain~0.5
 *   row 16 note 0x5000 inst4 V16 -> fg only (low velocity gates L1 out)
 *   row 32 note 0x5000 inst4 V63 -> fg + 1 child (high velocity)
 *   row 48 KEY_OFF               -> fg + child both keyOff
 */
public class MetaTest {

    static Object getField(Object o, String name) throws Exception {
        Class<?> c = o.getClass();
        while (c != null) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(o); }
            catch (NoSuchFieldException e) { c = c.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }

    // backgroundVoices is a kotlin.collections.ArrayDeque (implements Iterable).
    // Safe to iterate here because the test drives the render synchronously.
    static int countLayerChildren(Object ts, int ch) throws Exception {
        int n = 0;
        for (Object v : (Iterable<?>) getField(ts, "backgroundVoices"))
            if ((Boolean) getField(v, "isLayerChild") && (Integer) getField(v, "sourceChannel") == ch
                && (Boolean) getField(v, "active")) n++;
        return n;
    }

    static Object firstLayerChild(Object ts, int ch) throws Exception {
        for (Object v : (Iterable<?>) getField(ts, "backgroundVoices"))
            if ((Boolean) getField(v, "isLayerChild") && (Integer) getField(v, "sourceChannel") == ch
                && (Boolean) getField(v, "active")) return v;
        return null;
    }

    /** A looping single-sample instrument so voices sustain across the whole song. */
    static int[] normalInst(int ptr, int len) {
        int[] inst = new int[256];
        inst[0] = ptr & 0xFF; inst[1] = (ptr >> 8) & 0xFF; inst[2] = (ptr >> 16) & 0xFF; inst[3] = (ptr >> 24) & 0xFF;
        inst[4] = len & 0xFF; inst[5] = (len >> 8) & 0xFF;
        inst[6] = 8363 & 0xFF; inst[7] = 8363 >> 8;
        inst[12] = len & 0xFF; inst[13] = (len >> 8) & 0xFF;   // loop end
        inst[14] = 1;                                          // forward loop
        inst[15] = 0x20; inst[16] = 0x20;                      // vol LOOP word b|P
        inst[21] = 63;
        for (int k = 0; k < 25; k++) { inst[71 + k*2] = 0x80; inst[121 + k*2] = 0x80; }
        inst[171] = 255; inst[177] = 0x80; inst[178] = 0x00; inst[179] = 0x50;
        inst[182] = 255; inst[183] = 255; inst[186] = 0b10;    // NNA continue
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
        audio.uploadInstrument(1, normalInst(0, 2048));
        audio.uploadInstrument(2, normalInst(4096, 2048));
        audio.uploadInstrument(3, metaInst(new int[][]{
            {1, 159, 0,    0x0000, 0xFFFF, 0x00, 0x3F},
            {2, 111, 4096, 0x0000, 0xFFFF, 0x00, 0x3F},
        }));
        audio.uploadInstrument(4, metaInst(new int[][]{
            {1, 159, 0,    0x0000, 0xFFFF, 0x00, 0x3F},
            {2, 159, 4096, 0x0000, 0xFFFF, 0x30, 0x3F},
        }));

        int[] pat = new int[512];
        for (int r = 0; r < 64; r++) { pat[r*8+3] = 0xC0; pat[r*8+4] = 0xC0; }
        pat[0]    = 0x00; pat[1]    = 0x50; pat[2]    = 3; pat[3]    = 0x3F;
        pat[16*8] = 0x00; pat[16*8+1]= 0x50; pat[16*8+2]= 4; pat[16*8+3]= 0x10;
        pat[32*8] = 0x00; pat[32*8+1]= 0x50; pat[32*8+2]= 4; pat[32*8+3]= 0x3F;
        pat[48*8] = 0x01; pat[48*8+1]= 0x00;
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

        Object[] insts = (Object[]) getField(snd, "instruments");
        for (int s = 3; s <= 4; s++) {
            Object ml = getField(insts[s], "metaLayers");
            System.out.println("inst" + s + ".metaLayers = "
                + (ml == null ? "null" : java.lang.reflect.Array.getLength(ml)));
        }

        // Resolve the internal render entry point and drive it synchronously.
        Method genAudio = null;
        for (Method m : snd.getClass().getDeclaredMethods())
            if (m.getName().contains("generateTrackerAudio")) { genAudio = m; break; }
        if (genAudio == null) { System.out.println("generateTrackerAudio not found"); System.exit(2); }
        genAudio.setAccessible(true);

        final int SPR = 3840;  // samples/row = 32000 * 2.5/125 * 6
        long samples = 0;
        boolean okFanout=false, okChildPitch=false, okChildSample=false, okChildGain=false;
        boolean okLowVel=false, okHighVel=false, okKeyoffFg=false, okKeyoffChild=false;

        while (samples < 53L * SPR) {
            Object ret = genAudio.invoke(snd, playhead);
            if (ret == null) break;
            samples += 512;
            int row = (int) (samples / SPR);
            int fgInst = (Integer) getField(fg, "instrumentId");
            int fgNv   = (Integer) getField(fg, "noteVal");
            int fgPtr  = (Integer) getField(fg, "activeSamplePtr");
            boolean fgKey = (Boolean) getField(fg, "keyOff");
            int lc = countLayerChildren(ts, 0);
            Object ch = firstLayerChild(ts, 0);

            if (row >= 2 && row <= 14) {
                if (lc == 1 && fgInst == 1 && fgNv == 0x5000 && fgPtr == 0) okFanout = true;
                if (ch != null) {
                    if ((Integer) getField(ch, "noteVal") == 0x6000) okChildPitch = true;
                    if ((Integer) getField(ch, "activeSamplePtr") == 4096) okChildSample = true;
                    if (Math.abs((Double) getField(ch, "layerMixGain") - 0.501187) < 0.01) okChildGain = true;
                }
            } else if (row >= 18 && row <= 30) {
                if (lc == 0 && fgInst == 1) okLowVel = true;
            } else if (row >= 34 && row <= 46) {
                if (lc == 1) okHighVel = true;
            } else if (row >= 49) {
                if (fgKey) okKeyoffFg = true;
                if (ch != null && (Boolean) getField(ch, "keyOff")) okKeyoffChild = true;
            }
        }

        System.out.println("fan-out (2 voices from 1 meta trigger): " + (okFanout ? "PASS" : "FAIL"));
        System.out.println("child pitch tracks +1oct detune:        " + (okChildPitch ? "PASS" : "FAIL"));
        System.out.println("child plays distinct sample (ptr 4096): " + (okChildSample ? "PASS" : "FAIL"));
        System.out.println("child mix gain ~-6 dB (octet 111):      " + (okChildGain ? "PASS" : "FAIL"));
        System.out.println("velocity gate: low V -> layer absent:   " + (okLowVel ? "PASS" : "FAIL"));
        System.out.println("velocity gate: high V -> layer present: " + (okHighVel ? "PASS" : "FAIL"));
        System.out.println("key-off propagates to foreground:       " + (okKeyoffFg ? "PASS" : "FAIL"));
        System.out.println("key-off propagates to layer child:      " + (okKeyoffChild ? "PASS" : "FAIL"));
        boolean all = okFanout && okChildPitch && okChildSample && okChildGain
                   && okLowVel && okHighVel && okKeyoffFg && okKeyoffChild;
        System.out.println(all ? "META: ALL PASS" : "META: FAILURES PRESENT");
        System.exit(all ? 0 : 1);
    }
}
