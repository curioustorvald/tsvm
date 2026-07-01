import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.backends.lwjgl3.audio.OpenALLwjgl3Audio;
import net.torvald.tsvm.*;
import net.torvald.tsvm.peripheral.AudioAdapter;
import net.torvald.tsvm.peripheral.VMProgramRom;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;

/** Reload regression: uploadSampleInstBlob must clear stale Ixmp patches. */
public class StaleTest {
    static int u32(byte[] b, int o) { return (b[o]&0xFF)|((b[o+1]&0xFF)<<8)|((b[o+2]&0xFF)<<16)|((b[o+3]&0xFF)<<24); }

    public static void main(String[] args) throws Exception {
        byte[] file = Files.readAllBytes(Paths.get("/home/torvald/Documents/tsvm/DOOM-E1M1.taud"));
        com.badlogic.gdx.backends.lwjgl3.Lwjgl3NativesLoader.load();
        Gdx.audio = new OpenALLwjgl3Audio(16, 9, 512);
        VM vm = new VM("./assets", 8 * 1048576L, new TheRealWorld(),
                       new VMProgramRom[0], 8, new HashMap<String, VMWatchdog>());
        AudioAdapter snd = new AudioAdapter(vm);
        vm.getPeripheralTable()[1] = new PeripheralEntry(snd);
        AudioJSR223Delegate audio = new AudioJSR223Delegate(vm);

        int compSize = u32(file, 10);
        for (int i = 0; i < file.length; i++) vm.poke(256L + i, file[i]);
        audio.uploadSampleInstBlob(256 + 32, compSize);

        // Install a patch as the previous song would have.
        int[] p = new int[31];
        p[0] = 1; p[2] = 0x60; p[4] = 0x70; p[6] = 63; p[19] = 0xAB; p[20] = 0x20;
        audio.uploadInstrumentPatches(1, p);
        int before = audio.getInstrumentPatchCount(1);

        // Reload the blob — patches must be gone.
        audio.uploadSampleInstBlob(256 + 32, compSize);
        int after = audio.getInstrumentPatchCount(1);

        // 256-byte uploadInstrument: byte 196 (DNV) must round-trip now.
        int[] inst = new int[256];
        inst[196] = 0x77;
        audio.uploadInstrument(2, inst);
        int dnv = snd.peek(720896L + 2*256 + 196).intValue() & 0xFF;

        System.out.println("patches before reload: " + before + " (expect 1)");
        System.out.println("patches after reload:  " + after  + " (expect 0)");
        System.out.println("byte196 after 256B upload: 0x" + Integer.toHexString(dnv) + " (expect 0x77)");
        boolean ok = before == 1 && after == 0 && dnv == 0x77;
        System.out.println(ok ? "STALE/256B: PASS" : "STALE/256B: FAIL");
        System.exit(ok ? 0 : 1);
    }
}
