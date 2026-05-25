# SOTI AI Analyser - Standalone Static HTTP Server Fallback
# Zero-dependency PowerShell server that runs on any Windows machine.

$port = 8765
$root = $PSScriptRoot
if (-not $root) { $root = Get-Location }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")

try {
    $listener.Start()
    Write-Host "[+] PowerShell Server listening on http://127.0.0.1:$port/" -ForegroundColor Green
    Write-Host "[*] Serving files from: $root" -ForegroundColor Cyan
    Write-Host "[*] Keep this window open while using the app." -ForegroundColor White
} catch {
    Write-Host "[!] Failed to start server: $_" -ForegroundColor Red
    if ($_.Exception.Message -like "*Access is denied*") {
        Write-Host "[!] Try running the batch file as Administrator." -ForegroundColor Yellow
    }
    exit 1
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        # Decode path and remove leading slash
        $urlPath = [System.Uri]::UnescapeDataString($request.RawUrl.TrimStart('/'))
        if ([string]::IsNullOrEmpty($urlPath)) { $urlPath = "SOTI_AI_Analyser.html" }
        
        # Strip query parameters if present
        if ($urlPath.Contains('?')) {
            $urlPath = $urlPath.Split('?')[0]
        }

        $filePath = Join-Path $root $urlPath

        if (Test-Path $filePath -PathType Leaf) {
            $buffer = [System.IO.File]::ReadAllBytes($filePath)
            
            # Map MIME type
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $mime = switch ($ext) {
                ".html" { "text/html; charset=utf-8" }
                ".css"  { "text/css; charset=utf-8" }
                ".js"   { "application/javascript; charset=utf-8" }
                ".png"  { "image/png" }
                ".jpg"  { "image/jpeg" }
                ".jpeg" { "image/jpeg" }
                ".svg"  { "image/svg+xml" }
                ".json" { "application/json; charset=utf-8" }
                default { "application/octet-stream" }
            }
            
            $response.ContentType = $mime
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
        } else {
            $response.StatusCode = 404
            $errBytes = [System.Text.Encoding]::UTF8.GetBytes("File Not Found: $urlPath")
            $response.ContentType = "text/plain"
            $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
        }
        $response.Close()
    }
} catch {
    Write-Host "[!] Server encountered an error: $_" -ForegroundColor Red
} finally {
    $listener.Stop()
}
