println("TERRAN Megatrends inc.");
//println("Main RAM:"+(system.maxmem() >> 10)+" KBytes");

///////////////////////////////////////////////////////////////////////////////

// Perform memtest

let memptr = 0;
const memtestptn = [
    [0x00,0xFF,0xAA,0x55 , 0x69,0x0F,0xA5,0x1E , 0xC7,0x71,0x8E,0xE3 , 0xCA,0xFE,0xBA,0xBE],
    [0xFF,0xFF,0xFF,0xFF , 0xFF,0xFF,0xFF,0xFF , 0xFF,0xFF,0xFF,0xFF , 0xFF,0xFF,0xFF,0xFF]
];

con.move(2,1);
print("000 KB OK")

try {
    while (memptr < (8 << 20)) {
        // just print a number
        con.move(2,1);
        var memptrtext = ""+((memptr + 1) >> 10);
        print((memptrtext < 10) ? "00"+memptrtext : (memptrtext < 100) ? "0"+memptrtext : memptrtext);

        // perform memory test
        for (var ptn = 0; ptn < memtestptn.length; ptn++) {
            for (var bi = 0; bi < memtestptn[ptn].length; bi++) {
                sys.poke(memptr + bi, memtestptn[ptn][bi]);
                if (memtestptn[ptn][bi] != sys.peek(memptr + bi)) throw "Memory Error";
            }
            for (var bi = 0; bi < memtestptn[ptn].length; bi++) {
                sys.poke(memptr + bi, 255 - memtestptn[ptn][bi]);
                if (255 - memtestptn[ptn][bi] != sys.peek(memptr + bi)) throw "Memory Error";
            }
        }

        memptr += memtestptn[0].length;
    }
}
catch (e) {
    if (e == "Memory Error") {
        println(" Memory Error");
    }
    else {
        println(" KB OK!");
    }
}

///////////////////////////////////////////////////////////////////////////////

// probe bootable device

var _BIOS = {};

// Syntax: [Port, Drive-number]
// Port #0-3: Serial port 1-4
//      #4+ : Left for future extension
// Drive-number always starts at 1
_BIOS.FIRST_BOOTABLE_PORT = [0,1]; // ah screw it

Object.freeze(_BIOS);

///////////////////////////////////////////////////////////////////////////////

// load a bootsector using 'LOADBOOT'
let portNumber = 0;
let driveStatus = 0;
while (portNumber < 4) {
    if (com.areYouThere(portNumber)) {
        com.sendMessage(portNumber, "LOADBOOT");
        driveStatus = com.getStatusCode(portNumber);
        if (driveStatus == 0) break;
    }
    portNumber += 1;
}
if (portNumber < 4) {
    eval(com.fetchResponse(portNumber).trimNull());
}
else {
    printerrln("No bootable medium found.");
}