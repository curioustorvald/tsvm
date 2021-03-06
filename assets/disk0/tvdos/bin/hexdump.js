if (exec_args[1] === undefined) {
    printerrln("Usage: hexdump <file>")
    return 1;
}

let fileOpened = filesystem.open(_G.shell.getCurrentDrive(), _G.shell.resolvePathInput(exec_args[1]).string, "R");
if (!fileOpened) {
    printerrln(_G.shell.resolvePathInput(exec_args[1]).string+": cannot open");
    return 1;
}
let fileContent = filesystem.readAll(_G.shell.getCurrentDrive());
let visible = "";

for (let k = 0; k < fileContent.length; k++) {
    if (k > 0 && k % 16 == 0) visible += "\n";
    visible += `${fileContent.charCodeAt(k).toString(16).toUpperCase().padStart(2, '0')} `;
}

println(visible);
return 0;