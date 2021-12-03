package net.torvald.tsvm;

import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration;
import com.badlogic.gdx.graphics.glutils.ShaderProgram;
import net.torvald.tsvm.peripheral.*;

public class TerranBASIC {

    public static String appTitle = "TerranBASIC";
    public static Lwjgl3ApplicationConfiguration appConfig;

    public static int WIDTH = 640;
    public static int HEIGHT = 480;

    public static void main(String[] args) {
        ShaderProgram.pedantic = false;

        appConfig = new Lwjgl3ApplicationConfiguration();
        appConfig.setIdleFPS(60);
        appConfig.setForegroundFPS(60);
        appConfig.useVsync(false);
        appConfig.setResizable(false);
        appConfig.setTitle(appTitle);

        appConfig.setWindowedMode(WIDTH, HEIGHT);

        VM tbasvm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{TBASRelBios.INSTANCE});
        EmulInstance tbasrunner = new EmulInstance(tbasvm, "net.torvald.tsvm.peripheral.ReferenceGraphicsAdapter", "assets/disk0", 560, 448);
        new Lwjgl3Application(new VMGUI(tbasrunner, WIDTH, HEIGHT), appConfig);
    }
}
