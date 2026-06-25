<#
.SYNOPSIS
  Generate a large numbered log file to exercise vael's big-file tiers.

.DESCRIPTION
  Writes a plain-text log of roughly -GB gigabytes. Each line is uniquely
  numbered so you can verify the streaming viewer's line indexing, jump-to-line,
  and find bar against known content.

  Tiers (by size): <=50MB Full, <=1GB Degraded, >1GB StreamViewer.
  Use -GB 0.03 (~30MB) for Full, -GB 0.5 for Degraded, -GB 1.2 for StreamViewer.

.EXAMPLE
  pwsh scripts/make-test-log.ps1 -GB 1.2 -Out test-large.log
#>
param(
  [double]$GB = 1.2,
  [string]$Out = 'test-large.log'
)

$target = [int64]($GB * 1GB)
$sw = [System.IO.StreamWriter]::new($Out, $false, [System.Text.UTF8Encoding]::new($false))
try {
  $i = 0
  while ($sw.BaseStream.Length -lt $target) {
    for ($j = 0; $j -lt 20000; $j++) {
      $sw.WriteLine("2026-06-25T00:00:00.000Z [INFO] req=$i user=alice path=/api/items status=200 dur=${j}ms lorem ipsum dolor sit amet consectetur adipiscing elit needle-$i")
      $i++
    }
    $sw.Flush()
  }
}
finally {
  $sw.Close()
}

$len = (Get-Item $Out).Length
Write-Output ("Wrote {0}: {1:N0} bytes (~{2:N2} GB), {3:N0} lines" -f $Out, $len, ($len / 1GB), $i)
Write-Output "Tip: search the find bar for 'needle-123456' to test jump-to-line."
