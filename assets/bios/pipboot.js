println("Hello, Personal Information Processor!")

while (1) {
    for (let i = 0; i <= 160*140; i++) {
        sys.poke(-1048576 - i, Math.round(Math.random()*15));
    }
}