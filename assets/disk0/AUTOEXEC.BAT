echo "Starting TVDOS..."

rem put set-xxx commands here:
set PATH=\tvdos\installer;\tvdos\tuidev;\tbas;\hopper\bin;$PATH
set INCLPATH=\hopper\include;$INCLPATH
set KEYBOARD=us_colemak

rem this line specifies which shell to be presented after the boot precess:
tvdos/i18n/korean
zfm
command -fancy
