package net.torvald.tsvm;

import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration;
import com.badlogic.gdx.graphics.glutils.ShaderProgram;
import kotlin.Pair;
import kotlin.collections.CollectionsKt;
import net.torvald.tsvm.peripheral.*;

public class AppLoader {

    public static String appTitle = "tsvm";
    public static Lwjgl3ApplicationConfiguration appConfig;

    public static int WIDTH = 640;//810;//720;
    public static int HEIGHT = 480;//360;//480;

    public static void main(String[] args) {
        ShaderProgram.pedantic = false;

        appConfig = new Lwjgl3ApplicationConfiguration();
        appConfig.setIdleFPS(60);
        appConfig.setForegroundFPS(60);
        appConfig.useVsync(false);
        appConfig.setResizable(false);
        appConfig.setTitle(appTitle);

        appConfig.setWindowedMode(WIDTH, HEIGHT);


//        VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{BasicBios.INSTANCE, BasicRom.INSTANCE});
//        VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{OEMBios.INSTANCE, BasicRom.INSTANCE});
//        VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{TandemBios.INSTANCE, BasicRom.INSTANCE});
//        VM vm = new VM(128 << 10, new TheRealWorld(), new VMProgramRom[]{BasicBios.INSTANCE, WPBios.INSTANCE});
//        VM vm = new VM("./assets", 8192 << 10, new TheRealWorld(), new VMProgramRom[]{TsvmBios.INSTANCE});
        VM vm = new VM("./assets", 8192 << 10, new TheRealWorld(), new VMProgramRom[]{OpenBios.INSTANCE});
        VM pipvm = new VM("./assets", 4096, new TheRealWorld(), new VMProgramRom[]{PipBios.INSTANCE, PipROM.INSTANCE});

        String diskPath = "assets/disk0";

        EmulInstance reference = new EmulInstance(vm, "net.torvald.tsvm.peripheral.ReferenceGraphicsAdapter2", diskPath, 560, 448);
        EmulInstance reference2 = new EmulInstance(vm, "net.torvald.tsvm.peripheral.ReferenceLikeLCD", diskPath, 560, 448);
        EmulInstance term = new EmulInstance(vm, "net.torvald.tsvm.peripheral.Term", diskPath, 720, 480);
        EmulInstance portable = new EmulInstance(vm, "net.torvald.tsvm.peripheral.CharacterLCDdisplay", diskPath, 628, 302);
        EmulInstance wp = new EmulInstance(vm, "net.torvald.tsvm.peripheral.WpTerm", "assets/wpdisk", 810, 360);
        EmulInstance pip = new EmulInstance(pipvm, null, diskPath, 640, 480, CollectionsKt.listOf(new Pair(1, new PeripheralEntry2(
                32768L,
                1,
                0,
                "net.torvald.tsvm.peripheral.ExtDisp",
                pipvm, 160, 140
        ))));

        new Lwjgl3Application(new VMGUI(reference, WIDTH, HEIGHT), appConfig);
    }
}
