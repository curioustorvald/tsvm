package net.torvald.tsvm

import com.badlogic.gdx.graphics.glutils.ShaderProgram

/**
 * Created by minjaesong on 2021-12-03.
 */
internal object LoadShader {
    operator fun invoke(vert: String, frag: String): ShaderProgram {
        val s = ShaderProgram(vert, frag)

        if (s.log.toLowerCase().contains("error")) {
            throw Error(String.format("Shader program loaded with %s, %s failed:\n%s", vert, frag, s.log))
        }

        return s
    }
}