con.curs_set(0)
con.clear()
let t=`${system.maxmem()>>>10} Kbytes System`
// 0b_HL where H is top pixel
// H-bits
let imgh = [
[252,0,3,0,0],
[48,0,3,0,0],
[51,239,191,102,255],
[51,237,191,66,219],
[52,45,161,126,219],
[54,109,179,124,219]];
// L-bits
let imgl = [
[252,0,3,0,0],
[51,207,31,60,254],
[48,109,191,66,219],
[54,109,179,102,219],
[52,45,161,96,219],
[51,237,159,60,219]];
let imgc = [32,220,223,219]
for (let y=0;y<imgh.length;y++) {
for (let x=0;x<imgh[0].length;x++) {
for (let b=7;b>=0;b--) {
con.mvaddch(y+1,1+x*8+7-b,imgc[(imgh[y][x]>>b&1)<<1|imgl[y][x]>>b&1])
}}}
con.move(8,1+(40-t.length>>1))
print(t)
// wait arbitrary time
for (let b=0;b<333333;b++) {
    sys.poke(0,(Math.random()*255)|0)
    sys.poke(0,0)
}
con.clear();

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