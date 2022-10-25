package net.torvald.tsvm;

import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration;
import com.badlogic.gdx.graphics.Texture;
import com.badlogic.gdx.graphics.glutils.ShaderProgram;
import com.badlogic.gdx.Gdx;

/**
 * Created by minjaesong on 2022-10-22.
 */
public class TsvmEmulator {


    public static String appTitle = "tsvm";
    public static Lwjgl3ApplicationConfiguration appConfig;

    public static int WIDTH = 640 * 2;
    public static int HEIGHT = 480 * 2;



    public static void main(String[] args) {
        ShaderProgram.pedantic = false;

        appConfig = new Lwjgl3ApplicationConfiguration();
        appConfig.setIdleFPS(60);
        appConfig.setForegroundFPS(60);
        appConfig.useVsync(false);
        appConfig.setResizable(false);
        appConfig.setTitle(appTitle);

        appConfig.setWindowedMode(WIDTH, HEIGHT);

        new Lwjgl3Application(new VMEmuExecutableWrapper(640, 480, 2, 2,"assets/"), appConfig);
    }

}
