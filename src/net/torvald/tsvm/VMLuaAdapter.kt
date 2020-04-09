package net.torvald.tsvm

import net.torvald.tsvm.firmware.Firmware
import org.luaj.vm2.lib.jse.JsePlatform

class VMLuaAdapter(val vm: VM) {

    val lua = JsePlatform.standardGlobals()

    init {
        lua.load(Firmware(vm))
        lua.load("_G.int = function(n) if n > 0 then return math.floor(n) else return math.ceil(n) end end").call()
    }

}