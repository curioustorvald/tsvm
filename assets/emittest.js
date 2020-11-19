con.clear();
con.move(1,1);
for (let i = 0; i < 1024; i++) {
    if (i < 512) con.color_pair(239, 0); else con.color_pair(0, 239);

    let cx = (i%80)+1;
    let cy = ((i/80)|0)+1;
    //serial.printerr(cx+","+cy);
    con.move(cy,cx);
    con.addch(i%256);
}

println();