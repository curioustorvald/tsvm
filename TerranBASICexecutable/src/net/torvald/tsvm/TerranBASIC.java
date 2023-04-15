package net.torvald.tsvm;

import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration;
import com.badlogic.gdx.graphics.glutils.ShaderProgram;
import net.torvald.tsvm.peripheral.*;

import java.io.*;
import java.util.HashMap;

public class TerranBASIC {

    public static String appTitle = "TerranBASIC";
    public static Lwjgl3ApplicationConfiguration appConfig;

    public static int WIDTH = 640;
    public static int HEIGHT = 480;

    public static String OSName = System.getProperty("os.name");
    public static String OSVersion = System.getProperty("os.version");

    public static String operationSystem;
    /** %appdata%/TerranBASIC, without trailing slash */
    public static String defaultDir;
    /** For Demo version only. defaultDir + "/Saves", without trailing slash */
    public static String diskDir;

    private static void getDefaultDirectory() {
        String OS = OSName.toUpperCase();
        if (OS.contains("WIN")) {
            operationSystem = "WINDOWS";
            defaultDir = System.getenv("APPDATA") + "/TerranBASIC";
        }
        else if (OS.contains("OS X") || OS.contains("MACOS")) { // OpenJDK for mac will still report "Mac OS X" with version number "10.16", even on Big Sur and beyond
            operationSystem = "OSX";
            defaultDir = System.getProperty("user.home") + "/Library/Application Support/TerranBASIC";
        }
        else if (OS.contains("NUX") || OS.contains("NIX") || OS.contains("BSD")) {
            operationSystem = "LINUX";
            defaultDir = System.getProperty("user.home") + "/.TerranBASIC";
        }
        else if (OS.contains("SUNOS")) {
            operationSystem = "SOLARIS";
            defaultDir = System.getProperty("user.home") + "/.TerranBASIC";
        }
        else {
            operationSystem = "UNKNOWN";
            defaultDir = System.getProperty("user.home") + "/.TerranBASIC";
        }

        diskDir = defaultDir + "/My_Programs";

        System.out.println(String.format("os.name = %s (with identifier %s)", OSName, operationSystem));
        System.out.println(String.format("os.version = %s", OSVersion));
        System.out.println(String.format("default directory: %s", defaultDir));
        System.out.println(String.format("java version = %s", System.getProperty("java.version")));
    }


    private static void installSamplePrograms() {
        System.out.println("Installing sample programs...");

        String[] samplePrograms = {"99.bas","amazing.bas","array.bas","array0.bas","brb.bas","closure.bas","currying.bas","downkeys.bas","facclosure.bas","facmap.bas","factorial.bas","fib2.bas","fib3.bas","fibonacci.bas","funs.bas","hamurabi.bas","hangman.bas","highorder.bas","monadlaws.bas","monadlaws2.bas","myfirst.bas","plotter.bas","qsort.bas","recursion.bas","rmaze.bas","sqrt.bas","triangle1.bas","triangle2.bas","writermonad.bas","yourname.bas"};

        for (String s : samplePrograms) {
            try {
                byte[] prg = TerranBASIC.class.getClassLoader().getResourceAsStream("net/torvald/tsvm/TerranBasicSamplePrograms/"+s).readAllBytes();
                OutputStream prgOs = new BufferedOutputStream(new FileOutputStream(new File(diskDir, s)));
                prgOs.write(prg);
                prgOs.flush();prgOs.close();
                System.out.println(s);
            }
            catch (IOException e) {
                System.out.println(("Failed to install " + s));
                e.printStackTrace();
            }
        }

    }

    public static void main(String[] args) {
        getDefaultDirectory();

        File myProgramsDir = new File(diskDir);
        if (!myProgramsDir.exists()) {
            if (myProgramsDir.mkdirs())
                installSamplePrograms();
        }



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
