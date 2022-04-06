let s = []
for (let r=0;r<16;r++) {
for (let g=0;g<16;g++) {
for (let b=0;b<16;b++) {
    let rb = r*16+r
    let gb = g*16+r
    let bb = b*16+r
    s.push(rb,gb,bb)
}
}
}

filesystem.open("A","4096.data","W")
filesystem.writeBytes("A",s)