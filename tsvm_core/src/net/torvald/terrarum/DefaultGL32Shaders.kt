package net.torvald.terrarum

import com.badlogic.gdx.graphics.glutils.ShaderProgram


/**
 * Created by minjaesong on 2023-02-28
 */
object DefaultGL32Shaders {
    fun createSpriteBatchShader(): ShaderProgram {
        return ShaderProgram(gl32SpriteBatchVert, gl32SpriteBatchFrag)
    }

    fun createShapeRendererShader(): ShaderProgram {
        return ShaderProgram(gl32ShapeRendererVert, gl32ShapeRendererFrag)
    }

    private val gl32SpriteBatchVert = """
        #version 150

        in vec4 a_position;
        in vec4 a_color;
        in vec2 a_texCoord0;

        uniform mat4 u_projTrans;

        out vec4 v_color;
        out vec2 v_texCoords;

        void main() {
            v_color = a_color;
            v_color.a = v_color.a * (255.0/254.0);
            v_texCoords = a_texCoord0;
            gl_Position = u_projTrans * a_position;
        }
    """.trimIndent()

    private val gl32SpriteBatchFrag = """
        #version 150

        #ifdef GL_ES
        #define LOWP lowp
        precision mediump float;
        #else
        #define LOWP
        #endif

        in LOWP vec4 v_color;
        in vec2 v_texCoords;
        uniform sampler2D u_texture;
        out vec4 fragColor;

        void main() {
            fragColor = v_color * texture(u_texture, v_texCoords);
        }
    """.trimIndent()

    private val gl32ShapeRendererVert = """
        #version 150

        in vec4 a_position;
        in vec4 a_color;

        uniform mat4 u_projModelView;
        out vec4 v_col;

        void main() {
            gl_Position = u_projModelView * a_position;
            v_col = a_color;
            v_col.a *= 255.0 / 254.0;
            gl_PointSize = 1.0;
        }
    """.trimIndent()

    private val gl32ShapeRendererFrag = """
        #version 150

        #ifdef GL_ES
        precision mediump float;
        #endif

        in vec4 v_col;

        out vec4 fragColor;

        void main() {
            fragColor = v_col;
        }
    """.trimIndent()

}