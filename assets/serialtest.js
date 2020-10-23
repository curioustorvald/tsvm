var ba = com.sendMessageGetBytes(0, "DEVNAM"+String.fromCharCode(0x17));
serial.println(ba);

ba = com.pullMessage(0)
serial.println(ba);

serial.println("\nk bye")