/** Test-only WinEvent observer. A missing control or unobservable console is inconclusive. */
export function visibilityObserverScript(directory: string): string {
	return (
		`$root = '${directory.replaceAll("'", "''")}'\n` +
		String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Windows.Forms.dll') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
public static class LaunchVisibility {
    delegate void WinEvent(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEvent cb, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [StructLayout(LayoutKind.Sequential)] struct UserFlags { public int inherit; public int reserved; public uint flags; }
    [DllImport("user32.dll")] static extern bool GetUserObjectInformation(IntPtr handle, int index, out UserFlags flags, uint size, out uint needed);
    static StreamWriter output;
    static string root, phase = "control|armed";
    static IntPtr control;
    static bool controlSeen;
    static HashSet<IntPtr> baseline = new HashSet<IntPtr>();
    static WinEvent callback = OnEvent;
    static void Record(string kind, IntPtr hwnd, bool enumerated) {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        var cls = new StringBuilder(256); GetClassName(hwnd, cls, 256);
        output.WriteLine(String.Join("\t", phase, DateTime.UtcNow.ToString("o"), kind, pid, hwnd.ToInt64(), IsWindowVisible(hwnd), enumerated, cls.ToString().Replace("\t", " ").Replace("\r", " ").Replace("\n", " ")));
    }
    static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time) {
        if (hwnd == IntPtr.Zero || (ev == 0x8002 && (obj != 0 || child != 0))) return;
        if (hwnd == control && ev == 0x8002) controlSeen = true;
        Record(ev == 3 ? "foreground" : "show", hwnd, false);
    }
    static HashSet<IntPtr> Windows() {
        var result = new HashSet<IntPtr>();
        EnumWindows((hwnd, param) => { result.Add(hwnd); return true; }, IntPtr.Zero);
        return result;
    }
    public static int Run(string directory) {
        root = directory;
        using (output = new StreamWriter(Path.Combine(root, "windows.tsv"), false, new UTF8Encoding(false))) {
            output.AutoFlush = true;
            IntPtr show = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, callback, 0, 0, 0);
            IntPtr foreground = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0);
            try {
                // Off-screen and no-activate: real WS_VISIBLE/SHOW control without taking focus.
                control = CreateWindowEx(0x08000080, "STATIC", "Prime Agent visibility control", 0x90000000, -32000, -32000, 8, 8, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                var clock = Stopwatch.StartNew();
                while (!controlSeen && clock.ElapsedMilliseconds < 2000) { Application.DoEvents(); Thread.Sleep(10); }
                if (control != IntPtr.Zero) DestroyWindow(control);
                Application.DoEvents();
                foreach (var hwnd in Windows()) if (IsWindowVisible(hwnd)) baseline.Add(hwnd);
                UserFlags flags; uint needed;
                bool visibleStation = GetUserObjectInformation(GetProcessWindowStation(), 1, out flags, 12, out needed) && (flags.flags & 1) != 0;
                string ready = Path.Combine(root, "observer-ready");
                File.WriteAllText(ready + ".tmp", (show != IntPtr.Zero && foreground != IntPtr.Zero && controlSeen) + "|" + visibleStation);
                File.Move(ready + ".tmp", ready);
                clock.Restart();
                while (!File.Exists(Path.Combine(root, "observer-stop")) && clock.ElapsedMilliseconds < 150000) {
                    Application.DoEvents();
                    string request = "";
                    try { request = File.ReadAllText(Path.Combine(root, "phase")); } catch (IOException) { }
                    string[] parts = request.Split('|');
                    if (parts.Length == 3 && (parts[1] == "armed" || parts[1] == "audit")) {
                        phase = parts[0] + "|" + parts[1];
                        if (File.Exists(Path.Combine(root, "phase-ack")) && File.ReadAllText(Path.Combine(root, "phase-ack")) == request) { Thread.Sleep(10); continue; }
                        Application.DoEvents();
                        var windows = Windows();
                        foreach (var hwnd in windows) if (IsWindowVisible(hwnd) && !baseline.Contains(hwnd)) Record("visible-snapshot", hwnd, true);
                        long console;
                        if (parts[1] == "audit" && Int64.TryParse(parts[2], out console)) Record("console", new IntPtr(console), windows.Contains(new IntPtr(console)));
                        File.WriteAllText(Path.Combine(root, "phase-ack"), request);
                    }
                    Thread.Sleep(10);
                }
                if (!File.Exists(Path.Combine(root, "observer-stop"))) return 4;
                // The controller requests stop only after sentinel cleanup. Drain late SHOW/handoff events.
                clock.Restart();
                while (clock.ElapsedMilliseconds < 200) { Application.DoEvents(); Thread.Sleep(10); }
                foreach (var hwnd in Windows()) if (IsWindowVisible(hwnd) && !baseline.Contains(hwnd)) Record("visible-snapshot", hwnd, true);
                Application.DoEvents();
                File.WriteAllText(Path.Combine(root, "observer-drained"), "drained");
                return 0;
            } finally {
                if (show != IntPtr.Zero) UnhookWinEvent(show);
                if (foreground != IntPtr.Zero) UnhookWinEvent(foreground);
            }
        }
    }
}
'@
exit ([LaunchVisibility]::Run($root))
`
	);
}
