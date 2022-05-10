let SKIP_MEMTEST = 1
let BOOT_OVERRIDE = undefined // undefined or port number (int)

con.reset_graphics();con.curs_set(0);con.clear()
graphics.resetPalette()

const BIOS_VERSION_STR = "1.0"

function probeBootable() {
    let driveStatus = 0
    let bootable = [0,0,0,0]
    for (let portNumber = 0; portNumber < 4; portNumber++) {
        if (com.areYouThere(portNumber)) {
            com.sendMessage(portNumber, "LOADBOOT")
            driveStatus = com.getStatusCode(portNumber)
            if (driveStatus == 0) bootable[portNumber] = 1
        }
    }
    return bootable
}

function bootFromPort(port) {
    con.clear()
    try {
        com.sendMessage(port, "LOADBOOT")
        let driveStatus = com.getStatusCode(port)
        if (driveStatus == 0) {Function(`"use strict";var _BIOS={};_BIOS.FIRST_BOOTABLE_PORT=[${port},1];Object.freeze(_BIOS);`+com.fetchResponse(port).trimNull())()}
        else throw "No Bootsector"
    }
    catch (e) {
        printerrln(`No bootable medium on COM ${port+1}`)
    }
}

function showSplash() {
    println(`OpenBIOS version ${BIOS_VERSION_STR}`)
}

function showHowtoEnterMenu() {
    let s = `Hit Ctrl+Shift+S+Q or SysRq to enter boot menu`
    let [h,w] = con.getmaxyx()
    con.move(h, (w-s.length)/2)
    print(s)
}

function bootFromFirst() {
    con.clear()
    let port = (BOOT_OVERRIDE != undefined) ? BOOT_OVERRIDE : bootable.findIndex(it=>it==1)
    if (port < 0) printerrln("No bootable medium found.")
    else bootFromPort(port)
}

function runConfigurator() {
    sys.unsetSysrq()
    con.clear()
    con.move(2,2);print("Devices:")
    for (let i = 0; i < 4; i++) {
        con.move(i*2+4, 2)
        let bootableMark = (bootable[i]) ? "* " : "  "

        let deviceName = undefined
        try {
            com.sendMessage(i, "DEVNAM\x17")
            deviceName = com.fetchResponse(i).substring(0,40)
        }
        catch (e) {
            deviceName = `(device not connected)`
        }

        println(bootableMark + `Serial port #${i+1}: ` + deviceName)
    }

    let bootnum = undefined
    while (true) {
        con.move(12,1)
        con.curs_set(1)
        print("\n Hit 1, 2, 3 or 4 to boot from the specified device: ")
        let dev = Number(read())
        serial.println(dev)
        if (Number.isInteger(dev) && dev >= 1 && dev <= 4) {
            bootnum = dev - 1
            break
        }
    }
    bootFromPort(bootnum)
}



///////////////////////////////////////////////////////////////////////////////

// Perform memtest

if (!SKIP_MEMTEST) {
let memptr = 0
let reportedMemsize = system.maxmem()
const memtestptn = (reportedMemsize >= 4194304) ?
[
    [0x00,0xFF,0xAA,0x55]
] : (reportedMemsize >= 1048576) ?
[
    [0x00,0xFF,0xAA,0x55 , 0x69,0x0F,0xA5,0x1E]
] : (reportedMemsize >= 262144) ?
[
    [0x00,0xFF,0xAA,0x55 , 0x69,0x0F,0xA5,0x1E , 0xC7,0x71,0x8E,0xE3 , 0xCA,0xFE,0xBA,0xBE]
] :
[
    [0x00,0xFF,0xAA,0x55 , 0x69,0x0F,0xA5,0x1E , 0xC7,0x71,0x8E,0xE3 , 0xCA,0xFE,0xBA,0xBE],
    [0xFF,0xFF,0xFF,0xFF , 0xFF,0xFF,0xFF,0xFF , 0xFF,0xFF,0xFF,0xFF , 0xFF,0xFF,0xFF,0xFF]
]

con.move(2,1)
print(" 000 KB OK")

try {
    while (memptr < (8 << 20)) {
        // just print a number
        con.move(2,1)
        var memptrtext = ""+(1 + ((memptr) >> 10))
        print((memptrtext < 10) ? " 00"+memptrtext : (memptrtext < 100) ? " 0"+memptrtext : (memptrtext < 1000) ? " "+memptrtext : memptrtext)

        // perform memory test
        for (var ptn = 0; ptn < memtestptn.length; ptn++) {
            for (var bi = 0; bi < memtestptn[ptn].length; bi++) {
                sys.poke(memptr + bi, memtestptn[ptn][bi])
                if (memtestptn[ptn][bi] != sys.peek(memptr + bi)) throw "Memory Error"
            }
            /*for (var bi = 0; bi < memtestptn[ptn].length; bi++) {
                sys.poke(memptr + bi, 255 - memtestptn[ptn][bi])
                if (255 - memtestptn[ptn][bi] != sys.peek(memptr + bi)) throw "Memory Error"
            }*/
        }

        memptr += memtestptn[0].length
    }
    throw undefined
}
catch (e) {
    if (e == "Memory Error")
        println(" "+e)
    else
        println(" KB OK!")
}
}

///////////////////////////////////////////////////////////////////////////////


showSplash()
showHowtoEnterMenu()

let bootable = probeBootable()
let sysRq = false
let tmr = sys.nanoTime()
while (sys.nanoTime() - tmr < 5 * 1000000000.0) {
    sysRq = sys.getSysrq()
    if (sysRq) break
    sys.spin()
}

if (!sysRq) bootFromFirst()
else runConfigurator()
