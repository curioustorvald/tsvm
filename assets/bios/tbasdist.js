println("TSVM - Copyright 2020 CuriousTorvald");

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
            execAppPrg();
            return 0;
        }
        catch (e) {
            printerrln("\nApp Execution Error: "+(e.stack || e));
            return 1;
        }
    }
    else
        printerrln("I/O Error");
}
else
    printerrln("No bootable medium found.");