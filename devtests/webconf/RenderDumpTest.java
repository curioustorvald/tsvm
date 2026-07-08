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

import java.io.BufferedOutputStream;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.HashMap;

/**
 * PCM conformance oracle for the Microtone.js engine port (M1).
 *
 * Loads a .taud through the exact taud.mjs#uploadTaudFile sequence (v1/v2 cue
 * translation, xHDR 64-channel flag, mixer flags, song volumes, Ixmp walk),
 * INTERRUPTS the adapter's own render threads so nothing races, then drives
 * generateTrackerAudio synchronously for N seconds and dumps:
 *
 *   <out>/<name>.u8.pcm   interleaved stereo unsigned-8 (the real device output)
 *   <out>/<name>.f32.pcm  interleaved stereo float32 LE, the PRE-DITHER mix bus
 *                         (TrackerState.mixLeft/mixRight after clip, before
 *                         pcm32fToPcm8) — the primary conformance signal
 *
 * The whole render is performed TWICE with a fresh VM+adapter and compared, so
 * the summary line reports DETERMINISTIC or NONDETERMINISTIC (Math.random in
 * vol/pan swing at trigger or random-LFO waveform 3). Instruments carrying
 * non-zero volumeSwing/panSwing are listed as a hint.
 *
 * Usage:
 *   RenderDumpTest <in.taud> <outDir> [seconds=20] [songIndex=0]
 *
 * Build/run: see devtests/ixmp/README.md (same classpath recipe;
 * ALSOFT_DRIVERS=null for the silent OpenAL backend).
 */
public class RenderDumpTest {

    static final int SAMPLING_RATE = 32000;
    static final int CHUNK = 512;

    // ── reflection helpers (as devtests/ixmp) ──
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

    // ── taud.mjs mirrors ──

    // _readXHDR64 (taud.mjs:98-115)
    static boolean readXHDR64(byte[] f, int projOff) {
        if (projOff == 0 || projOff + 16 > f.length) return false;
        byte[] projMagic = {0x1E,'T','a','u','d','P','r','J'};
        for (int i = 0; i < 8; i++) if (f[projOff+i] != projMagic[i]) return false;
        int p = projOff + 16;
        while (p + 8 <= f.length) {
            String fc = new String(f, p, 4, java.nio.charset.StandardCharsets.ISO_8859_1);
            int secLen = u32(f, p + 4);
            int payload = p + 8;
            if (payload + secLen > f.length) break;
            if (fc.equals("xHDR") && secLen >= 1) return (f[payload] & 0x01) != 0;
            p = payload + secLen;
        }
        return false;
    }

    // _v1CueToV2 (taud.mjs:123-144): 20 voices × 12-bit patterns in nibble planes
    // + 16-bit instruction word in bytes 30/31 → 32×Sint16 v2 cue payload.
    static int[] v1CueToV2(byte[] cueBin, int c) {
        int[] b = new int[32];
        for (int k = 0; k < 32; k++) b[k] = u8(cueBin, c*32 + k);
        int word0 = (b[30] << 8) | b[31];
        int[] out = new int[64];
        for (int ch = 0; ch < 32; ch++) {
            int pat = 0x7FFF;
            if (ch < 20) {
                int bi = ch >> 1;
                int lo = ((ch & 1) != 0) ? (b[bi] & 0xF)      : ((b[bi] >> 4) & 0xF);
                int mi = ((ch & 1) != 0) ? (b[10+bi] & 0xF)   : ((b[10+bi] >> 4) & 0xF);
                int hi = ((ch & 1) != 0) ? (b[20+bi] & 0xF)   : ((b[20+bi] >> 4) & 0xF);
                int p12 = (hi << 8) | (mi << 4) | lo;
                pat = (p12 == 0xFFF) ? 0x7FFF : p12;
            }
            int val = pat & 0x7FFF;
            if (ch < 16 && ((word0 >> ch) & 1) != 0) val |= 0x8000;
            out[ch*2]   = val & 0xFF;
            out[ch*2+1] = (val >>> 8) & 0xFF;
        }
        return out;
    }

    record RenderResult(byte[] u8, byte[] f32, long frames, boolean halted, String swingInsts) {}

