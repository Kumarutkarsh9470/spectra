@echo off
REM SPECTRA launcher: serves the folder on http://localhost:8137 so the webcam and microphone are allowed.
cd /d "%~dp0"
start "" http://localhost:8137/
where python >nul 2>nul && (python -m http.server 8137 & goto :eof)
where py >nul 2>nul && (py -m http.server 8137 & goto :eof)
where npx >nul 2>nul && (npx --yes http-server -p 8137 -c-1 & goto :eof)
echo No Python or Node found. Opening index.html directly (camera/mic may be blocked).
start "" "%~dp0index.html"
