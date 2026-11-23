# Installs local Hebrew speech-to-text for voice messages (ivrit.ai Whisper via faster-whisper).
# Everything runs on this computer - voice messages never leave it.
# Needs Python 3.10-3.12 (python.org). Takes a few minutes; downloads ~1.6 GB (the model) once.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root
$VoiceDir = Join-Path $Root 'voice'
$Model = 'ivrit-ai/whisper-large-v3-turbo-ct2'

# 1. Python
$py = $null
foreach ($v in '3.12', '3.11', '3.10', '3') {
  try { & py "-$v" -c "import sys; print(sys.version)" *> $null; if ($LASTEXITCODE -eq 0) { $py = @('py', "-$v"); break } } catch {}
}
if (-not $py) { try { & python -c "import sys; assert sys.version_info >= (3,10)" *> $null; if ($LASTEXITCODE -eq 0) { $py = @('python') } } catch {} }
if (-not $py) {
  Write-Host 'Python 3.10-3.12 was not found. Install it from https://www.python.org/downloads/ (tick "Add to PATH") and run this again.' -ForegroundColor Red
  exit 1
}
Write-Host "1/5 Python: $($py -join ' ')" -ForegroundColor Cyan

# 2. Private environment for the voice server
$venvPy = Join-Path $VoiceDir 'venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  Write-Host '2/5 Creating voice\venv ...' -ForegroundColor Cyan
  & $py[0] $py[1..9] -m venv (Join-Path $VoiceDir 'venv')
} else { Write-Host '2/5 voice\venv exists' -ForegroundColor Cyan }

# 3. Packages (+ NVIDIA GPU libraries when an NVIDIA card is present)
Write-Host '3/5 Installing faster-whisper ...' -ForegroundColor Cyan
& $venvPy -m pip install --upgrade pip --quiet
& $venvPy -m pip install --upgrade faster-whisper --quiet
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  Write-Host '    NVIDIA GPU found - adding GPU libraries (faster transcription)' -ForegroundColor Cyan
  & $venvPy -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*" --quiet
}
if ($LASTEXITCODE -ne 0) { Write-Host 'pip install failed - see the errors above.' -ForegroundColor Red; exit 1 }

# 4. Download the Hebrew model once (so the first voice message is quick)
Write-Host "4/5 Downloading the Hebrew model $Model (~1.6 GB, once) ..." -ForegroundColor Cyan
& $venvPy -c "from faster_whisper import WhisperModel; WhisperModel('$Model', device='cpu', compute_type='int8'); print('model ready')"
if ($LASTEXITCODE -ne 0) { Write-Host 'Model download failed - check the internet connection and run again.' -ForegroundColor Red; exit 1 }

# 5. Tell the bot to use it (.env) and restart the bot
Write-Host '5/5 Connecting the bot ...' -ForegroundColor Cyan
$envPath = Join-Path $Root '.env'
$text = [IO.File]::ReadAllText($envPath)
$text = [regex]::Replace($text, '(?m)^\s*#?\s*TRANSCRIBE_URL=.*\r?\n?', '')
$text = [regex]::Replace($text, '(?m)^\s*#?\s*TRANSCRIBE_MODEL=.*\r?\n?', '')
$text = $text.TrimEnd() + "`r`n`r`n# --- Voice messages: local Hebrew speech-to-text (scriptsinstall-voice.ps1) ---`r`nTRANSCRIBE_URL=http://127.0.0.1:8090/v1`r`nTRANSCRIBE_MODEL=$Model`r`n"
[IO.File]::WriteAllText($envPath, $text, (New-Object Text.UTF8Encoding $false))
New-Item -ItemType File -Force -Path (Join-Path $Root 'restart.flag') | Out-Null
Write-Host ''
Write-Host 'Done. The bot restarts by itself in a few seconds and starts the voice server.' -ForegroundColor Green
Write-Host 'Voice messages from the last 7 days will be transcribed in the background too.'
