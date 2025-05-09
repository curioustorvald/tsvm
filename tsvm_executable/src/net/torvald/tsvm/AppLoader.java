package net.torvald.tsvm;

import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration;
import com.badlogic.gdx.graphics.glutils.ShaderProgram;
import kotlin.Pair;
import net.torvald.tsvm.peripheral.*;

import java.util.ArrayList;
import java.util.HashMap;

public class AppLoader {

    public static String appTitle = "tsvm";
    public static Lwjgl3ApplicationConfiguration appConfig;

    public static int WIDTH = 640;
    public static int HEIGHT = 480;
    public static float MAGN = 2f;

    public static void main(String[] args) {
        ShaderProgram.pedantic = false;

        appConfig = new Lwjgl3ApplicationConfiguration();
        appConfig.setOpenGLEmulation(Lwjgl3ApplicationConfiguration.GLEmulation.GL30, 3, 2);
        appConfig.setIdleFPS(60);
        appConfig.setForegroundFPS(60);
        appConfig.useVsync(false);
        appConfig.setResizable(false);
        appConfig.setTitle(appTitle);

        appConfig.setWindowedMode(((int) (WIDTH * MAGN)), ((int) (HEIGHT * MAGN)));

        HashMap<String, VMWatchdog> watchdogs = new HashMap<>();
        watchdogs.put("TEVD_COMMIT", TevdPartialDomCommitWatchdog.INSTANCE);
        watchdogs.put("TEVD_SYNC", TevdPartialDomSyncWatchdog.INSTANCE);


        String diskPath = "assets/disk0";


//        VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{BasicBios.INSTANCE, BasicRom.INSTANCE});
//        VM vm = new VM("./assets", 64 << 10, new TheRealWorld(), new VMProgramRom[]{OEMBios.INSTANCE, BasicRom.INSTANCE}, 8, watchdogs);
//        VM vm = new VM("./assets", 64 << 10, new TheRealWorld(), new VMProgramRom[]{TandemBios.INSTANCE, BasicRom.INSTANCE}, 2, watchdogs);
//        VM vm = new VM("./assets", 128 << 10, new TheRealWorld(), new VMProgramRom[]{BasicBios.INSTANCE, WPBios.INSTANCE}, 2, watchdogs);
        VM vm = new VM("./assets", 8192 << 10, new TheRealWorld(), new VMProgramRom[]{TsvmBios.INSTANCE}, 8, watchdogs);
//        VM vm = new VM("./assets", 8192 << 10, new TheRealWorld(), new VMProgramRom[]{Mon.INSTANCE, HyveRom.INSTANCE}, 8, watchdogs);
//        VM vm = new VM("./assets", 8192 << 10, new TheRealWorld(), new VMProgramRom[]{OpenBios.INSTANCE}, 8, watchdogs);
//        VM pipvm = new VM("./assets", 4096, new TheRealWorld(), new VMProgramRom[]{PipBios.INSTANCE, PipROM.INSTANCE}, 8, watchdogs);

        vm.getIO().getBlockTransferPorts()[0].attachDevice(new TestDiskDrive(vm, 0, diskPath));
        vm.getIO().getBlockTransferPorts()[1].attachDevice(new HttpModem(vm, 1024, -1));
        vm.getIO().getBlockTransferPorts()[2].attachDevice(new TestDiskDrive(vm, 0, "assets/diskMediabin"));


        ArrayList defaultPeripherals = new ArrayList();
        defaultPeripherals.add(new Pair(3, new PeripheralEntry2("net.torvald.tsvm.peripheral.AudioAdapter", vm)));


        EmulInstance reference = new EmulInstance(vm, "net.torvald.tsvm.peripheral.ReferenceGraphicsAdapter", diskPath, 560, 448, defaultPeripherals);
        EmulInstance referenceRemote = new EmulInstance(vm, "net.torvald.tsvm.peripheral.RemoteGraphicsAdapter", diskPath, 560, 448, defaultPeripherals);
        EmulInstance reference2 = new EmulInstance(vm, "net.torvald.tsvm.peripheral.ReferenceLikeLCD", diskPath, 560, 448, defaultPeripherals);
        EmulInstance term = new EmulInstance(vm, "net.torvald.tsvm.peripheral.Term", diskPath, 720, 480);
        EmulInstance portable = new EmulInstance(vm, "net.torvald.tsvm.peripheral.CLCDDisplay", diskPath, 1080, 436);
        EmulInstance wp = new EmulInstance(vm, "net.torvald.tsvm.peripheral.WpTerm", "assets/wpdisk", 810, 360);

        /*EmulInstance pip = new EmulInstance(pipvm, null, diskPath, 640, 480, CollectionsKt.listOf(new Pair(1, new PeripheralEntry2(
                32768L,
                1,
                0,
                "net.torvald.tsvm.peripheral.ExtDisp",
                pipvm, 160, 140
        ))));*/

        new Lwjgl3Application(new VMGUI(reference, WIDTH, HEIGHT), appConfig);
    }
}
