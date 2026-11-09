param(
    [Parameter(Mandatory = $true)][string]$InputDirectory,
    [Parameter(Mandatory = $true)][string]$OutputFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveRoot = (Resolve-Path -LiteralPath $InputDirectory).Path
$archivePrefix = $archiveRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$archivePath = [System.IO.Path]::GetFullPath($OutputFile)
if ($archivePath.StartsWith($archivePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'ZIP output must be outside the input directory.'
}
$archiveStream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
try {
    $archive = [System.IO.Compression.ZipArchive]::new($archiveStream, [System.IO.Compression.ZipArchiveMode]::Create, $false, [System.Text.Encoding]::UTF8)
    try {
        foreach ($archiveFile in (Get-ChildItem -LiteralPath $archiveRoot -Recurse -File -Force | Sort-Object FullName)) {
            $entryName = $archiveFile.FullName.Substring($archivePrefix.Length).Replace('\', '/')
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $archiveFile.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $archive.Dispose() }
} finally { $archiveStream.Dispose() }
