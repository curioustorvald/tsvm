let tmp = files.open("$:/TMP/test.txt")
tmp.swrite("Hello, world!")
println(tmp.sread())
tmp.close()