    // Full uploadTaudFile mirror + synchronous render. Fresh VM+adapter per call.
    static RenderResult renderOnce(byte[] file, int songIndex, int seconds) throws Exception {
        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(),
                       new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
        AudioAdapter snd = new AudioAdapter(vm);
        vm.getPeripheralTable()[1] = new PeripheralEntry(snd);
        AudioJSR223Delegate audio = new AudioJSR223Delegate(vm);

        // Stop the adapter's own render threads BEFORE anything can play, so the
        // synchronous generateTrackerAudio drive below is the only mutator.
        Thread[] rts = (Thread[]) getField(snd, "renderThreads");
        for (Thread t : rts) t.interrupt();
        for (Thread t : rts) t.join(2000);

        // ── header (taud.mjs:209-230) ──
        int version  = u8(file, 8);
        int numSongs = u8(file, 9);
        int compSize = u32(file, 10);
        int projOff  = u32(file, 14);
        int kind     = version & 0xC0;
        if (kind != 0x00) throw new IllegalArgumentException("not a full .taud (kind=" + kind + ")");
        if (songIndex < 0 || songIndex >= numSongs) throw new IllegalArgumentException("songIndex out of range");

        boolean is64 = ((version & 0x20) != 0) && readXHDR64(file, projOff);
        audio.set64ChannelMode(is64);

        // ── sample+inst blob via VM user memory (taud.mjs:239-243) ──
        long filePtr = 256;
        for (int i = 0; i < file.length; i++) vm.poke(filePtr + i, file[i]);
        audio.uploadSampleInstBlob((int) filePtr + 32, compSize);
        audio.setSampleBank(0);

        // ── song table entry (taud.mjs:253-270) ──
        int entryOff   = 32 + compSize + songIndex * 32;
        int songOffset = u32(file, entryOff);
        int numPats    = u16(file, entryOff + 5);
        int bpmStored  = u8(file, entryOff + 7);
        int tickPacked = u8(file, entryOff + 8);
        int tickRate   = tickPacked & 0x7F;
        bpmStored     |= (tickPacked & 0x80) << 1;
        int mixerflags = u8(file, entryOff + 15);
        int songGlobalVolume = u8(file, entryOff + 16);
        int songMixingVolume = u8(file, entryOff + 17);
        int patComp    = u32(file, entryOff + 18);
        int cueComp    = u32(file, entryOff + 22);
        int bpm        = bpmStored + 25;

        // ── patterns (taud.mjs:272-283) ──
        byte[] patBin = CompressorDelegate.Companion.decomp(
            Arrays.copyOfRange(file, songOffset, songOffset + patComp));
        int[] tmp = new int[512];
        for (int p = 0; p < numPats; p++) {
            for (int k = 0; k < 512; k++) tmp[k] = u8(patBin, p*512 + k);
            audio.uploadPattern(p, tmp);
        }

        // ── cues (taud.mjs:285-313) ──
        byte[] cueBin = CompressorDelegate.Companion.decomp(
            Arrays.copyOfRange(file, songOffset + patComp, songOffset + patComp + cueComp));
        int fmtVer = version & 0x1F;
        if (fmtVer >= 2) {
            int stride = is64 ? 128 : 64;
            int numCues = cueBin.length / stride;
            int[] cue = new int[stride];
            for (int c = 0; c < numCues; c++) {
                for (int k = 0; k < stride; k++) cue[k] = u8(cueBin, c*stride + k);
                audio.uploadCue(c, cue);
            }
        } else {
            int numCues = cueBin.length / 32;
            for (int c = 0; c < numCues; c++) audio.uploadCue(c, v1CueToV2(cueBin, c));
        }

        // ── playhead config (taud.mjs:315-321) + master volume ──
        audio.setTrackerMode(0);
        audio.setBPM(0, bpm);
        audio.setTickRate(0, tickRate > 0 ? tickRate : 6);
        audio.setTrackerMixerFlags(0, mixerflags);
        audio.setSongGlobalVolume(0, songGlobalVolume);
        audio.setSongMixingVolume(0, songMixingVolume);
        audio.setMasterVolume(0, 255);

        // ── Ixmp walk (taud.mjs:331-386, 10-bit inst id) ──
        if (projOff != 0 && projOff + 16 <= file.length) {
            byte[] projMagic = {0x1E,'T','a','u','d','P','r','J'};
            boolean prjOk = true;
            for (int i = 0; i < 8; i++) if (file[projOff+i] != projMagic[i]) { prjOk = false; break; }
            if (prjOk) {
                int p = projOff + 16;
                while (p + 8 <= file.length) {
                    String fc = new String(file, p, 4, java.nio.charset.StandardCharsets.ISO_8859_1);
                    int secLen = u32(file, p + 4);
                    int payload = p + 8;
                    if (payload + secLen > file.length) break;
                    if (fc.equals("Ixmp")) {
                        int q = payload, qEnd = payload + secLen;
                        while (q + 4 <= qEnd) {
                            int idLo = u8(file, q); int cntLo = u8(file, q+1);
                            int cntMid = u8(file, q+2); int idHi = u8(file, q+3);
                            q += 4;
                            int instId = idLo | ((idHi & 0x03) << 8);
                            int patchCnt = cntLo | (cntMid << 8);
                            int blobLen = 0, scan = q; boolean ok = true;
                            for (int i = 0; i < patchCnt; i++) {
                                if (scan + 31 > qEnd) { ok = false; break; }
                                int ver = u8(file, scan);
                                int len = 31 + (((ver & 0x80) != 0) ? 15 : 0)
                                             + (((ver & 0x02) != 0) ? 54 : 0)
                                             + (((ver & 0x04) != 0) ? 54 : 0)
                                             + (((ver & 0x08) != 0) ? 54 : 0)
                                             + (((ver & 0x10) != 0) ? 54 : 0);
                                if (scan + len > qEnd) { ok = false; break; }
                                scan += len; blobLen += len;
                            }
                            if (!ok) break;
                            int[] buf = new int[blobLen];
                            for (int k = 0; k < blobLen; k++) buf[k] = u8(file, q + k);
                            audio.uploadInstrumentPatches(instId, buf);
                            q += blobLen;
                        }
                    }
                    p = payload + secLen;
                }
            }
        }

        // ── nondeterminism hint: instruments with vol/pan swing ──
        StringBuilder swings = new StringBuilder();
        Object[] insts = (Object[]) getField(snd, "instruments");
        for (int s = 0; s < 1024; s++) {
            int vs = (Integer) getField(insts[s], "volumeSwing");
            int ps = (Integer) getField(insts[s], "panSwing");
            if (vs != 0 || ps != 0) swings.append(String.format(" $%03X(v%d,p%d)", s, vs, ps));
        }

        // ── synchronous drive ──
        audio.setCuePosition(0, 0);
        audio.play(0);

        Object playhead = ((Object[]) getField(snd, "playheads"))[0];
        Object ts = getField(playhead, "trackerState");
        Method genAudio = null;
        for (Method m : snd.getClass().getDeclaredMethods())
            if (m.getName().contains("generateTrackerAudio")) { genAudio = m; break; }
        if (genAudio == null) throw new NoSuchMethodException("generateTrackerAudio");
        genAudio.setAccessible(true);

        long maxFrames = (long) seconds * SAMPLING_RATE;
        int nChunks = (int) ((maxFrames + CHUNK - 1) / CHUNK);
        byte[] u8out  = new byte[nChunks * CHUNK * 2];
        byte[] f32out = new byte[nChunks * CHUNK * 2 * 4];
        ByteBuffer fbb = ByteBuffer.wrap(f32out).order(ByteOrder.LITTLE_ENDIAN);

        long frames = 0;
        boolean halted = false;
        int chunkIdx = 0;
        while (frames < maxFrames) {
            if (!((Boolean) getField(playhead, "isPlaying"))) { halted = true; break; }
            byte[] out = (byte[]) genAudio.invoke(snd, playhead);
            if (out == null) { halted = true; break; }
            System.arraycopy(out, 0, u8out, chunkIdx * CHUNK * 2, CHUNK * 2);
            float[] mixL = (float[]) getField(ts, "mixLeft");
            float[] mixR = (float[]) getField(ts, "mixRight");
            for (int n = 0; n < CHUNK; n++) { fbb.putFloat(mixL[n]); fbb.putFloat(mixR[n]); }
            frames += CHUNK;
            chunkIdx++;
        }

        try { snd.dispose(); } catch (Throwable e) { /* GdxRuntimeException on device teardown is fine */ }

        return new RenderResult(
            Arrays.copyOf(u8out, chunkIdx * CHUNK * 2),
            Arrays.copyOf(f32out, chunkIdx * CHUNK * 2 * 4),
            frames, halted, swings.toString());
    }

