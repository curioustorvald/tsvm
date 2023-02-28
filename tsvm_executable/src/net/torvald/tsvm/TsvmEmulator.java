package net.torvald.tsvm;

import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration;
import com.badlogic.gdx.graphics.Texture;
import com.badlogic.gdx.graphics.glutils.ShaderProgram;
import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.utils.JsonValue;
import net.torvald.terrarum.KVHashMap;
import net.torvald.terrarum.serialise.WriteConfig;
import net.torvald.terrarum.utils.JsonFetcher;

import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * Created by minjaesong on 2022-10-22.
 */
public class TsvmEmulator {


    public static String appTitle = "tsvm";
    public static Lwjgl3ApplicationConfiguration appConfig;

    public static int PANELS_X = 2;
    public static int PANELS_Y = 2;
    public static int VIEWPORT_W = 640;
    public static int VIEWPORT_H = 480;

    public static int WIDTH = VIEWPORT_W * PANELS_X;
    public static int HEIGHT = VIEWPORT_H * PANELS_Y;

    public static String OSName = System.getProperty("os.name");
    public static String OSVersion = System.getProperty("os.version");
    public static String operationSystem;
    /** %appdata%/Terrarum, without trailing slash */
    public static String defaultDir;
    /** defaultDir + "/config.json" */
    public static String configDir;
    /** defaultDir + "/profiles.json" */
    public static String profilesDir;

    public static KVHashMap gameConfig = new KVHashMap();

    public static void main(String[] args) {
        ShaderProgram.pedantic = false;

        getDefaultDirectory();

        // initialise the game config
        for (Map.Entry<String, Object> entry : DefaultConfig.INSTANCE.getHashMap().entrySet()) {
            gameConfig.set(entry.getKey(), entry.getValue());
        }

        // actually read the config.json
        try {
            // read from disk and build config from it
            JsonValue map = JsonFetcher.INSTANCE.invoke(configDir);

            // make config
            for (JsonValue entry = map.child; entry != null; entry = entry.next) {
                setToGameConfigForced(entry, null);
            }
        }
        catch (IOException e) {
            // write default config to game dir. Call th.is method again to read config from it.
            try {
                createConfigJson();
            }
            catch (IOException e1) {
                System.out.println("[AppLoader] Unable to write config.json file");
                e.printStackTrace();
            }
        }

        PANELS_X = Math.max(2, getConfigInt("viewports_cols"));
        PANELS_Y = Math.max(2, getConfigInt("viewports_rows"));
        VIEWPORT_W = Math.max(560, getConfigInt("viewport_width"));
        VIEWPORT_H = Math.max(448, getConfigInt("viewport_height"));
        WIDTH = VIEWPORT_W * PANELS_X;
        HEIGHT = VIEWPORT_H * PANELS_Y;

        appConfig = new Lwjgl3ApplicationConfiguration();
        appConfig.setOpenGLEmulation(Lwjgl3ApplicationConfiguration.GLEmulation.GL30, 3, 2);
        appConfig.setIdleFPS(60);
        appConfig.setForegroundFPS(60);
        appConfig.useVsync(false);
        appConfig.setResizable(false);
        appConfig.setTitle(appTitle);

        appConfig.setWindowedMode(WIDTH, HEIGHT);

        try {
            new Lwjgl3Application(new VMEmuExecutableWrapper(VIEWPORT_W, VIEWPORT_H, PANELS_X, PANELS_Y, "assets/"), appConfig);
        }
        catch (Throwable e) {
            e.printStackTrace();
            if (Gdx.app != null) Gdx.app.exit();
        }
    }

    private static void getDefaultDirectory() {
        String OS = OSName.toUpperCase();
        if (OS.contains("WIN")) {
            operationSystem = "WINDOWS";
            defaultDir = System.getenv("APPDATA") + "/tsvmdevenv";
        }
        else if (OS.contains("OS X") || OS.contains("MACOS")) { // OpenJDK for mac will still report "Mac OS X" with version number "10.16", even on Big Sur and beyond
            operationSystem = "OSX";
            defaultDir = System.getProperty("user.home") + "/Library/Application Support/tsvmdevenv";
        }
        else if (OS.contains("NUX") || OS.contains("NIX") || OS.contains("BSD")) {
            operationSystem = "LINUX";
            defaultDir = System.getProperty("user.home") + "/.tsvmdevenv";
        }
        else if (OS.contains("SUNOS")) {
            operationSystem = "SOLARIS";
            defaultDir = System.getProperty("user.home") + "/.tsvmdevenv";
        }
        else {
            operationSystem = "UNKNOWN";
            defaultDir = System.getProperty("user.home") + "/.tsvmdevenv";
        }

        configDir = defaultDir + "/config.json";
        profilesDir = defaultDir + "/profiles.json";

        System.out.println(String.format("os.name = %s (with identifier %s)", OSName, operationSystem));
        System.out.println(String.format("os.version = %s", OSVersion));
        System.out.println(String.format("default directory: %s", defaultDir));
        System.out.println(String.format("java version = %s", System.getProperty("java.version")));
    }


