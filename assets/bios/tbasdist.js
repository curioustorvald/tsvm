println("TSVM - Copyright 2020-2023 CuriousTorvald");

var _BIOS = {};

// Syntax: [Port, Drive-number]
// Port #0-3: Serial port 1-4
//      #4+ : Left for future extension
// Drive-number always starts at 1
_BIOS.FIRST_BOOTABLE_PORT = [0,1]; // ah screw it

Object.freeze(_BIOS);

///////////////////////////////////////////////////////////////////////////////

// load basic.js
let p = _BIOS.FIRST_BOOTABLE_PORT;
com.sendMessage(0, "DEVRST\x17");
com.sendMessage(0, 'OPENR"tbas/basic.js",1');
let r = com.getStatusCode(0);

if (r == 0){
    com.sendMessage(0, "READ");
    r = com.getStatusCode(0);
    if (r == 0) {
        try {
            println("Reading basic.js...");
            let g=com.pullMessage(0);
            let execAppPrg = eval("var _appStub=function(exec_args){"+g+"};_appStub;"); // making 'exec_args' a app-level global

            // show TerranBASIC on the character LCD (aka the window title)
            [..."TerranBASIC"].map(s=>s.charCodeAt(0)).forEach((c,i)=>{
                sys.poke(-1025 - i, c)
            })

            execAppPrg();
        }
        catch (e) {
            printerrln("\nApp Execution Error: "+(e.stack || e));
        }
    }
    else
        printerrln("I/O Error");
}
else
    printerrln("No bootable medium found.");

println("CPU halted");