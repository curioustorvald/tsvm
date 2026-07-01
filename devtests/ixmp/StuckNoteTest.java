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

/** Play a whole .taud synchronously and report any voices still sounding at the end
 *  (stuck notes), plus a per-window census of active voices on the named instruments. */
public class StuckNoteTest {
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
    static boolean gb(Object v, String f) throws Exception { return (Boolean) getField(v, f); }
    static double gd(Object v, String f) throws Exception { return (Double) getField(v, f); }

    public static void main(String[] args) throws Exception {
        String path = args.length > 0 ? args[0] : "/tmp/onestop_sf.taud";
        // Instruments to watch (default: Bass & Lead layers 22/23 + meta 24).
        int[] watch = {22, 23, 24};
        if (args.length > 1) { String[] w = args[1].split(","); watch = new int[w.length]; for (int i=0;i<w.length;i++) watch[i]=Integer.parseInt(w[i].trim()); }
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
        int bpm        = u8(file, entryOff + 7) + 25;
        int tickRate   = u8(file, entryOff + 8);
        int numPats    = u16(file, entryOff + 5);
        int patComp    = u32(file, entryOff + 18);
        int cueComp    = u32(file, entryOff + 22);

        byte[] patBin = CompressorDelegate.Companion.decomp(java.util.Arrays.copyOfRange(file, songOffset, songOffset + patComp));
        byte[] cueBin = CompressorDelegate.Companion.decomp(java.util.Arrays.copyOfRange(file, songOffset + patComp, songOffset + patComp + cueComp));
        int[] tmp = new int[512];
        for (int pIdx = 0; pIdx < numPats; pIdx++) { for (int k = 0; k < 512; k++) tmp[k] = u8(patBin, pIdx * 512 + k); audio.uploadPattern(pIdx, tmp); }
        int[] ctmp = new int[32];
        for (int c = 0; c < cueBin.length / 32; c++) { for (int k = 0; k < 32; k++) ctmp[k] = u8(cueBin, c * 32 + k); audio.uploadCue(c, ctmp); }
        audio.setTrackerMode(0); audio.setBPM(0, bpm); audio.setTickRate(0, tickRate > 0 ? tickRate : 6); audio.setMasterVolume(0, 255);

        // Ixmp walk (15-byte 'x' block).
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

        java.util.Set<Integer> watchSet = new java.util.HashSet<>();
        for (int w : watch) watchSet.add(w);

        // Per foreground channel: track how long the current note sustains WITHOUT a key-off
        // (held note, constant volume). A note that sustains for many chunks across a cue
        // boundary then abruptly stops is the bug ("plays through cue 6, abruptly stops").
        int nv = voices.length;
        int[] susChunks = new int[nv]; int[] susInst = new int[nv]; int[] susStartCue = new int[nv];
        java.util.List<String> longHelds = new java.util.ArrayList<>();
        final int SUS_FLAG = 600;   // ~1.3 cues

        int endedChunk = -1;
        for (int chunk = 0; chunk < 20000; chunk++) {
            Object ret = genAudio.invoke(snd, playhead);
            int curCue = gi(ts, "cuePos");
            for (int ch = 0; ch < nv; ch++) {
                Object v = voices[ch];
                boolean act = gb(v, "active"); boolean ko = gb(v, "keyOff");
                int iid = gi(v, "instrumentId");
                if (act && !ko && iid == susInst[ch] && susChunks[ch] > 0) {
                    susChunks[ch]++;
                } else {
                    if (susChunks[ch] >= SUS_FLAG)
                        longHelds.add(String.format("ch%2d inst=%3d sustained %4d chunks (cue %d->%d) then ended",
                            ch, susInst[ch], susChunks[ch], susStartCue[ch], curCue));
                    if (act && !ko) { susChunks[ch] = 1; susInst[ch] = iid; susStartCue[ch] = curCue; }
                    else susChunks[ch] = 0;
                }
            }
            if (ret == null) { endedChunk = chunk; break; }
        }
        System.out.println("=== foreground notes that sustained >= " + SUS_FLAG + " chunks without key-off ===");
        for (String s : longHelds) System.out.println("  " + s);
        if (longHelds.isEmpty()) System.out.println("  (none)");
        System.out.println("playback ended at chunk " + endedChunk + " (null=halt) ; final cue " + gi(ts,"cuePos"));

        // Dump any voices still sounding (the stuck notes).
        System.out.println("--- still-active FOREGROUND voices ---");
        for (int i = 0; i < voices.length; i++) {
            Object v = voices[i];
            if (gb(v, "active"))
                System.out.printf("  ch%2d inst=%3d keyOff=%b fading=%b fadeVol=%.3f fadeStep=%d envIdx=%d envVol=%.3f%n",
                    i, gi(v,"instrumentId"), gb(v,"keyOff"), gb(v,"noteFading"), gd(v,"fadeoutVolume"), gi(v,"activeFadeoutStep"), gi(v,"envIndex"), gd(v,"envVolume"));
        }
        System.out.println("--- still-active BACKGROUND voices ---");
        int bgN = 0;
        for (Object v : (Iterable<?>) getField(ts, "backgroundVoices")) {
            if (gb(v, "active")) { bgN++;
                System.out.printf("  inst=%3d layerChild=%b srcCh=%d keyOff=%b fading=%b fadeVol=%.3f fadeStep=%d envIdx=%d envVol=%.3f%n",
                    gi(v,"instrumentId"), gb(v,"isLayerChild"), gi(v,"sourceChannel"), gb(v,"keyOff"), gb(v,"noteFading"),
                    gd(v,"fadeoutVolume"), gi(v,"activeFadeoutStep"), gi(v,"envIndex"), gd(v,"envVolume")); }
        }
        System.out.println("total still-active background: " + bgN);
    }
}
