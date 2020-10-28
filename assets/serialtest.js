function getStatusMessage(portNo) {
    return com.sendMessageGetBytes(portNo, "DEVSTU"+String.fromCharCode(0x17));
}

let ba = com.sendMessageGetBytes(0, "DEVNAM"+String.fromCharCode(0x17));
serial.println(ba);

ba = com.pullMessage(0)
serial.print(ba);
serial.println("# END OF MSG");



ba = com.sendMessageGetBytes(1, "DEVNAM"+String.fromCharCode(0x17));
serial.println(ba);

serial.println(getStatusMessage(1));

ba = com.sendMessageGetBytes(1, "LIST");
ba = com.pullMessage(1);
println(ba);

serial.println(getStatusMessage(1));

com.sendMessage(1, "OPENR\"basic.js\"");

println("Status code: "+com.getStatusCode(1));

com.sendMessage(1, "READ");
println("Status code: "+com.getStatusCode(1));
let source = com.pullMessage(1);
println(source);

eval(source);

serial.println("k bye")