package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM

/**
 * Created by minjaesong on 2024-08-12.
 */
open class RemoteGraphicsAdapter(assetsRoot: String, vm: VM, config: AdapterConfig, sgr: SuperGraphicsAddonConfig = SuperGraphicsAddonConfig()) : GraphicsAdapter(assetsRoot, vm, config, sgr) {

    override fun applyDelay() {
        applyDelay0()
    }
}