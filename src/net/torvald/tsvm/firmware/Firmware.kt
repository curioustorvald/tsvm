package net.torvald.tsvm.firmware

import net.torvald.UnsafePtr
import net.torvald.tsvm.VM
import net.torvald.tsvm.kB
import net.torvald.tsvm.peripheral.PeriBase
import org.luaj.vm2.LuaTable
import org.luaj.vm2.LuaValue
import org.luaj.vm2.lib.OneArgFunction
import org.luaj.vm2.lib.TwoArgFunction

internal class Firmware(val vm: VM) {

    val t = LuaTable()

    fun errorIllegalAccess(addr: Long) {

    }

    private fun translateAddr(addr: LuaValue): Pair<Any?, Long> {
        val addr = addr.checklong()
        return when (addr) {
            // DO note that numbers in Lua are double precision floats (ignore Lua 5.3 for now)
            in 0..8192.kB() - 1 -> vm.usermem to addr
            in -1024.kB()..-1 -> vm.peripheralTable[0].peripheral to (-addr - 1)
            in -2048.kB()..-1024.kB()-1 -> vm.peripheralTable[1].peripheral to (-addr - 1 - 1024.kB())
            in -3072.kB()..-2048.kB()-1 -> vm.peripheralTable[2].peripheral to (-addr - 1 - 2048.kB())
            in -4096.kB()..-3072.kB()-1 -> vm.peripheralTable[3].peripheral to (-addr - 1 - 3072.kB())
            in -5120.kB()..-4096.kB()-1 -> vm.peripheralTable[4].peripheral to (-addr - 1 - 4096.kB())
            in -6144.kB()..-5120.kB()-1 -> vm.peripheralTable[5].peripheral to (-addr - 1 - 5120.kB())
            in -7168.kB()..-6144.kB()-1 -> vm.peripheralTable[6].peripheral to (-addr - 1 - 6144.kB())
            in -8192.kB()..-7168.kB()-1 -> vm.peripheralTable[7].peripheral to (-addr - 1 - 7168.kB())
            else -> null to addr
        }
    }

    init {
        t["poke"] = object : TwoArgFunction() {
            override fun call(addr: LuaValue, value: LuaValue): LuaValue {
                val (memspace, offset) = translateAddr(addr)
                if (memspace == null)
                    errorIllegalAccess(addr.checklong())
                else if (memspace is UnsafePtr)
                    memspace.set(offset, value.checkint().toByte())
                else
                    (memspace as PeriBase).poke(offset, value.checkint().toByte())
                return LuaValue.NIL
            }
        }

        t["peek"] = object : OneArgFunction() {
            override fun call(addr: LuaValue): LuaValue {
                val (memspace, offset) = translateAddr(addr)
                return if (memspace == null)
                    LuaValue.NIL
                else if (memspace is UnsafePtr)
                    memspace.get(offset).toLuaValue()
                else
                    (memspace as PeriBase).peek(offset)?.toLuaValue() ?: LuaValue.NIL
            }
        }
    }


    fun Byte.toLuaValue() = LuaValue.valueOf(this.toInt())
}