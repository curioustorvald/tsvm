# Syntax
## Reserved directories
* `$DEVICE<device_number>`

## Reserved files
* `$DEVICE<device_number>/$BOOT` — associates to bootloader, exact filename depends on the filesystem the device uses

# Drivers
Filesystem driver is just an executable that can do file I/O to one specific filesystem it supports.

Filesystem drivers, just as regular TVDOS drivers, resides in `<root>/TVDOS/DRIVERS/`

# Commands

## cp
`[cp|copy] <source> <destination>`

Executes following command:
```
<filesystem>.fs cp <source> <dest>
```

## mv
`[mv|move] <from> <to>`

Executes following command:
```
<filesystem>.fs mv <from> <to>
```

## touch
`touch <path>`

Executes following command:
```
<filesystem>.fs touch <path>
```

## format
`format -f [tsvm|flat|tree] [ -b <path_to_bootloader> ] <device_number>`

Executes following command:
```
<filesystem>.fs format <device_number> [ <path_to_bootloader> ]
```
