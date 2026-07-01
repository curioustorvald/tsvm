import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.backends.lwjgl3.audio.OpenALLwjgl3Audio;
import net.torvald.tsvm.AudioJSR223Delegate;
import net.torvald.tsvm.CompressorDelegate;
import net.torvald.tsvm.PeripheralEntry;
import net.torvald.tsvm.TheRealWorld;
import net.torvald.tsvm.VM;
import net.torvald.tsvm.VMWatchdog;
import net.torvald.tsvm.peripheral.AudioAdapter;
import net.torvald.tsvm.peripheral.VMProgramRom;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;

/** Probe: for the named instrument, when a foreground voice ends after a long sustain,
 *  print its note + sample geometry + envelope so we can see WHY it held. */
public class DrumProbe {
    static Object getField(Object o, String name) throws Exception {
        Class<?> c = o.getClass();
        while (c != null) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(o); }
            catch (NoSuchFieldException e) { c = c.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }
    static int u8 (byte[] b, int o) { return b[o] & 0xFF; }
    static int u16(byte[] b, int o) { return u8(b,o) | (u8(b,o+1) << 8); }
    static int u32(byte[] b, int o) { return u8(b,o) | (u8(b,o+1)<<8) | (u8(b,o+2)<<16) | (u8(b,o+3)<<24); }
    static int gi(Object v, String f) throws Exception { return (Integer) getField(v, f); }
    static long gl(Object v, String f) throws Exception { Object x=getField(v,f); return ((Number)x).longValue(); }
    static boolean gb(Object v, String f) throws Exception { return (Boolean) getField(v, f); }
    static double gd(Object v, String f) throws Exception { return (Double) getField(v, f); }

    public static void main(String[] args) throws Exception {
        String path = args[0];
        int watchInst = Integer.parseInt(args[1]);
        byte[] file = Files.readAllBytes(Paths.get(path));

        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);
        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(), new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
        AudioAdapter snd = new AudioAdapter(vm);
        vm.getPeripheralTable()[1] = new PeripheralEntry(snd);
        AudioJSR223Delegate audio = new AudioJSR223Delegate(vm);

        int compSize = u32(file, 10), projOff = u32(file, 14);
        long filePtr = 256;
        for (int i = 0; i < file.length; i++) vm.poke(filePtr + i, file[i]);
        audio.uploadSampleInstBlob((int) filePtr + 32, compSize);
        audio.setSampleBank(0);

        int entryOff = 32 + compSize;
        int songOffset = u32(file, entryOff);
        int bpm = u8(file, entryOff + 7) + 25, tickRate = u8(file, entryOff + 8);
        int numPats = u16(file, entryOff + 5);
        int patComp = u32(file, entryOff + 18), cueComp = u32(file, entryOff + 22);
        byte[] patBin = CompressorDelegate.Companion.decomp(java.util.Arrays.copyOfRange(file, songOffset, songOffset + patComp));
        byte[] cueBin = CompressorDelegate.Companion.decomp(java.util.Arrays.copyOfRange(file, songOffset + patComp, songOffset + patComp + cueComp));
        int[] tmp = new int[512];
        for (int pIdx = 0; pIdx < numPats; pIdx++) { for (int k = 0; k < 512; k++) tmp[k] = u8(patBin, pIdx * 512 + k); audio.uploadPattern(pIdx, tmp); }
        int[] ctmp = new int[32];
        for (int c = 0; c < cueBin.length / 32; c++) { for (int k = 0; k < 32; k++) ctmp[k] = u8(cueBin, c * 32 + k); audio.uploadCue(c, ctmp); }
        audio.setTrackerMode(0); audio.setBPM(0, bpm); audio.setTickRate(0, tickRate > 0 ? tickRate : 6); audio.setMasterVolume(0, 255);

        if (projOff != 0) {
            int p = projOff + 16;
            while (p + 8 <= file.length) {
                String fc = new String(file, p, 4, "latin1");
                int secLen = u32(file, p + 4), payload = p + 8;
                if (fc.equals("Ixmp")) {
                    int q = payload, qEnd = payload + secLen;
                    while (q + 4 <= qEnd) {
                        int instId = u8(file, q); q++;
                        int cnt = u8(file,q) | (u8(file,q+1)<<8) | (u8(file,q+2)<<16); q += 3;
                        int o = q;
                        for (int i = 0; i < cnt; i++) { int ver = u8(file, o);
                            o += 31 + (((ver&0x80)!=0)?15:0) + (((ver&0x02)!=0)?54:0) + (((ver&0x04)!=0)?54:0) + (((ver&0x08)!=0)?54:0) + (((ver&0x10)!=0)?54:0); }
                        int blobLen = o - q; int[] buf = new int[blobLen];
                        for (int k = 0; k < blobLen; k++) buf[k] = u8(file, q + k);
                        audio.uploadInstrumentPatches(instId, buf); q += blobLen;
                    }
                }
                p = payload + secLen;
            }
        }

