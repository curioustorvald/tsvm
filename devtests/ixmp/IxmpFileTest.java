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
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

/**
 * Headless end-to-end test: load the real DOOM-E1M1.taud through the exact
 * same steps taud.mjs#uploadTaudFile performs, play it, and verify that
 * triggers landing inside an Ixmp patch rectangle switch the voice onto the
 * patch's sample pointer.
 */
public class IxmpFileTest {

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

    record Patch(int ps, int pe, int vs, int ve, int ptr) {}

    public static void main(String[] args) throws Exception {
        String path = args.length > 0 ? args[0] : "/home/torvald/Documents/tsvm/DOOM-E1M1.taud";
        byte[] file = Files.readAllBytes(Paths.get(path));

        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);
        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(),
                       new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
        AudioAdapter snd = new AudioAdapter(vm);
        vm.getPeripheralTable()[1] = new PeripheralEntry(snd);
        AudioJSR223Delegate audio = new AudioJSR223Delegate(vm);

        // ── header ──
        int compSize = u32(file, 10);
        int projOff  = u32(file, 14);

        // ── step 4: sample+inst blob, via VM user memory like taud.mjs ──
        long filePtr = 256;
        for (int i = 0; i < file.length; i++) vm.poke(filePtr + i, file[i]);
        int blobOk = audio.uploadSampleInstBlob((int) filePtr + 32, compSize);
        audio.setSampleBank(0);
        System.out.println("uploadSampleInstBlob -> " + blobOk);

        // ── step 5: song entry 0 ──
        int entryOff   = 32 + compSize;
        int songOffset = u32(file, entryOff);
        int numVoices  = u8(file, entryOff + 4);
        int numPats    = u16(file, entryOff + 5);
        int bpm        = u8(file, entryOff + 7) + 25;
        int tickRate   = u8(file, entryOff + 8);
        int patComp    = u32(file, entryOff + 18);
        int cueComp    = u32(file, entryOff + 22);
        System.out.printf("voices=%d pats=%d bpm=%d speed=%d%n", numVoices, numPats, bpm, tickRate);

        // ── steps 6-7: patterns + cues ──
        byte[] patBin = CompressorDelegate.Companion.decomp(
            java.util.Arrays.copyOfRange(file, songOffset, songOffset + patComp));
        byte[] cueBin = CompressorDelegate.Companion.decomp(
            java.util.Arrays.copyOfRange(file, songOffset + patComp, songOffset + patComp + cueComp));
        int[] tmp = new int[512];
        for (int pIdx = 0; pIdx < numPats; pIdx++) {
            for (int k = 0; k < 512; k++) tmp[k] = u8(patBin, pIdx * 512 + k);
            audio.uploadPattern(pIdx, tmp);
        }
        int[] ctmp = new int[32];
        for (int c = 0; c < cueBin.length / 32; c++) {
            for (int k = 0; k < 32; k++) ctmp[k] = u8(cueBin, c * 32 + k);
            audio.uploadCue(c, ctmp);
        }

        // ── step 8: playhead config ──
        audio.setTrackerMode(0);
        audio.setBPM(0, bpm);
        audio.setTickRate(0, tickRate > 0 ? tickRate : 6);
        audio.setMasterVolume(0, 255);

