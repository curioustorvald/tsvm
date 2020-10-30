// load TVDOS.SYS
let p = _BIOS.FIRST_BOOTABLE_PORT;
com.sendMessage(p[0], "DEVRST\x17");
com.sendMessage(p[0], 'OPENR"tvdos/TVDOS.SYS",'+p[1]);
let r = com.getStatusCode(p[0]);
if (r == 0){
    com.sendMessage(p[0], "READ");
    r = com.getStatusCode([0]);
    if (r == 0) {
        let g=com.pullMessage(p[0]);
        eval(g);
        0;
    }
    else
        println("I/O Error");
}
else
    println("TVDOS.SYS not found");
