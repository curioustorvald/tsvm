package net.torvald.tsvm

import com.badlogic.gdx.graphics.glutils.FrameBuffer
import java.util.*

/**
 * Nested FBOs are just not a thing in GL!
 *
 * Created by minjaesong on 2018-07-03.
 *
 * @link https://stackoverflow.com/questions/25471727/libgdx-nested-framebuffer
 */
internal object FBM {
    private val stack = Stack<FrameBuffer>()

    fun begin(buffer: FrameBuffer) {
        if (!stack.isEmpty()) {
            stack.peek().end()
        }
        stack.push(buffer).begin()
    }

    fun end() {
        stack.pop().end()
        if (!stack.isEmpty()) {
            stack.peek().begin()
        }
    }
}