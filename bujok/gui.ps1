# gui.ps1 — Bujok Autopilot GUI
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$workDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Thread-safe log queue (.NET event handler -> UI timer)
$Global:BujokLogQueue = [System.Collections.ArrayList]::Synchronized([System.Collections.ArrayList]::new())

# ============================================
# Form
# ============================================
$form = New-Object System.Windows.Forms.Form
$form.Text = "Bujok Autopilot"
$form.ClientSize = New-Object System.Drawing.Size(720, 480)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 35)

# ============================================
# Header
# ============================================
$header = New-Object System.Windows.Forms.Panel
$header.Dock = "Top"
$header.Height = 48
$header.BackColor = [System.Drawing.Color]::FromArgb(40, 40, 48)
$form.Controls.Add($header)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Location = New-Object System.Drawing.Point(14, 13)
$statusLabel.AutoSize = $true
$statusLabel.Text = "  대기 중"
$statusLabel.ForeColor = [System.Drawing.Color]::Gray
$statusLabel.Font = New-Object System.Drawing.Font("맑은 고딕", 12)
$header.Controls.Add($statusLabel)

$startBtn = New-Object System.Windows.Forms.Button
$startBtn.Size = New-Object System.Drawing.Size(80, 32)
$startBtn.Location = New-Object System.Drawing.Point(520, 8)
$startBtn.Text = "시작"
$startBtn.FlatStyle = "Flat"
$startBtn.BackColor = [System.Drawing.Color]::FromArgb(39, 174, 96)
$startBtn.ForeColor = [System.Drawing.Color]::White
$startBtn.Font = New-Object System.Drawing.Font("맑은 고딕", 10, [System.Drawing.FontStyle]::Bold)
$startBtn.Cursor = "Hand"
$startBtn.FlatAppearance.BorderSize = 0
$header.Controls.Add($startBtn)

$stopBtn = New-Object System.Windows.Forms.Button
$stopBtn.Size = New-Object System.Drawing.Size(80, 32)
$stopBtn.Location = New-Object System.Drawing.Point(608, 8)
$stopBtn.Text = "중지"
$stopBtn.FlatStyle = "Flat"
$stopBtn.BackColor = [System.Drawing.Color]::FromArgb(192, 57, 43)
$stopBtn.ForeColor = [System.Drawing.Color]::White
$stopBtn.Font = New-Object System.Drawing.Font("맑은 고딕", 10, [System.Drawing.FontStyle]::Bold)
$stopBtn.Enabled = $false
$stopBtn.Cursor = "Hand"
$stopBtn.FlatAppearance.BorderSize = 0
$header.Controls.Add($stopBtn)

# ============================================
# Log Box
# ============================================
$logBox = New-Object System.Windows.Forms.RichTextBox
$logBox.Location = New-Object System.Drawing.Point(0, 48)
$logBox.Size = New-Object System.Drawing.Size(720, 432)
$logBox.Anchor = "Top,Bottom,Left,Right"
$logBox.ReadOnly = $true
$logBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$logBox.BackColor = [System.Drawing.Color]::FromArgb(12, 12, 16)
$logBox.ForeColor = [System.Drawing.Color]::FromArgb(180, 255, 180)
$logBox.BorderStyle = "None"
$logBox.WordWrap = $false
$logBox.ScrollBars = "ForcedVertical"
$form.Controls.Add($logBox)

# ============================================
# Process & Timer
# ============================================
$script:proc = $null

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({
    # Queue -> UI
    if ($Global:BujokLogQueue.Count -gt 0) {
        $items = $Global:BujokLogQueue.ToArray()
        $Global:BujokLogQueue.Clear()
        foreach ($line in $items) {
            $logBox.AppendText("$line`r`n")
        }
        $logBox.ScrollToCaret()
    }

    # Process death check
    if ($script:proc -ne $null -and $script:proc.HasExited) {
        $code = $script:proc.ExitCode
        $timer.Stop()
        Start-Sleep -Milliseconds 300
        # Flush remaining
        if ($Global:BujokLogQueue.Count -gt 0) {
            $rest = $Global:BujokLogQueue.ToArray()
            $Global:BujokLogQueue.Clear()
            foreach ($line in $rest) { $logBox.AppendText("$line`r`n") }
        }
        $logBox.AppendText("`r`n[시스템] 프로세스 종료 (코드: $code)`r`n")
        $logBox.ScrollToCaret()
        $statusLabel.Text = "  종료됨 (코드: $code)"
        $statusLabel.ForeColor = [System.Drawing.Color]::OrangeRed
        $startBtn.Enabled = $true
        $stopBtn.Enabled = $false
        $script:proc = $null
    }
})

# ============================================
# Start
# ============================================
$startBtn.Add_Click({
    $startBtn.Enabled = $false
    $stopBtn.Enabled = $true
    $statusLabel.Text = "  실행 중"
    $statusLabel.ForeColor = [System.Drawing.Color]::LimeGreen
    $logBox.Clear()
    $Global:BujokLogQueue.Clear()
    $logBox.AppendText("[시스템] Autopilot 시작 중...`r`n`r`n")

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "node"
    $psi.Arguments = "autopilot.js"
    $psi.WorkingDirectory = $workDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    $script:proc = New-Object System.Diagnostics.Process
    $script:proc.StartInfo = $psi
    $script:proc.EnableRaisingEvents = $true

    # .NET event handlers (thread pool thread -> global queue)
    $script:proc.add_OutputDataReceived({
        param($sender, $e)
        if ($e.Data -ne $null) {
            $Global:BujokLogQueue.Add($e.Data) | Out-Null
        }
    })
    $script:proc.add_ErrorDataReceived({
        param($sender, $e)
        if ($e.Data -ne $null) {
            $Global:BujokLogQueue.Add($e.Data) | Out-Null
        }
    })

    try {
        $script:proc.Start() | Out-Null
        $script:proc.BeginOutputReadLine()
        $script:proc.BeginErrorReadLine()
        $timer.Start()
    } catch {
        $logBox.AppendText("[에러] 시작 실패: $($_.Exception.Message)`r`n")
        $statusLabel.Text = "  에러"
        $statusLabel.ForeColor = [System.Drawing.Color]::Red
        $startBtn.Enabled = $true
        $stopBtn.Enabled = $false
    }
})

# ============================================
# Stop
# ============================================
$stopBtn.Add_Click({
    if ($script:proc -ne $null -and !$script:proc.HasExited) {
        $logBox.AppendText("`r`n[시스템] 중지 중...`r`n")
        try {
            & taskkill /PID $script:proc.Id /T /F 2>&1 | Out-Null
        } catch {}
    }
    $timer.Stop()
    $statusLabel.Text = "  중지됨"
    $statusLabel.ForeColor = [System.Drawing.Color]::Orange
    $startBtn.Enabled = $true
    $stopBtn.Enabled = $false
    $script:proc = $null
    $logBox.AppendText("[시스템] Autopilot 중지됨`r`n")
})

# ============================================
# Form close -> cleanup
# ============================================
$form.Add_FormClosing({
    if ($script:proc -ne $null -and !$script:proc.HasExited) {
        try { & taskkill /PID $script:proc.Id /T /F 2>&1 | Out-Null } catch {}
    }
    $timer.Stop()
})

# ============================================
# Launch
# ============================================
$logBox.AppendText("Bujok Autopilot v1.0`r`n")
$logBox.AppendText("==============================`r`n`r`n")
$logBox.AppendText("시작 버튼을 눌러 실행하세요.`r`n")

[System.Windows.Forms.Application]::Run($form)
