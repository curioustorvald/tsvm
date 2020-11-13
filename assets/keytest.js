println("Hit Ctrl-C or Ctrl-D to exit");
while (true) {
    let key = con.getch()
    println(key);
    if (key == 3 || key == 4) break;
}