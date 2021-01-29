
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