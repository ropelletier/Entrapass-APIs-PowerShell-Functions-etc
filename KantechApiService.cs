using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.ServiceProcess;
using System.Threading;

/// <summary>
/// Windows Service that hosts the Kantech API (Node.js) as a long-running process.
/// Compile and install with: Install-KantechApiService.ps1
/// </summary>
public class KantechApiService : ServiceBase
{
    private Process  _process;
    private readonly string _apiDir;
    private readonly string _nodePath;
    private readonly string _logFile;
    private readonly string _apiPort;
    private volatile bool   _isStopping = false;

    // Populated at compile time by Install-KantechApiService.ps1
    private const string NODE_EXE  = "%%NODE_EXE%%";
    private const string API_PORT  = "%%API_PORT%%";
    private const string LOG_DIR   = "%%LOG_DIR%%";

    public KantechApiService()
    {
        ServiceName         = "KantechApiServer";
        CanStop             = true;
        CanPauseAndContinue = false;
        AutoLog             = true;

        string assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        _apiDir   = Path.Combine(assemblyDir, "api");
        _nodePath = NODE_EXE;
        _apiPort  = API_PORT;
        _logFile  = Path.Combine(LOG_DIR, "KantechApiService.log");
    }

    protected override void OnStart(string[] args)
    {
        Log("Service starting (port " + _apiPort + ")");

        string serverScript = Path.Combine(_apiDir, "server.js");
        if (!File.Exists(serverScript))
        {
            Log("ERROR: server.js not found at: " + serverScript);
            Stop();
            return;
        }

        if (!File.Exists(_nodePath))
        {
            Log("ERROR: node.exe not found at: " + _nodePath);
            Stop();
            return;
        }

        _process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName               = _nodePath,
                Arguments              = "\"" + serverScript + "\"",
                UseShellExecute        = false,
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                CreateNoWindow         = true,
                WorkingDirectory       = _apiDir,
            },
            EnableRaisingEvents = true
        };

        // Pass API_PORT to the node process (server.js reads process.env.API_PORT)
        _process.StartInfo.EnvironmentVariables["API_PORT"] = _apiPort;

        _process.OutputDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
        _process.ErrorDataReceived  += (s, e) => { if (e.Data != null) Log("ERR: " + e.Data); };
        _process.Exited             += OnProcessExited;

        _process.Start();
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();

        Log("node.exe started (PID " + _process.Id + ")");
    }

    private void OnProcessExited(object sender, EventArgs e)
    {
        int code = (_process != null && _process.HasExited) ? _process.ExitCode : -1;
        Log("node.exe exited (code " + code + "). Restarting in 10s...");
        Thread.Sleep(10000);

        if (!_isStopping)
        {
            try { OnStart(null); }
            catch (Exception ex) { Log("Restart failed: " + ex.Message); }
        }
    }

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
            string entry = "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] [API] " + message + Environment.NewLine;
            File.AppendAllText(_logFile, entry);
        }
        catch { /* swallow logging errors */ }
    }

    public static void Main()
    {
        ServiceBase.Run(new KantechApiService());
    }
}
