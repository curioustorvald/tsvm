package net.torvald.tsvm;

import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration;
import com.badlogic.gdx.graphics.Texture;
import com.badlogic.gdx.graphics.glutils.ShaderProgram;
import net.torvald.tsvm.peripheral.*;

public class AppLoader {

    public static String appTitle = "Totally Simple Virtual Machine";
    public static Lwjgl3ApplicationConfiguration appConfig;

    public static int WIDTH = 810;//720;
    public static int HEIGHT = 360;//480;

    public static void main(String[] args) {
        ShaderProgram.pedantic = false;

        appConfig = new Lwjgl3ApplicationConfiguration();
        appConfig.setIdleFPS(60);
        appConfig.setForegroundFPS(60);
        appConfig.useVsync(false);
        appConfig.setResizable(false);
        appConfig.setTitle(appTitle);

        appConfig.setWindowedMode(WIDTH, HEIGHT);


        //VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{BasicBios.INSTANCE, BasicRom.INSTANCE});
        //VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{OEMBios.INSTANCE, BasicRom.INSTANCE});
        //VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{TandemBios.INSTANCE, BasicRom.INSTANCE});
        VM vm = new VM(128 << 10, new TheRealWorld(), new VMProgramRom[]{BasicBios.INSTANCE, WPBios.INSTANCE});

        // uncomment to target the TerranBASIC runner
        //VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{TBASRelBios.INSTANCE});

        EmulInstance reference = new EmulInstance(vm, "net.torvald.tsvm.peripheral.ReferenceGraphicsAdapter", "assets/disk0");
        EmulInstance reference2 = new EmulInstance(vm, "net.torvald.tsvm.peripheral.ReferenceLikeLCD", "assets/disk0");
        EmulInstance term = new EmulInstance(vm, "net.torvald.tsvm.peripheral.Term", "assets/disk0");
        EmulInstance portable = new EmulInstance(vm, "net.torvald.tsvm.peripheral.CharacterLCDdisplay", "assets/disk0");

        EmulInstance wp = new EmulInstance(vm, "net.torvald.tsvm.peripheral.WpTerm", "assets/wpdisk");

        new Lwjgl3Application(new VMGUI(wp), appConfig);
    }

    public static ShaderProgram loadShaderFromFile(String vert, String frag) {
        ShaderProgram s = new ShaderProgram(Gdx.files.internal(vert), Gdx.files.internal(frag));

        if (s.getLog().toLowerCase().contains("error")) {
            throw new Error(String.format("Shader program loaded with %s, %s failed:\n%s", vert, frag, s.getLog()));
        }

        return s;
    }

    public static ShaderProgram loadShaderInline(String vert, String frag) {
        ShaderProgram s = new ShaderProgram(vert, frag);

        if (s.getLog().toLowerCase().contains("error")) {
            throw new Error(String.format("Shader program loaded with %s, %s failed:\n%s", vert, frag, s.getLog()));
        }

        return s;
    }
}
