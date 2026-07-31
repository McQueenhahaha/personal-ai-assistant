param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("click", "move", "type", "key")]
  [string]$Action,
  [int]$X,
  [int]$Y,
  [AllowEmptyString()]
  [string]$Text,
  [string]$Key
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"
$env:APPDATA = [Environment]::GetFolderPath("ApplicationData")

$Root = Split-Path -Parent $PSScriptRoot
$AuditFile = Join-Path $Root "data\logs\audit.jsonl"
$PauseFile = Join-Path $Root "data\state\assistant-paused.flag"

function Write-InputAudit {
  param(
    [string]$Reason,
    [string]$Result
  )

  $record = [ordered]@{
    ts = (Get-Date).ToUniversalTime().ToString("o")
    kind = "input-injection"
    tier = "T2"
    reason = $Reason
    result = $Result
  }
  $parent = Split-Path -Parent $AuditFile
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $json = $record | ConvertTo-Json -Compress
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::AppendAllText($AuditFile, $json + [Environment]::NewLine, $utf8NoBom)
}

if (Test-Path -LiteralPath $PauseFile) {
  Write-InputAudit -Reason "assistant-paused.flag is present" -Result "denied"
  [Console]::Error.WriteLine("Input injection refused: assistant-paused.flag is present.")
  exit 2
}

try {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AssistantInputNative
{
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    private static void SendKeyboard(INPUT[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput sent " + sent + " of " + inputs.Length + " events.");
        }
    }

    public static void SendUnicodeText(string text)
    {
        if (text == null) throw new ArgumentNullException("text");
        INPUT[] inputs = new INPUT[text.Length * 2];
        for (int i = 0; i < text.Length; i++)
        {
            inputs[i * 2].type = INPUT_KEYBOARD;
            inputs[i * 2].data.keyboard.scanCode = text[i];
            inputs[i * 2].data.keyboard.flags = KEYEVENTF_UNICODE;
            inputs[i * 2 + 1] = inputs[i * 2];
            inputs[i * 2 + 1].data.keyboard.flags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        }
        if (inputs.Length > 0) SendKeyboard(inputs);
    }

    public static void SendVirtualKey(ushort virtualKey)
    {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].data.keyboard.virtualKey = virtualKey;
        inputs[1] = inputs[0];
        inputs[1].data.keyboard.flags = KEYEVENTF_KEYUP;
        SendKeyboard(inputs);
    }

    public static void MoveCursor(int x, int y)
    {
        if (!SetCursorPos(x, y)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SetCursorPos failed.");
    }

    public static void LeftClick(int x, int y)
    {
        MoveCursor(x, y);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }
}
"@

  switch ($Action) {
    "click" {
      if (-not $PSBoundParameters.ContainsKey("X") -or -not $PSBoundParameters.ContainsKey("Y")) {
        throw "-X and -Y are required for click."
      }
      [AssistantInputNative]::LeftClick($X, $Y)
      $reason = "left mouse click at ($X,$Y)"
    }
    "move" {
      if (-not $PSBoundParameters.ContainsKey("X") -or -not $PSBoundParameters.ContainsKey("Y")) {
        throw "-X and -Y are required for move."
      }
      [AssistantInputNative]::MoveCursor($X, $Y)
      $reason = "move mouse to ($X,$Y)"
    }
    "type" {
      if (-not $PSBoundParameters.ContainsKey("Text")) {
        throw "-Text is required for type."
      }
      [AssistantInputNative]::SendUnicodeText($Text)
      $reason = "inject keyboard text"
    }
    "key" {
      if (-not $PSBoundParameters.ContainsKey("Key")) {
        throw "-Key is required for key."
      }
      $virtualKey = switch ($Key.ToLowerInvariant()) {
        "enter" { 0x0D }
        "tab" { 0x09 }
        "escape" { 0x1B }
        "esc" { 0x1B }
        default { throw "Unsupported key '$Key'. Supported keys: Enter, Tab, Escape." }
      }
      [AssistantInputNative]::SendVirtualKey($virtualKey)
      $reason = "inject $Key key"
    }
  }

  Write-InputAudit -Reason $reason -Result "executed"
} catch {
  $message = $_.Exception.Message
  try {
    Write-InputAudit -Reason "$Action input injection" -Result "failed: $message"
  } catch {
    $message = "$message; audit append failed: $($_.Exception.Message)"
  }
  [Console]::Error.WriteLine("Input injection failed: $message")
  exit 1
}
