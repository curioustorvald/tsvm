println("Hit Ctrl-C or Ctrl-D to exit");
while (true) {
    let keys = con.poll_keys()
    println(keys);
    if (keys[1] == 129 && (keys[0] == 31 || keys[0] == 32)) break;
}