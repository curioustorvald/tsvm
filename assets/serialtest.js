println("Hello, world!")

filesystem.open("A", "fsh.js", "R");
let prg = filesystem.readAll("A");

println(prg);
eval(prg);