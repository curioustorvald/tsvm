con.curs_set(0)
con.clear()
let t=`${system.maxmem()>>>10} Kbytes System`
let imageBits = gzip.decomp(base64.atob(
"H4sICC62h2ACA3RhbmRlbV9sb2dvXzI0MC5iaW4AhdQ/bsMgGAXwh4hEhyisHSq5R+iYISpX6REydqhkjsZRfASPDJbJ449jQuxUspDsn2XD+z6wAMSIPjiECQOgAwcoIMwQNuoAQ+2TilZlrehbdeioJqspypeTqgfttrXLqhvVljO9qypq/IPqrLLRblcZQQi8oyqqClZwiI+6cdHPVYcdlUnHVmdc5aooypVV+iaS+lYnXMUr9dQjkk6LMsEt/YkRcKL8WlQPj+BO+NtW/vFZpc06Ununcan1S9r3rHL+X+3HgwpkHaim1bPglVSFqFzTpsZeWzWncUZRd+DLTg+HOskL8Jv1+ErtiZk7PaKu4I6W6n8jph+1S+pRd85dOX/Wq6h9UmOjTqg71kAsykD2dI4qnZ5R75RVexbirmWXGSuTTlGF0wH1Dt1R02pg81BtfTIYp5L6qFh0OVWe1NUnUtIb4Dr/QbAEAAA="
))
for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 30; x++) {
        let octet = imageBits[y * 30 + x]
        for (let i = 0; i < 8; i++) {
            graphics.plotPixel(8*x + i, y+8, ((octet >>> (7 - i)) & 1 != 0) ? 255 : 239)
        }
    }
}
con.move(8,1+(40-t.length>>1))
print(t)
// wait arbitrary time
for (let b=0;b<system.maxmem()*10;b++) {
    sys.poke(0,(Math.random()*255)|0)
    sys.poke(0,0)
}
con.clear()
graphics.clearPixels(255)

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