    public static void main(String[] args) throws Exception {
        String inPath  = args.length > 0 ? args[0] : "/home/torvald/Documents/tsvm/DOOM-E1M1.taud";
        String outDir  = args.length > 1 ? args[1] : "/tmp/tauddump";
        int seconds    = args.length > 2 ? Integer.parseInt(args[2]) : 20;
        int songIndex  = args.length > 3 ? Integer.parseInt(args[3]) : 0;

        byte[] file = Files.readAllBytes(Paths.get(inPath));
        Files.createDirectories(Paths.get(outDir));
        String base = Paths.get(inPath).getFileName().toString().replaceAll("\\.taud$", "");

        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);

        RenderResult r1 = renderOnce(file, songIndex, seconds);
        RenderResult r2 = renderOnce(file, songIndex, seconds);
        boolean det = Arrays.equals(r1.u8(), r2.u8()) && Arrays.equals(r1.f32(), r2.f32());

        try (BufferedOutputStream o = new BufferedOutputStream(new FileOutputStream(outDir + "/" + base + ".u8.pcm"))) {
            o.write(r1.u8());
        }
        try (BufferedOutputStream o = new BufferedOutputStream(new FileOutputStream(outDir + "/" + base + ".f32.pcm"))) {
            o.write(r1.f32());
        }

        System.out.printf("%s: frames=%d (%.1fs) halted=%b %s swing=[%s]%n",
            base, r1.frames(), r1.frames() / (double) SAMPLING_RATE, r1.halted(),
            det ? "DETERMINISTIC" : "NONDETERMINISTIC", r1.swingInsts().trim());
        System.exit(0);
    }
}
