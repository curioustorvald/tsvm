var ba = com.sendMessageGetBytes(0, [0x44,0x45,0x56,0x4e,0x41,0x4d,0x17]);
serial.println(ba);
for (let k = 0; k < 4096; k++) {
    serial.print(String.fromCharCode(ba[k]));
}
serial.print("\n");

ba = com.pullMessage(0)
for (let k = 0; k < 4096; k++) {
    serial.print(String.fromCharCode(ba[k]));
}
serial.print("\n");

serial.println("\nk bye")