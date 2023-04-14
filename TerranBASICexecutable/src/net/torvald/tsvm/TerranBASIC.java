package net.torvald.tsvm;

import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration;
import com.badlogic.gdx.graphics.glutils.ShaderProgram;
import net.torvald.tsvm.peripheral.*;

import java.io.File;
import java.io.IOException;
import java.util.HashMap;

public class TerranBASIC {

    public static String appTitle = "TerranBASIC";
    public static Lwjgl3ApplicationConfiguration appConfig;

    public static int WIDTH = 640;
    public static int HEIGHT = 480;


    public static String diskDir = "My_BASIC_Programs";

    private static void createDirs() {
        File[] dirs = {
                new File(diskDir)
        };

        for (File it : dirs) {
            if (!it.exists())
                it.mkdirs();
        }
    }

    public static void main(String[] args) {
        createDirs();


        ShaderProgram.pedantic = false;

        appConfig = new Lwjgl3ApplicationConfiguration();
        appConfig.setOpenGLEmulation(Lwjgl3ApplicationConfiguration.GLEmulation.GL30, 3, 2);
        appConfig.setIdleFPS(60);
        appConfig.setForegroundFPS(60);
        appConfig.useVsync(false);
        appConfig.setResizable(false);
        appConfig.setTitle(appTitle);

        appConfig.setWindowedMode(WIDTH, HEIGHT);

        HashMap<String, VMWatchdog> watchdogs = new HashMap<>();

        VM tbasvm = new VM("./assets", 64 << 10, new TheRealWorld(), new VMProgramRom[]{TerranBASICreleaseBios.INSTANCE}, 2, watchdogs);
        EmulInstance tbasrunner = new EmulInstance(tbasvm, "net.torvald.tsvm.peripheral.ReferenceGraphicsAdapter", diskDir, 560, 448);
        new Lwjgl3Application(new VMGUI(tbasrunner, WIDTH, HEIGHT), appConfig);
    }
}
