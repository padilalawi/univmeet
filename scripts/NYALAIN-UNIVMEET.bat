@echo off
title UnivMeet - nyalain server lokal + link publik
cd /d "%~dp0.."

set NGROK=%USERPROFILE%\tools\ngrok.exe
set CF=%USERPROFILE%\tools\cloudflared.exe

echo ================================================
echo   UNIVMEET - server lokal + tunnel (opsional)
echo ================================================
echo.
echo   CATATAN: versi ONLINE sudah jalan permanen di
echo            https://univmeet.pages.dev
echo            Script ini cuma buat ngoprek di lokal.
echo.
echo ================================================
echo.

echo [1/2] Nyalain server rapat...
start "UnivMeet Server" /min cmd /c "npm start"
timeout /t 4 /nobreak >nul

echo.
echo [2/2] Mau bikin link publik juga?
echo.
echo   [1] ngrok      - link TETAP (kunjungan pertama klik "Visit Site")
echo   [2] cloudflare - tanpa halaman peringatan, tapi link berubah
echo   [3] tidak usah - cukup http://localhost:3000
echo.
set /p PILIH="Ketik 1, 2, atau 3 lalu Enter: "

if "%PILIH%"=="3" goto end
if "%PILIH%"=="2" goto cf

echo.
echo ================================================
echo   LINK TETAP:
echo   https://avert-germinate-trade.ngrok-free.dev
echo.
echo   JANGAN TUTUP JENDELA INI selama dipakai.
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
echo.
echo ================================================
echo   LINK SEMENTARA - lihat baris trycloudflare.com di bawah
echo   JANGAN TUTUP JENDELA INI selama dipakai.
echo ================================================
echo.
"%CF%" tunnel --url http://localhost:3000 --no-autoupdate

:end
echo.
echo Tekan tombol apa saja untuk keluar.
pause >nul