    private static void createConfigJson() throws IOException {
        File configFile = new File(configDir);

        if (!configFile.exists() || configFile.length() == 0L) {
            WriteConfig.INSTANCE.invoke();
        }
    }

    /**
     * Will forcibly overwrite previously loaded config value.
     *
     * Key naming convention will be 'modName:propertyName'; if modName is null, the key will be just propertyName.
     *
     * @param value JsonValue (the key-value pair)
     * @param modName module name, nullable
     */
    public static void setToGameConfigForced(JsonValue value, String modName) {
        gameConfig.set((modName == null) ? value.name : modName+":"+value.name,
                value.isArray() ? value.asDoubleArray() :
                        value.isDouble() ? value.asDouble() :
                                value.isBoolean() ? value.asBoolean() :
                                        value.isLong() ? value.asInt() :
                                                value.asString()
        );
    }

    /**
     * Will not overwrite previously loaded config value.
     *
     * Key naming convention will be 'modName:propertyName'; if modName is null, the key will be just propertyName.
     *
     * @param value JsonValue (the key-value pair)
     * @param modName module name, nullable
     */
    public static void setToGameConfig(JsonValue value, String modName) {
        String key = (modName == null) ? value.name : modName+":"+value.name;
        if (gameConfig.get(key) == null) {
            gameConfig.set(key,
                    value.isArray() ? value.asDoubleArray() :
                            value.isDouble() ? value.asDouble() :
                                    value.isBoolean() ? value.asBoolean() :
                                            value.isLong() ? value.asInt() :
                                                    value.asString()
            );
        }
    }

    /**
     *
     * @return true on successful, false on failure.
     */
    private static Boolean readConfigJson() {
        try {
            // read from disk and build config from it
            JsonValue map = JsonFetcher.INSTANCE.invoke(configDir);

            // make config
            for (JsonValue entry = map.child; entry != null; entry = entry.next) {
                setToGameConfigForced(entry, null);
            }

            return true;
        }
        catch (IOException e) {
            // write default config to game dir. Call th.is method again to read config from it.
            try {
                createConfigJson();
            }
            catch (IOException e1) {
                System.out.println("[AppLoader] Unable to write config.json file");
                e.printStackTrace();
            }

            return false;
        }

    }

    /**
     * Return config from config set. If the config does not exist, default value will be returned.
     * @param key
     * *
     * @return Config from config set or default config if it does not exist.
     * *
     * @throws NullPointerException if the specified config simply does not exist.
     */
    public static int getConfigInt(String key) {
        Object cfg = getConfigMaster(key);

        if (cfg instanceof Integer) return ((int) cfg);

        double value = (double) cfg;

        if (Math.abs(value % 1.0) < 0.00000001)
            return (int) Math.round(value);
        return ((int) cfg);
    }

    /**
     * Return config from config set. If the config does not exist, default value will be returned.
     * @param key
     * *
     * @return Config from config set or default config if it does not exist.
     * *
     * @throws NullPointerException if the specified config simply does not exist.
     */
    public static double getConfigDouble(String key) {
        Object cfg = getConfigMaster(key);
        return (cfg instanceof Integer) ? (((Integer) cfg) * 1.0) : ((double) (cfg));
    }

    /**
     * Return config from config set. If the config does not exist, default value will be returned.
     * @param key
     * *
     * @return Config from config set or default config if it does not exist.
     * *
     * @throws NullPointerException if the specified config simply does not exist.
     */
    public static String getConfigString(String key) {
        Object cfg = getConfigMaster(key);
        return ((String) cfg);
    }

    /**
     * Return config from config set. If the config does not exist, default value will be returned.
     * @param key
     * *
     * @return Config from config set or default config if it does not exist. If the default value is undefined, will return false.
     */
    public static boolean getConfigBoolean(String key) {
        try {
            Object cfg = getConfigMaster(key);
            return ((boolean) cfg);
        }
        catch (NullPointerException keyNotFound) {
            return false;
        }
    }

    /**
     * Get config from config file. If the entry does not exist, get from defaults; if the entry is not in the default, NullPointerException will be thrown
     */
    private static HashMap<String, Object> getDefaultConfig() {
        return DefaultConfig.INSTANCE.getHashMap();
    }

    private static Object getConfigMaster(String key1) {
        String key = key1.toLowerCase();

        Object config;
        try {
            config = gameConfig.get(key);
        }
        catch (NullPointerException e) {
            config = null;
        }

        Object defaults;
        try {
            defaults = getDefaultConfig().get(key);
        }
        catch (NullPointerException e) {
            defaults = null;
        }

        if (config == null) {
            if (defaults == null) {
                throw new NullPointerException("key not found: '" + key + "'");
            }
            else {
                return defaults;
            }
        }
        else {
            return config;
        }
    }

    public static void setConfig(String key, Object value) {
        gameConfig.set(key.toLowerCase(), value);
    }


}
