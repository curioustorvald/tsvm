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
        if ("No Bootsector" == e)
            printerrln(`No bootable medium on COM ${port+1}`)
        else
            printerrln(`Boot failed with errors:\n\n${e}`)

        serial.printerr(e)
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





function drawHeader() {
    let th = con.getmaxyx()[1]
    let fillerspc = ' '.repeat((th - 28) / 2)

    con.move(1,1)
    con.reset_graphics()
    print('  ')
    con.addch(17);con.curs_right()
    con.video_reverse()
    print(fillerspc)
    print('OpenBIOS Setup Utility')
    print(fillerspc)
    con.video_reverse()
    con.addch(16);con.curs_right()
    print('  ')
}

function drawMenubar() {
    for (let i = 0; i < configMenus.length; i++) {
        con.reset_graphics()
        con.move(3 + 2*i, configMenuX)
        if (i == configuratorMenu)
            con.video_reverse()
        print(configMenus[i])
    }
}

function clearInfoArea() {

}

function printSysInfo() {
    con.move(3,configContentsX)
    let rtmin=(sys.currentTimeInMills()/60000)|0
    let min=rtmin%60
    let h=((rtmin/60)|0)%24
    let od=((rtmin/1440)|0)%120
    let d=(od%30)+1
    let m=((rtmin/43200)|0)%4
    let dw=od%7 // 0 for Mondag
    if (119==od) dw=7 // Verddag
    let y=((rtmin/5184000)|0)+125

    print(`Current Time  \xE7${y} ${["Spring","Summer","Autumn","Winter"][m]} ${d} ${["Mondag","Tysdag","Midtveke","Torsdag","Fredag","Laurdag","Sundag","Verddag"][dw]} ${(''+h).padStart(2,'0')}:${(''+min).padStart(2,'0')}`)

    let ut = (sys.uptime()/1000)|0
    let uh = (ut/3600)|0
    let um = ((ut/60)|0)%60
    let us = ut%60

    con.move(4,configContentsX-1)
    print(`System uptime  ${uh}h${um}m${us}s`)

    con.move(6,configContentsX)
    print(` User RAM  ${sys.maxmem()>>>10} Kbytes`)
    con.move(7,configContentsX)
    print(`Video RAM  ${256*sys.peek(-131084)} Kbytes`)
}

function printSerialDevs() {

}

function printExpCards() {

}

function printBMS() {

}

const configMenuX = 4
const configContentsX = 28
let configuratorMenu = 0
const configMenus = [" System Info ", " Serial Devices ", " Expansion Cards ", " Power Status "]
const menuFunctions = [printSysInfo, printSerialDevs, printExpCards, printBMS]

function runConfigurator() {
    sys.unsetSysrq()
    con.clear()
    drawHeader()
    drawMenubar()

    clearInfoArea()
    menuFunctions[configuratorMenu]()
}

///////////////////////////////////////////////////////////////////////////////

showSplash()
showHowtoEnterMenu()

let bootable = probeBootable()
let sysRq = false
let tmr = sys.nanoTime()
while (sys.nanoTime() - tmr < 3 * 1000000000.0) {
    sysRq = sys.getSysrq()
    if (sysRq) break
    sys.spin()
}

if (!sysRq) bootFromFirst()
else runConfigurator()

sys.poke(-90,128)