println("Main RAM:"+(system.maxmem() >> 10)+" KBytes");

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

// load a BASIC rom
sys.mapRom(1);
eval("let basicrom=function(exec_args){"+sys.romReadAll()+"};basicrom;")();