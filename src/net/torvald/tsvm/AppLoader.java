package net.torvald.tsvm;

import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.backends.lwjgl.LwjglApplication;
import com.badlogic.gdx.backends.lwjgl.LwjglApplicationConfiguration;
import com.badlogic.gdx.graphics.Texture;
import com.badlogic.gdx.graphics.glutils.ShaderProgram;
import net.torvald.tsvm.peripheral.*;

public class AppLoader {

    public static String appTitle = "Totally Simple Virtual Machine";
    public static LwjglApplicationConfiguration appConfig;

    public static void main(String[] args) {
        ShaderProgram.pedantic = false;

        appConfig = new LwjglApplicationConfiguration();
        appConfig.foregroundFPS = 60;
        appConfig.backgroundFPS = 60;
        appConfig.vSyncEnabled = false;
        appConfig.useGL30 = false;
        appConfig.resizable = false;
        appConfig.title = appTitle;
        appConfig.forceExit = true;
        appConfig.width = 720;//480;
        appConfig.height = 480;//128;


        // val vm = VM(64.kB(), TheRealWorld(), arrayOf(GenericBios))
        //VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{BasicBios.INSTANCE, BasicRom.INSTANCE});
        //VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{OEMBios.INSTANCE, BasicRom.INSTANCE});
        VM vm = new VM(32 << 10, new TheRealWorld(), new VMProgramRom[]{TandemBios.INSTANCE, BasicRom.INSTANCE});
        //VM vm = new VM(64 << 10, new TheRealWorld(), new VMProgramRom[]{TBASRelBios.INSTANCE});

        EmulInstance reference = new EmulInstance(appConfig, vm, "net.torvald.tsvm.peripheral.ReferenceGraphicsAdapter", "assets/disk0");
        EmulInstance reference2 = new EmulInstance(appConfig, vm, "net.torvald.tsvm.peripheral.ReferenceLikeLCD", "assets/disk0");
        EmulInstance term = new EmulInstance(appConfig, vm, "net.torvald.tsvm.peripheral.TexticsAdapter", "assets/disk0");
        EmulInstance portable = new EmulInstance(appConfig, vm, "net.torvald.tsvm.peripheral.CharacterLCDdisplay", "assets/disk0");

        new LwjglApplication(new VMGUI(portable), appConfig);
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
