import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.backends.lwjgl3.audio.OpenALLwjgl3Audio;
import net.torvald.tsvm.*;
import net.torvald.tsvm.peripheral.AudioAdapter;
import net.torvald.tsvm.peripheral.VMProgramRom;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.HashMap;

/** getInstrumentPatches must return exactly what uploadInstrumentPatches consumed,
 *  for every instrument of the real DOOM-E1M1.taud Ixmp section. */
public class RoundTripTest {
    static int u8(byte[] b, int o) { return b[o] & 0xFF; }
    static int u32(byte[] b, int o) { return u8(b,o)|(u8(b,o+1)<<8)|(u8(b,o+2)<<16)|(u8(b,o+3)<<24); }

    public static void main(String[] args) throws Exception {
        byte[] file = Files.readAllBytes(Paths.get("/home/torvald/Documents/tsvm/DOOM-E1M1.taud"));
        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);
        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(),
                       new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
        AudioAdapter snd = new AudioAdapter(vm);
        vm.getPeripheralTable()[1] = new PeripheralEntry(snd);
        AudioJSR223Delegate audio = new AudioJSR223Delegate(vm);

        int projOff = u32(file, 14);
        boolean ok = true;
        int p = projOff + 16;
        while (p + 8 <= file.length) {
            String fc = new String(file, p, 4, "latin1");
            int secLen = u32(file, p + 4);
            int payload = p + 8;
            if (fc.equals("Ixmp")) {
                int q = payload, qEnd = payload + secLen;
                while (q + 4 <= qEnd) {
                    int instId = u8(file, q);
                    int cnt = u8(file, q+1) | (u8(file, q+2)<<8) | (u8(file, q+3)<<16);
                    q += 4;
                    int[] up = new int[cnt * 31];
                    for (int k = 0; k < up.length; k++) up[k] = u8(file, q + k);
                    audio.uploadInstrumentPatches(instId, up);
                    int[] down = audio.getInstrumentPatches(instId);
                    boolean same = Arrays.equals(up, down);
                    System.out.println("inst " + instId + ": " + cnt + " patches round-trip "
                                       + (same ? "OK" : "MISMATCH"));
                    if (!same) ok = false;
                    q += cnt * 31;
                }
            }
            p = payload + secLen;
        }
        System.out.println(ok ? "ROUNDTRIP: PASS" : "ROUNDTRIP: FAIL");
        System.exit(ok ? 0 : 1);
    }
}
