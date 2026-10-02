# Zero-dependency static file server for local development (Windows PowerShell 5.1+).
#
#   powershell -ExecutionPolicy Bypass -File tools/serve.ps1
#
# Any static server works just as well (`npx serve`, `python -m http.server`);
# this one exists so the project runs on a stock Windows machine with nothing installed.

param(
  [int]$Port = 5173,
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  # Dev only: lets the page POST canvas screenshots to docs/<name>.png or .jpg.
  [switch]$AllowSave
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path.TrimEnd('\')

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.md'   = 'text/markdown; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.ico'  = 'image/x-icon'
  '.wasm' = 'application/wasm'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "ex nihilo dev server -> http://localhost:$Port/   (root: $Root)"

# A HEAD response carries the headers of the matching GET but no body.
function Send-Bytes($req, $res, [byte[]]$bytes) {
  $res.ContentLength64 = $bytes.Length
  if ($req.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
}

function Send-Text($req, $res, [int]$status, [string]$text) {
  $res.StatusCode = $status
  $res.ContentType = 'text/plain; charset=utf-8'
  Send-Bytes $req $res ([Text.Encoding]::UTF8.GetBytes($text))
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $res.Headers['Cache-Control'] = 'no-store'
      $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)

      if ($req.HttpMethod -eq 'POST') {
        # Screenshot capture. Requires -AllowSave, a same-origin request and a custom
        # header (which forces a CORS preflight that this server never answers).
        $sameOrigin = $req.Headers['Origin'] -eq "http://localhost:$Port"
        if ($AllowSave -and $sameOrigin -and $req.Headers['X-Ex-Nihilo'] -eq 'save' -and
            $path -match '^/__save/([a-z0-9-]+\.(png|jpg))$') {
          $dir = Join-Path $Root 'docs'
          if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
          $ms = New-Object IO.MemoryStream
          $req.InputStream.CopyTo($ms)
          [IO.File]::WriteAllBytes((Join-Path $dir $Matches[1]), $ms.ToArray())
          Send-Text $req $res 200 "saved $($Matches[1]) ($($ms.Length) bytes)"
        } else {
          Send-Text $req $res 403 'forbidden'
        }
        continue
      }

      if ($path.EndsWith('/')) { $path += 'index.html' }
      $full = [IO.Path]::GetFullPath((Join-Path $Root $path.TrimStart('/')))
      $inside = $full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
      if (-not $inside -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        Send-Text $req $res 404 "404 not found: $path"
        continue
      }

      $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }
      Send-Bytes $req $res ([IO.File]::ReadAllBytes($full))
    } catch {
      Write-Host "error: $($req.Url.AbsolutePath): $($_.Exception.Message)"
      try { $res.StatusCode = 500 } catch {}
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
