# serve.ps1 — 開発用の簡易静的サーバー(依存なし・PowerShell だけで動く)
#
#   pwsh -File serve.ps1              # http://localhost:8765/ で配信
#   pwsh -File serve.ps1 -Port 9000 -Any   # 同じ Wi-Fi のスマホからも開けるようにする
#
# アプリ本体は index.html を直接開く(file://)だけでも動きます。
# このサーバーは、スマホの実機で確認したいときのためのものです。

param(
  [int]$Port = 8765,
  [switch]$Any
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$address = if ($Any) { [System.Net.IPAddress]::Any } else { [System.Net.IPAddress]::Loopback }

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.md'   = 'text/plain; charset=utf-8'
}

$listener = [System.Net.Sockets.TcpListener]::new($address, $Port)
$listener.Start()
Write-Host "serving $root"
if ($Any) {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1).IPAddress
  Write-Host "  http://localhost:$Port/   (この PC)"
  if ($ip) { Write-Host "  http://${ip}:$Port/   (同じ Wi-Fi のスマホ)" }
} else {
  Write-Host "  http://localhost:$Port/"
}
Write-Host 'Ctrl+C で停止します。'

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 8192, $true)
      $requestLine = $reader.ReadLine()
      if (-not $requestLine) { continue }
      # ヘッダは読み捨てる
      while ($true) { $line = $reader.ReadLine(); if ([string]::IsNullOrEmpty($line)) { break } }

      $parts = $requestLine -split ' '
      $target = if ($parts.Length -ge 2) { $parts[1] } else { '/' }
      $target = ($target -split '\?')[0]
      if ($target -eq '/') { $target = '/index.html' }

      $relative = [System.Uri]::UnescapeDataString($target).TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      $full = Join-Path $root $relative
      $resolvedRoot = [System.IO.Path]::GetFullPath($root)
      $resolved = [System.IO.Path]::GetFullPath($full)

      if ($resolved.StartsWith($resolvedRoot) -and (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        $bytes = [System.IO.File]::ReadAllBytes($resolved)
        $ext = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
        $type = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
        $header = "HTTP/1.1 200 OK`r`nContent-Type: $type`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
        Write-Host "200 $target"
      } else {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
        $header = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
        Write-Host "404 $target"
      }

      $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
      $reader.Dispose()
    } catch {
      Write-Host "error: $_"
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
