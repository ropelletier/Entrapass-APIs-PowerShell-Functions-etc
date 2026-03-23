using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.ServiceProcess;
using System.Threading;

/// <summary>
/// Windows Service that hosts Watch-DoorEvents.ps1 as a long-running process.
/// Compile with: Build-KantechEventService.ps1
/// Install with: Install-KantechEventService.ps1
/// </summary>
public class KantechEventService : ServiceBase
{
    private Process _process;
    private readonly string _scriptDir;
    private readonly string _logFile;

    // MySQL connection settings — populated by Build-KantechEventService.ps1
    // at compile time via #define substitution, or passed as environment variables.
    private const string MYSQL_HOST     = "%%MYSQL_HOST%%";
    private const string MYSQL_PORT     = "%%MYSQL_PORT%%";
    private const string MYSQL_DATABASE = "%%MYSQL_DATABASE%%";
    private const string MYSQL_USER     = "%%MYSQL_USER%%";
    private const string MYSQL_PASSWORD = "%%MYSQL_PASSWORD%%";
    private const string POLL_SECONDS   = "%%POLL_SECONDS%%";

    public KantechEventService()
    {
        ServiceName             = "KantechEventMonitor";
        CanStop                 = true;
        CanPauseAndContinue     = false;
        AutoLog                 = true;

        _scriptDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        _logFile   = Path.Combine("C:\\Exports\\Kantech", "KantechEventService.log");
    }

    protected override void OnStart(string[] args)
    {
        Log("Service starting");

        string scriptPath = Path.Combine(_scriptDir, "Watch-Kantech.ps1");
        if (!File.Exists(scriptPath))
        {
            Log("ERROR: Script not found: " + scriptPath);
            Stop();
            return;
        }

        string psArgs = string.Join(" ", new[]
        {
            "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", "\"" + scriptPath + "\"",
            "-MySqlHost",     "\"" + MYSQL_HOST + "\"",
            "-MySqlPort",     "\"" + MYSQL_PORT + "\"",
            "-MySqlDatabase", "\"" + MYSQL_DATABASE + "\"",
            "-MySqlUser",     "\"" + MYSQL_USER + "\"",
            "-MySqlPassword", "\"" + MYSQL_PASSWORD + "\"",
            "-PollSeconds",   POLL_SECONDS
        });

        _process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName               = "powershell.exe",
                Arguments              = psArgs,
                UseShellExecute        = false,
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                CreateNoWindow         = true,
                WorkingDirectory       = _scriptDir
            },
            EnableRaisingEvents = true
        };

        _process.OutputDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
        _process.ErrorDataReceived  += (s, e) => { if (e.Data != null) Log("STDERR: " + e.Data); };
        _process.Exited             += OnProcessExited;

        _process.Start();
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();

        Log("PowerShell process started (PID " + _process.Id + ")");
    }

    private void OnProcessExited(object sender, EventArgs e)
    {
        int code = (_process != null && _process.HasExited) ? _process.ExitCode : -1;
        Log("PowerShell process exited (code " + code + "). Restarting in 10s...");
        Thread.Sleep(10000);

        // Restart unless the service itself is stopping
        if (!_isStopping)
        {
            try { OnStart(null); }
            catch (Exception ex) { Log("Restart failed: " + ex.Message); }
        }
    }

    private volatile bool _isStopping = false;

    protected override void OnStop()
    {
        _isStopping = true;
        Log("Service stopping");

        if (_process != null && !_process.HasExited)
        {
            try
            {
                _process.Kill();
                _process.WaitForExit(5000);
            }
            catch { /* ignore */ }
        }

        Log("Service stopped");
    }

    private void Log(string message)
    {
        try
        {
            string dir = Path.GetDirectoryName(_logFile);
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            string entry = "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] [SERVICE] " + message + Environment.NewLine;
            File.AppendAllText(_logFile, entry);
        }
        catch { /* swallow logging errors */ }
    }

    public static void Main()
    {
        ServiceBase.Run(new KantechEventService());
    }
}
