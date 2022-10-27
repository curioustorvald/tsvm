let ut = (sys.uptime()/1000)|0
let uh = (ut/3600)|0
let um = ((ut/60)|0)%60
let us = ut%60
let [vw,vh] = graphics.getPixelDimension()
let CSI = "\x1B["
let LOGO = "\x1B[37m\x1B[40m"
let TEXT = "\x1B[m"

println(`
${LOGO}    ..                                        ${TEXT}
${LOGO}   ,##                                        ${TEXT} OS: ${_TVDOS.variables.OS_NAME}
${LOGO} ,@######:,dW#######W:    -%-*#=    :###=     ${TEXT} Version: ${_TVDOS.VERSION}
${LOGO} ######%+:%##MMMMMM##@.  :@"*###:  .@###@:    ${TEXT} Uptime: ${uh}h${um}m${us}s
${LOGO}  :###   :@#Wwwwwo,*@#% .@*+@*@#@. %@#*%#@,   ${TEXT} Shell: command.js
${LOGO}  :###,   "*MMMM##@:#@##%#=@- *@#%*@#% *@#@,  ${TEXT} Resolution: ${vw}x${vh}
${LOGO}  .###WwwwwwwwwwW#@: %##@+@+   #@@@@@.  #@#@, ${TEXT} User RAM: ${sys.maxmem()>>>10} KB
${LOGO}   "%MMMMMMMMMMMMP'  '%###+     ####:    #### ${TEXT} Video RAM: ${256*sys.peek(-131084)} KB
${LOGO}                                              ${TEXT}
`)