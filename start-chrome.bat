@echo off
echo Chrome을 디버그 모드로 시작합니다 (포트 9222, Profile 2)...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --profile-directory="Profile 2" --restore-last-session
echo Chrome 시작 완료! 이제 쿠키 자동 갱신이 가능합니다.
