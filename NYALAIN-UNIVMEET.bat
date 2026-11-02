@echo off
title UnivMeet - server + link publik
cd /d "%~dp0"

set NGROK=%USERPROFILE%\tools\ngrok.exe
set CF=%USERPROFILE%\tools\cloudflared.exe

echo ================================================
echo   UNIVMEET - nyalain server rapat
echo ================================================
echo.

echo [1/2] Nyalain server rapat...
start "UnivMeet Server" /min cmd /c "npm start"
timeout /t 4 /nobreak >nul

echo.
echo [2/2] Bikin link publik...
echo.
echo   [1] ngrok      - link TETAP (kunjungan pertama klik "Visit Site")
echo   [2] cloudflare - tanpa halaman peringatan, tapi link berubah
echo.
set /p PILIH="Ketik 1 atau 2 lalu Enter: "

echo.
echo ================================================
if "%PILIH%"=="2" goto cf
echo   LINK TETAP LU:
echo   https://avert-germinate-trade.ngrok-free.dev
echo.
echo   JANGAN TUTUP JENDELA INI selama rapat jalan.
echo ================================================
echo.
REM ngrok harus lepas dari proxy (Tor), kalau tidak ditolak
set ALL_PROXY=
set HTTPS_PROXY=
set HTTP_PROXY=
set all_proxy=
set https_proxy=
set http_proxy=
"%NGROK%" http 3000
goto end

:cf
echo   LINK SEMENTARA - lihat baris trycloudflare.com di bawah
echo.
echo   JANGAN TUTUP JENDELA INI selama rapat jalan.
echo ================================================
echo.
"%CF%" tunnel --url http://localhost:3000 --no-autoupdate

:end
echo.
echo Tunnel berhenti. Tekan tombol apa saja untuk keluar.
pause >nul
