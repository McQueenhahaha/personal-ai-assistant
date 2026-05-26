Option Explicit

Dim shell, scriptPath, command, i

If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If

scriptPath = WScript.Arguments(0)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & scriptPath & Chr(34)

For i = 1 To WScript.Arguments.Count - 1
  command = command & " " & Chr(34) & WScript.Arguments(i) & Chr(34)
Next

Set shell = CreateObject("WScript.Shell")
shell.Run command, 0, False
