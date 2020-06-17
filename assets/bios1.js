println("TERRAN Megatrends inc.");
//println("Main RAM:"+(system.maxmem() >> 10)+" KBytes");

var memptr = 0;
var memtestptn = [0xAA,0x55,0xAA,0x55 , 0x00,0xFF,0x00,0xFF , 0x01,0x02,0x04,0x08 , 0x10,0x20,0x40,0x80];

try {
    while (memptr < (8 << 20)) {
        // just print a number
        con.move(2,1);
        print(memptr >> 10);

        // perform memory test
        memtestptn.forEach(function(v,i,arr) {
            sys.poke(memptr + i, v);
            if (v != sys.peek(memptr + i)) throw "Memory Error";
        });

        memptr += memtestptn.length;
    }
}
catch (e) {
    if (e == "Memory Error") {
        println(" Memory Error");
    }
    else {
        println(" KB OK");
    }
}

con.move(4,1);