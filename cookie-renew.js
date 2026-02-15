const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer');

// ============================================
// cookie-renew.js — 기존 Chrome 프로필로 쿠키 갱신
// ============================================
// Chrome이 실행 중이어도 프로필을 임시 복사해서 쿠키 추출 가능
// 이미 로그인된 세션 활용 → CAPTCHA 없음

const COOKIE_FILE = path.join(__dirname, 'cookie.txt');
const GAME_URL = 'https://en153.tribalwars.net/game.php';

// Windows Chrome 기본 프로필 경로
const CHROME_USER_DATA = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const TEMP_PROFILE = path.join(os.tmpdir(), 'bujok-chrome-temp');

// Chrome 프로필을 임시 디렉토리에 복사 (robocopy 사용 — 잠긴 파일도 복사 가능)
function copyProfileToTemp() {
    console.log('[쿠키 갱신] 프로필 임시 복사 중...');

    // 이전 임시 폴더 삭제
    try { fs.rmSync(TEMP_PROFILE, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(path.join(TEMP_PROFILE, 'Default', 'Network'), { recursive: true });

    // robocopy 종료코드: 0-7=성공, 8+=에러
    function robocopy(src, dst, files) {
        try {
            execSync(
                `robocopy "${src}" "${dst}" ${files} /R:0 /W:0 /NFL /NDL /NJH /NJS /NC /NS /NP`,
                { stdio: 'ignore' }
            );
        } catch (e) {
            if (e.status >= 8) console.log(`  robocopy 경고 (code ${e.status}): ${src}`);
        }
    }

    const defaultSrc = path.join(CHROME_USER_DATA, 'Default');

    // 쿠키 관련 파일만 복사 (빠름)
    robocopy(defaultSrc, path.join(TEMP_PROFILE, 'Default'),
        'Cookies "Cookies-journal" Preferences "Secure Preferences" "Login Data" "Login Data-journal"');

    // Network/Cookies (Chrome 96+ 위치)
    robocopy(path.join(defaultSrc, 'Network'), path.join(TEMP_PROFILE, 'Default', 'Network'),
        'Cookies "Cookies-journal"');

    // Local State (쿠키 암호화 키)
    try {
        fs.copyFileSync(
            path.join(CHROME_USER_DATA, 'Local State'),
            path.join(TEMP_PROFILE, 'Local State')
        );
    } catch {}

    console.log('[쿠키 갱신] 프로필 복사 완료');
    return TEMP_PROFILE;
}

// 임시 프로필 정리
function cleanupTemp() {
    try { fs.rmSync(TEMP_PROFILE, { recursive: true, force: true }); } catch {}
}

async function extractCookies(browser) {
    const page = await browser.newPage();

    console.log('[쿠키 갱신] 게임 페이지 접속...');
    await page.goto(GAME_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    const currentUrl = page.url();
    console.log(`[쿠키 갱신] 현재 URL: ${currentUrl}`);

    const isLoggedIn = currentUrl.includes('game.php') && !currentUrl.includes('screen=login');
    if (!isLoggedIn) {
        console.log('[쿠키 갱신] 로그인이 필요합니다');
        return null;
    }

    console.log('[쿠키 갱신] 게임 접속 확인! 쿠키 추출 중...');

    const cookies = await page.cookies();
    const cookieStr = cookies
        .filter(c => c.domain.includes('tribalwars'))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

    if (!cookieStr || !cookieStr.includes('sid')) {
        console.log('[쿠키 갱신] sid 쿠키를 찾지 못했습니다');
        return null;
    }

    console.log(`[쿠키 갱신] 쿠키: ${cookies.filter(c => c.domain.includes('tribalwars')).map(c => c.name).join(', ')}`);
    return cookieStr;
}

async function renewCookie(options = {}) {
    const { headless = false, timeout = 120000 } = options;

    console.log('[쿠키 갱신] Chrome 실행 중 (기존 프로필 사용)...');

    let browser;
    let usedTempProfile = false;

    // 1차: 원본 프로필로 직접 실행 (Chrome 닫혀있을 때)
    try {
        browser = await puppeteer.launch({
            headless,
            userDataDir: CHROME_USER_DATA,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1280,800',
                '--profile-directory=Default',
            ],
            defaultViewport: { width: 1280, height: 800 },
        });
    } catch (err) {
        if (err.message.includes('lock') || err.message.includes('already') || err.message.includes('SingletonLock')) {
            // 2차: Chrome 실행 중 → 프로필 복사 후 실행
            console.log('[쿠키 갱신] Chrome 실행 중 → 프로필 복사 모드');
            try {
                const tempDir = copyProfileToTemp();
                browser = await puppeteer.launch({
                    headless: true, // 복사 모드는 headless로 (로그인 세션 이미 있음)
                    userDataDir: tempDir,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-gpu',
                        '--profile-directory=Default',
                    ],
                    defaultViewport: { width: 1280, height: 800 },
                });
                usedTempProfile = true;
            } catch (copyErr) {
                console.log(`[쿠키 갱신] 프로필 복사 모드 실패: ${copyErr.message}`);
                cleanupTemp();
                return null;
            }
        } else {
            throw err;
        }
    }

    try {
        const cookieStr = await extractCookies(browser);

        if (cookieStr) {
            fs.writeFileSync(COOKIE_FILE, cookieStr, 'utf-8');
            console.log('[쿠키 갱신] 성공! cookie.txt 저장 완료');
        }

        await browser.close();
        if (usedTempProfile) cleanupTemp();
        return cookieStr;

    } catch (err) {
        console.error(`[쿠키 갱신] 에러: ${err.message}`);
        await browser.close().catch(() => {});
        if (usedTempProfile) cleanupTemp();
        return null;
    }
}

module.exports = { renewCookie };

// 직접 실행: node cookie-renew.js
if (require.main === module) {
    renewCookie().then(result => {
        if (result) {
            console.log('\n쿠키 갱신 완료!');
        } else {
            console.log('\n쿠키 갱신 실패');
            process.exit(1);
        }
    });
}
