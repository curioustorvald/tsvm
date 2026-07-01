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

/**
 * Loads a real midi2taud-with-Metainstruments .taud through the taud.mjs#uploadTaudFile
 * byte sequence, then drives the engine SYNCHRONOUSLY and asserts that (a) at least one
 * Metainstrument was parsed from the instrument bin and (b) at least one note fans out
 * into >=1 background layer-child voice during playback.
 */
public class MetaFileTest {
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

    public static void main(String[] args) throws Exception {
        String path = args.length > 0 ? args[0] : "/tmp/m_e1m1_meta.taud";
        byte[] file = Files.readAllBytes(Paths.get(path));

        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);
        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(),
                       new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
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
        int numVoices  = u8(file, entryOff + 4);
        int numPats    = u16(file, entryOff + 5);
        int bpm        = u8(file, entryOff + 7) + 25;
        int tickRate   = u8(file, entryOff + 8);
        int patComp    = u32(file, entryOff + 18);
        int cueComp    = u32(file, entryOff + 22);

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
        audio.setTrackerMode(0);
        audio.setBPM(0, bpm);
        audio.setTickRate(0, tickRate > 0 ? tickRate : 6);
        audio.setMasterVolume(0, 255);

        // Ixmp walk (variable-length patches), mirroring taud.mjs.
        if (projOff != 0) {
            int p = projOff + 16;
            while (p + 8 <= file.length) {
                String fc = new String(file, p, 4, "latin1");
                int secLen = u32(file, p + 4), payload = p + 8;
                if (fc.equals("Ixmp")) {
                    int q = payload, qEnd = payload + secLen;
                    while (q + 4 <= qEnd) {
                        // Header: byte0 = instId low 8, bytes1-2 = u16 count, byte3 = instId
                        // high (bit0 -> instId bit 8, the aux-bin $100..$1FF selector).
                        int instId = u8(file, q) | ((u8(file, q+3) & 0x01) << 8);
                        int cnt = u8(file, q+1) | (u8(file, q+2) << 8); q += 4;
                        int o = q;
                        for (int i = 0; i < cnt; i++) {
                            int ver = u8(file, o);
                            o += 31 + (((ver&0x80)!=0)?15:0) + (((ver&0x02)!=0)?54:0)
                                    + (((ver&0x04)!=0)?54:0) + (((ver&0x08)!=0)?54:0) + (((ver&0x10)!=0)?54:0);
                        }
                        int blobLen = o - q;
                        int[] buf = new int[blobLen];
                        for (int k = 0; k < blobLen; k++) buf[k] = u8(file, q + k);
                        audio.uploadInstrumentPatches(instId, buf);
                        q += blobLen;
                    }
                }
                p = payload + secLen;
            }
        }

        // Count parsed Metainstruments.
        Object[] insts = (Object[]) getField(snd, "instruments");
        int metas = 0;
        for (int s = 0; s < 256; s++)
            if (getField(insts[s], "metaLayers") != null) metas++;
        System.out.println("Metainstruments parsed from inst bin: " + metas);

        // Drive synchronously and track max simultaneous layer children.
        audio.setCuePosition(0, 0);
        audio.play(0);   // generateTrackerAudio only advances rows while isPlaying
        Object playhead = ((Object[]) getField(snd, "playheads"))[0];
        Object ts = getField(playhead, "trackerState");
        Method genAudio = null;
        for (Method m : snd.getClass().getDeclaredMethods())
            if (m.getName().contains("generateTrackerAudio")) { genAudio = m; break; }
        genAudio.setAccessible(true);

        Object[] voices = (Object[]) getField(ts, "voices");
        int maxLayerChildren = 0, sawFanout = 0;
        double minAttenGain = 1.0;   // smallest applied initialAttenuation gain among active voices
        for (int chunk = 0; chunk < 12000; chunk++) {       // covers the whole song
            Object ret = genAudio.invoke(snd, playhead);
            if (ret == null) break;
            int lc = 0;
            for (Object v : (Iterable<?>) getField(ts, "backgroundVoices"))
                if ((Boolean) getField(v, "isLayerChild") && (Boolean) getField(v, "active")) lc++;
            if (lc > maxLayerChildren) maxLayerChildren = lc;
            for (Object v : voices)
                if ((Boolean) getField(v, "active")) {
                    double g = (Double) getField(v, "activeAttenGain");
                    if (g < minAttenGain) minAttenGain = g;
                }
            if (lc >= 1) { sawFanout++; if (sawFanout > 200) break; }  // confirmed; stop early
        }
        System.out.println("min activeAttenGain among active voices: " + minAttenGain
                         + (minAttenGain < 1.0 ? "  (initialAttenuation IS applied)" : "  (NOT applied!)"));
        System.out.println("max simultaneous layer children: " + maxLayerChildren
                         + "  (chunks with >=1 child: " + sawFanout + ")");

        boolean ok = metas >= 1 && maxLayerChildren >= 1;
        System.out.println(ok ? "METAFILE: PASS" : "METAFILE: FAIL");
        System.exit(ok ? 0 : 1);
    }
}
