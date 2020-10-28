var ba = com.sendMessageGetBytes(0, "DEVNAM"+String.fromCharCode(0x17));
serial.println(ba);

ba = com.pullMessage(0)
serial.print(ba);
serial.println("# END OF MSG");



ba = com.sendMessageGetBytes(1, "DEVNAM"+String.fromCharCode(0x17));
serial.println(ba);

ba = com.sendMessageGetBytes(1, "DEVSTU"+String.fromCharCode(0x17));
serial.println(ba);

ba = com.sendMessageGetBytes(1, "LIST");
ba = com.pullMessage(1);
println(ba);

ba = com.sendMessageGetBytes(1, "DEVSTU"+String.fromCharCode(0x17));
serial.println(ba);


serial.println("k bye")