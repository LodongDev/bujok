@echo off
echo Chrome을 디버그 모드로 시작합니다 (포트 9222, Profile 2)...

:: Junction 포인트 생성 (없으면) — Chrome이 기본 경로에서 디버그 포트 거부하므로
if not exist "%~dp0.chrome-link" (
    mklink /J "%~dp0.chrome-link" "%LOCALAPPDATA%\Google\Chrome\User Data"
    echo Junction 포인트 생성 완료
)

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%~dp0.chrome-link" --profile-directory="Profile 2" --restore-last-session
echo Chrome 시작 완료! 이제 쿠키 자동 갱신이 가능합니다.
