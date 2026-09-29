Dim sRoot, oShell
Set oShell = CreateObject("WScript.Shell")
sRoot = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' Run start.py using pythonw (no console window at all)
' Window style 0 = hidden, False = don't wait for completion
oShell.Run "pythonw.exe """ & sRoot & "\start.py""", 0, False
