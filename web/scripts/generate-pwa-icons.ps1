<#
  Phase 1-11A — génère les variantes PWA depuis stock-master-icon.png
  (source unique, jamais redessinée) avec System.Drawing (.NET, déjà
  disponible sur Windows — aucun package ajouté). À relancer avec
  `powershell -NoProfile -File web/scripts/generate-pwa-icons.ps1`
  si la source change.
#>
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$brandDir = Join-Path $root "public\brand"
$iconsDir = Join-Path $root "public\icons"
New-Item -ItemType Directory -Force -Path $brandDir, $iconsDir | Out-Null

$sourceIcon = Join-Path (Split-Path -Parent $root) "stock-master-icon.png"
$sourceLogo = Join-Path (Split-Path -Parent $root) "stock-master-logo-horizontal.png"

Copy-Item -LiteralPath $sourceIcon -Destination (Join-Path $brandDir "stock-master-icon.png") -Force
Copy-Item -LiteralPath $sourceLogo -Destination (Join-Path $brandDir "stock-master-logo-horizontal.png") -Force

function New-ResizedPng {
  param(
    [string]$SourcePath,
    [string]$DestPath,
    [int]$Size,
    [System.Drawing.Color]$Background = [System.Drawing.Color]::Transparent,
    [double]$Scale = 1.0
  )
  $src = [System.Drawing.Image]::FromFile($SourcePath)
  try {
    $canvas = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $g = [System.Drawing.Graphics]::FromImage($canvas)
      try {
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear($Background)
        # Source is square (1254x1254): scale uniformly, never stretch.
        $drawSize = [Math]::Round($Size * $Scale)
        $offset = [Math]::Round(($Size - $drawSize) / 2)
        $g.DrawImage($src, $offset, $offset, $drawSize, $drawSize)
      } finally { $g.Dispose() }
      $canvas.Save($DestPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $canvas.Dispose() }
  } finally { $src.Dispose() }
}

$transparent = [System.Drawing.Color]::Transparent
$navy = [System.Drawing.Color]::FromArgb(255, 0x06, 0x2B, 0x5C)
$white = [System.Drawing.Color]::FromArgb(255, 0xFF, 0xFF, 0xFF)

# Direct variants: full-bleed, transparency preserved.
New-ResizedPng -SourcePath $sourceIcon -DestPath (Join-Path $iconsDir "icon-192.png") -Size 192 -Background $transparent -Scale 1.0
New-ResizedPng -SourcePath $sourceIcon -DestPath (Join-Path $iconsDir "icon-512.png") -Size 512 -Background $transparent -Scale 1.0

# Maskable: opaque brand-navy background, artwork kept within the 80% safe zone.
New-ResizedPng -SourcePath $sourceIcon -DestPath (Join-Path $iconsDir "icon-maskable-512.png") -Size 512 -Background $navy -Scale 0.8

# Apple touch icon: opaque white background (iOS renders transparency as black).
New-ResizedPng -SourcePath $sourceIcon -DestPath (Join-Path $iconsDir "apple-touch-icon.png") -Size 180 -Background $white -Scale 1.0

# Favicon: 32x32 bitmap converted to a real single-frame .ico via GetHicon/Icon.Save.
$faviconPng = Join-Path $iconsDir "_favicon-32.png.tmp"
New-ResizedPng -SourcePath $sourceIcon -DestPath $faviconPng -Size 32 -Background $transparent -Scale 1.0
$bmp = New-Object System.Drawing.Bitmap $faviconPng
try {
  $hIcon = $bmp.GetHicon()
  try {
    $icon = [System.Drawing.Icon]::FromHandle($hIcon)
    $faviconPath = Join-Path $root "src\app\favicon.ico"
    $stream = [System.IO.File]::Create($faviconPath)
    try { $icon.Save($stream) } finally { $stream.Dispose() }
  } finally {
    [void][System.Runtime.InteropServices.Marshal]::FreeHGlobal
  }
} finally { $bmp.Dispose() }
Remove-Item -LiteralPath $faviconPng -Force

Write-Output "Icons generated in $iconsDir and favicon.ico written."