        // ── step 9: Ixmp walk (mirror of taud.mjs) ──
        HashMap<Integer, List<Patch>> patchTable = new HashMap<>();
        if (projOff != 0) {
            int p = projOff + 16;
            while (p + 8 <= file.length) {
                String fc = new String(file, p, 4, "latin1");
                int secLen = u32(file, p + 4);
                int payload = p + 8;
                if (fc.equals("Ixmp")) {
                    int q = payload, qEnd = payload + secLen;
                    while (q + 4 <= qEnd) {
                        int instId = u8(file, q); q++;
                        int cnt = u8(file, q) | (u8(file, q+1)<<8) | (u8(file, q+2)<<16); q += 3;
                        // Variable-length patches (2026-06-13): walk each by its version byte.
                        List<Patch> lst = new ArrayList<>();
                        int o = q;
                        for (int i = 0; i < cnt; i++) {
                            int ver = u8(file, o);
                            lst.add(new Patch(u16(file,o+1), u16(file,o+3),
                                              u8(file,o+5), u8(file,o+6), u32(file,o+7)));
                            o += 31
                                 + (((ver & 0x80) != 0) ? 15 : 0)   // x (u32 flags1 + u32 flags2 + u16 fadeout + u16 cutoff + u16 reson + u8 atten octet)
                                 + (((ver & 0x02) != 0) ? 54 : 0)   // v
                                 + (((ver & 0x04) != 0) ? 54 : 0)   // p
                                 + (((ver & 0x08) != 0) ? 54 : 0)   // f
                                 + (((ver & 0x10) != 0) ? 54 : 0);  // P
                        }
                        int blobLen = o - q;
                        int[] buf = new int[blobLen];
                        for (int k = 0; k < blobLen; k++) buf[k] = u8(file, q + k);
                        audio.uploadInstrumentPatches(instId, buf);
                        patchTable.put(instId, lst);
                        q += blobLen;
                    }
                }
                p = payload + secLen;
            }
        }
        for (var e : patchTable.entrySet())
            System.out.println("inst " + e.getKey() + ": " + audio.getInstrumentPatchCount(e.getKey())
                               + " patches installed (expected " + e.getValue().size() + ")");

        // Base sample ptrs per instrument, read back from the adapter's inst bin.
        int[] basePtr = new int[256];
        for (int s = 0; s < 256; s++) {
            int b0 = snd.peek(720896L + s*256    ).intValue() & 0xFF;
            int b1 = snd.peek(720896L + s*256 + 1).intValue() & 0xFF;
            int b2 = snd.peek(720896L + s*256 + 2).intValue() & 0xFF;
            int b3 = snd.peek(720896L + s*256 + 3).intValue() & 0xFF;
            basePtr[s] = b0 | (b1<<8) | (b2<<16) | (b3<<24);
        }

        audio.setCuePosition(0, 0);
        audio.play(0);

        // ── poll all voices; verify every trigger picks the right sample ──
        Object playhead = ((Object[]) getField(snd, "playheads"))[0];
        Object ts = getField(playhead, "trackerState");
        Object[] voices = (Object[]) getField(ts, "voices");

        int checked = 0, wrong = 0, patchHits = 0;
        int[] lastNote = new int[20];
        long t0 = System.currentTimeMillis();
        while (System.currentTimeMillis() - t0 < 15000) {
            boolean playing = (Boolean) getField(playhead, "isPlaying");
            if (!playing) break;
            for (int v = 0; v < Math.min(numVoices, 20); v++) {
                int nv   = (Integer) getField(voices[v], "noteVal");
                int iid  = (Integer) getField(voices[v], "instrumentId");
                int aptr = (Integer) getField(voices[v], "activeSamplePtr");
                int rvol = (Integer) getField(voices[v], "rowVolume");
                boolean act = (Boolean) getField(voices[v], "active");
                if (!act || nv < 0x20 || iid == 0) continue;
                if (nv == lastNote[v]) continue;   // only evaluate fresh triggers/targets
                lastNote[v] = nv;
                List<Patch> lst = patchTable.get(iid);
                int expect = basePtr[iid];
                Patch hit = null;
                if (lst != null) for (Patch pp : lst) {
                    if (nv >= pp.ps() && nv <= pp.pe()
                        && rvol >= pp.vs() && rvol <= pp.ve()) { hit = pp; break; }
                }
                if (hit != null) expect = hit.ptr();
                checked++;
                if (hit != null && aptr == hit.ptr()) patchHits++;
                if (aptr != expect) {
                    wrong++;
                    if (wrong <= 12)
                        System.out.printf("MISMATCH v%-2d inst=%d note=0x%04X activePtr=%d expected=%d (%s)%n",
                            v, iid, nv, aptr, expect, hit != null ? "patch" : "base");
                }
            }
            Thread.sleep(5);
        }
        System.out.printf("triggers checked=%d patch-hits=%d mismatches=%d%n", checked, patchHits, wrong);
        System.out.println(wrong == 0 && patchHits > 0 ? "FILE IXMP: PASS" : "FILE IXMP: FAIL");
        System.exit(wrong == 0 && patchHits > 0 ? 0 : 1);
    }
}
