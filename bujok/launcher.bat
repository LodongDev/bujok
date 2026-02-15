@echo off
chcp 65001 >nul 2>&1
title Bujok Autopilot - Setup
cd /d "%~dp0"

echo.
echo  ============================================
echo    Bujok Autopilot - 초기 설정
echo  ============================================
echo.

:: 1. Node.js 체크
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Node.js가 설치되어 있지 않습니다.
    echo  [*] Node.js 자동 설치 중...
    echo.

    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        winget install OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    ) else (
        echo  [!] winget을 찾을 수 없습니다.
        echo  [*] https://nodejs.org 에서 Node.js LTS를 설치하세요.
        echo  [*] 설치 후 launcher.bat을 다시 실행하세요.
        pause
        exit /b 1
    )

    :: PATH 갱신 시도
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%ProgramFiles%\nodejs;%PATH%"
    )

    where node >nul 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo  [!] PATH 갱신이 필요합니다.
        echo  [*] 이 창을 닫고 launcher.bat을 다시 실행하세요.
        pause
        exit /b 1
    )
)

for /f "tokens=*" %%v in ('node --version') do echo  [OK] Node.js %%v

:: 2. npm 의존성 체크
if not exist "node_modules" (
    echo  [*] npm 패키지 설치 중...
    call npm install
    if %errorlevel% neq 0 (
        echo  [!] npm install 실패
        pause
        exit /b 1
    )
)
echo  [OK] 의존성 준비 완료
echo.

:: 3. PowerShell GUI 실행
powershell -ExecutionPolicy Bypass -File "%~dp0gui.ps1"