        audio.setCuePosition(0, 0);
        Object playhead = ((Object[]) getField(snd, "playheads"))[0];
        Object ts = getField(playhead, "trackerState");
        Method genAudio = null;
        for (Method m : snd.getClass().getDeclaredMethods()) if (m.getName().contains("generateTrackerAudio")) { genAudio = m; break; }
        genAudio.setAccessible(true);
        Object[] voices = (Object[]) getField(ts, "voices");
        int nv = voices.length;

        // Per voice: detect a fresh trigger (noteVal/samplePos reset) and measure how long it
        // stays active before deactivating. Report long holds with full geometry.
        int[] susChunks = new int[nv];
        int[] susNote = new int[nv]; int[] susInst = new int[nv];
        long[] susLen = new long[nv]; int[] susLoop = new int[nv];
        long[] susLoopS = new long[nv], susLoopE = new long[nv];
        boolean[] wasActive = new boolean[nv];
        int[] prevNote = new int[nv];
        java.util.List<String> holds = new java.util.ArrayList<>();
        java.util.Map<Integer,Integer> noteHoldCount = new java.util.HashMap<>();

        for (int chunk = 0; chunk < 30000; chunk++) {
            Object ret = genAudio.invoke(snd, playhead);
            for (int ch = 0; ch < nv; ch++) {
                Object v = voices[ch];
                boolean act = gb(v,"active");
                int iid = gi(v,"instrumentId");
                int note = gi(v,"noteVal");
                boolean fresh = act && (!wasActive[ch] || note != prevNote[ch]);
                if (fresh && iid == watchInst) {
                    // flush previous hold record for this channel
                    if (susChunks[ch] > 0) recordHold(holds, noteHoldCount, ch, susInst[ch], susNote[ch], susChunks[ch], susLen[ch], susLoop[ch], susLoopS[ch], susLoopE[ch]);
                    susChunks[ch] = 1; susInst[ch] = iid; susNote[ch] = note;
                    susLen[ch] = gl(v,"activeSampleLength"); susLoop[ch] = gi(v,"activeLoopMode");
                    susLoopS[ch] = gl(v,"activeSampleLoopStart"); susLoopE[ch] = gl(v,"activeSampleLoopEnd");
                } else if (act && iid == watchInst && iid == susInst[ch] && note == susNote[ch]) {
                    susChunks[ch]++;
                } else {
                    if (susInst[ch] == watchInst && susChunks[ch] > 0)
                        recordHold(holds, noteHoldCount, ch, susInst[ch], susNote[ch], susChunks[ch], susLen[ch], susLoop[ch], susLoopS[ch], susLoopE[ch]);
                    susChunks[ch] = 0; susInst[ch] = -1;
                }
                wasActive[ch] = act; prevNote[ch] = note;
            }
            if (ret == null) break;
        }
        System.out.println("=== inst " + watchInst + " holds >= 200 chunks (>3.2s) : note -> count, max chunks ===");
        // aggregate by note
        java.util.Map<Integer,int[]> agg = new java.util.HashMap<>(); // note -> {count, maxChunks}
        for (String s : holds) {} // holds already printed selectively below
        System.out.println("(detailed long holds)");
        for (String s : holds) System.out.println("  " + s);
    }

    static void recordHold(java.util.List<String> holds, java.util.Map<Integer,Integer> cnt, int ch, int inst, int note, int chunks, long len, int loop, long ls, long le) {
        if (chunks >= 200) {
            double sec = chunks * 512.0 / 32000.0;
            holds.add(String.format("ch%2d note=0x%04X len=%d loopMode=%d loop=[%d..%d] held %d chunks (%.1fs)%s",
                ch, note, len, loop, ls, le, chunks, sec, loop!=0?"  <-- LOOPING":""));
        }
    }
}
