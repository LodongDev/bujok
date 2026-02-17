const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ============================================
// cookie-renew.js — 실행 중인 Chrome에 직접 연결
// ============================================
// 방법 1: CDP로 실행 중인 Chrome에 연결 (CAPTCHA 없음!)
// 방법 2: Chrome 닫혀있으면 디버그 포트로 새로 시작
// 방법 3: 최후 수단 — stealth + 자동 로그인

const { CONFIG } = require('./config');

const COOKIE_FILE = path.join(__dirname, 'cookie.txt');
const GAME_URL = 'https://en153.tribalwars.net/game.php';
const LOBBY_URL = 'https://www.tribalwars.net';
const WORLD = 'en153';
const CDP_PORT = 9222;

const CHROME_USER_DATA = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const TEMP_PROFILE = path.join(os.tmpdir(), 'bujok-chrome-temp');

// 시스템 Chrome 실행 파일 경로 찾기
function findChromePath() {
    const candidates = [
        path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function log(msg) {
    const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    console.log(`[${ts}] [쿠키 갱신] ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// 방법 1: 실행 중인 Chrome에 CDP로 연결
// ============================================
async function tryConnectCDP() {
    try {
        // CDP 포트 열려있는지 확인
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
            signal: AbortSignal.timeout(3000),
        });
        const data = await res.json();
        const wsUrl = data.webSocketDebuggerUrl;

        if (!wsUrl) {
            log('CDP 연결 가능하지만 WebSocket URL 없음');
            return null;
        }

        log(`CDP 연결 성공! (${wsUrl.substring(0, 50)}...)`);

        // 실행 중인 Chrome에 연결 (새 브라우저 안 띄움!)
        const browser = await puppeteer.connect({
            browserWSEndpoint: wsUrl,
            defaultViewport: null,
        });

        return { browser, mode: 'cdp' };
    } catch {
        return null; // CDP 포트 안 열려있음
    }
}

// ============================================
// 방법 2: Chrome 닫혀있으면 디버그 포트로 시작
// ============================================
async function tryLaunchWithDebug() {
    const chromePath = findChromePath();
    if (!chromePath) {
        log('Chrome 실행 파일을 찾을 수 없음');
        return null;
    }

    try {
        // Chrome을 디버그 포트와 함께 시작 (기존 프로필 사용)
        log(`Chrome 시작 (디버그 포트 ${CDP_PORT})...`);
        const proc = spawn(chromePath, [
            `--remote-debugging-port=${CDP_PORT}`,
            `--user-data-dir=${CHROME_USER_DATA}`,
            '--profile-directory=Profile 2',
            '--restore-last-session',
        ], {
            detached: true,
            stdio: 'ignore',
        });
        proc.unref();

        // Chrome 준비될 때까지 대기
        for (let i = 0; i < 15; i++) {
            await sleep(1000);
            const cdp = await tryConnectCDP();
            if (cdp) return cdp;
        }

        log('Chrome 시작했지만 CDP 연결 실패');
        return null;
    } catch (err) {
        log(`Chrome 시작 실패: ${err.message}`);
        return null;
    }
}

// ============================================
// 방법 3: 최후 수단 — Stealth + 자동 로그인
// ============================================
function copyProfileToTemp() {
    log('프로필 임시 복사 중...');
    try { fs.rmSync(TEMP_PROFILE, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(path.join(TEMP_PROFILE, 'Profile 2', 'Network'), { recursive: true });

    function robocopy(src, dst, files) {
        try {
            execSync(
                `robocopy "${src}" "${dst}" ${files} /R:0 /W:0 /NFL /NDL /NJH /NJS /NC /NS /NP`,
                { stdio: 'ignore' }
            );
        } catch (e) {
            if (e.status >= 8) log(`robocopy 경고 (code ${e.status}): ${src}`);
        }
    }

    const profileSrc = path.join(CHROME_USER_DATA, 'Profile 2');
    robocopy(profileSrc, path.join(TEMP_PROFILE, 'Profile 2'),
        'Cookies "Cookies-journal" Preferences "Secure Preferences" "Login Data" "Login Data-journal"');
    robocopy(path.join(profileSrc, 'Network'), path.join(TEMP_PROFILE, 'Profile 2', 'Network'),
        'Cookies "Cookies-journal"');
    try {
        fs.copyFileSync(
            path.join(CHROME_USER_DATA, 'Local State'),
            path.join(TEMP_PROFILE, 'Local State')
        );
    } catch {}

    log('프로필 복사 완료');
    return TEMP_PROFILE;
}

function cleanupTemp() {
    // 먼저 임시 프로필을 사용하는 chrome 프로세스 종료
    try {
        execSync('taskkill /F /FI "COMMANDLINE eq *bujok-chrome-temp*" /T', { stdio: 'ignore' });
    } catch {}
    try { fs.rmSync(TEMP_PROFILE, { recursive: true, force: true }); } catch {}
}

async function tryStealthLaunch() {
    const chromePath = findChromePath();
    if (!chromePath) {
        log('Chrome 실행 파일을 찾을 수 없음');
        return null;
    }

    // 이전 임시 프로필 정리
    cleanupTemp();

    let browser;
    let usedTempProfile = false;

    try {
        browser = await puppeteer.launch({
            headless: false,
            executablePath: chromePath,
            userDataDir: CHROME_USER_DATA,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--profile-directory=Profile 2',
            ],
            defaultViewport: null,
        });
    } catch (err) {
        if (err.message.includes('lock') || err.message.includes('already') || err.message.includes('SingletonLock')) {
            log('Chrome 실행 중 → 프로필 복사 모드 (fallback)');
            try {
                const tempDir = copyProfileToTemp();
                browser = await puppeteer.launch({
                    headless: false,
                    executablePath: chromePath,
                    userDataDir: tempDir,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-blink-features=AutomationControlled',
                        '--profile-directory=Profile 2',
                    ],
                    defaultViewport: null,
                });
                usedTempProfile = true;
            } catch (copyErr) {
                log(`프로필 복사 모드 실패: ${copyErr.message}`);
                cleanupTemp();
                return null;
            }
        } else {
            throw err;
        }
    }

    return { browser, mode: 'stealth', usedTempProfile };
}

// ============================================
// 사람처럼 타이핑
// ============================================
async function humanType(page, selector, text) {
    const el = await page.$(selector);
    if (!el) return false;
    await el.click({ clickCount: 3 });
    await sleep(100 + Math.random() * 200);
    for (const char of text) {
        await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    return true;
}

// ============================================
// 로그인 자동화
// ============================================
async function attemptLogin(page) {
    const username = CONFIG.username;
    const password = CONFIG.password;
    if (!username || !password) {
        log('config.js에 username/password가 설정되지 않음');
        return false;
    }

    const currentUrl = page.url();
    log(`로그인 시도 (${currentUrl})`);

    // 로비/로그인 페이지에서 폼 찾기
    const loginSelectors = [
        { user: '#user', pass: '#password', submit: '.btn-login' },
        { user: 'input[name="username"]', pass: 'input[name="password"]', submit: 'input[type="submit"]' },
        { user: 'input[name="user"]', pass: 'input[name="password"]', submit: 'button[type="submit"]' },
        { user: '#username', pass: '#password', submit: '.btn-login' },
    ];

    for (const sel of loginSelectors) {
        const userInput = await page.$(sel.user);
        const passInput = await page.$(sel.pass);
        if (userInput && passInput) {
            log(`로그인 폼 발견: ${sel.user}`);

            await page.evaluate((s) => {
                const el = document.querySelector(s);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, sel.user);
            await sleep(500 + Math.random() * 500);

            await humanType(page, sel.user, username);
            await sleep(300 + Math.random() * 500);
            await humanType(page, sel.pass, password);
            await sleep(300 + Math.random() * 500);

            // 로그인 버튼 클릭
            const submitBtn = await page.$(sel.submit);
            if (submitBtn) {
                await submitBtn.click();
            } else {
                await page.keyboard.press('Enter');
            }

            log('로그인 폼 제출, 결과 대기...');
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            await sleep(2000);

            const afterUrl = page.url();
            log(`로그인 후 URL: ${afterUrl}`);

            if (afterUrl.includes('game.php') && !afterUrl.includes('screen=login')) {
                log('로그인 성공!');
                return true;
            }

            // 로비 → 서버 진입 필요
            if (afterUrl.includes('tribalwars.net')) {
                return await enterWorld(page);
            }

            break;
        }
    }

    // 로그인 폼 없으면 서버 진입만 시도
    return await enterWorld(page);
}

// ============================================
// 서버(월드) 진입
// ============================================
async function enterWorld(page) {
    log('서버 진입 시도...');

    await page.goto(`https://${WORLD}.tribalwars.net/`, {
        waitUntil: 'networkidle2', timeout: 30000,
    }).catch(() => {});
    await sleep(2000);

    let url = page.url();
    if (url.includes('game.php') && !url.includes('screen=login')) {
        log('서버 접속 성공!');
        return true;
    }

    // 로비에서 서버 링크 클릭
    await page.goto(LOBBY_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(2000);

    const clicked = await page.evaluate((world) => {
        for (const a of document.querySelectorAll('a')) {
            if (a.href && a.href.includes(world)) { a.click(); return a.href; }
        }
        return null;
    }, WORLD);

    if (clicked) {
        log(`서버 링크 클릭: ${clicked}`);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await sleep(2000);
    }

    url = page.url();
    if (url.includes('game.php') && !url.includes('screen=login')) {
        log('서버 진입 성공!');
        return true;
    }

    log(`서버 진입 실패 (현재: ${url})`);
    return false;
}

// ============================================
// 쿠키 추출 (공통)
// ============================================
async function extractCookiesFromPage(browser, mode) {
    // CDP 모드: 새 탭 열기, 게임 접속, 쿠키 추출, 탭 닫기
    const page = await browser.newPage();

    log('게임 페이지 접속...');
    await page.goto(GAME_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(1000 + Math.random() * 1000);

    let currentUrl = page.url();
    log(`현재 URL: ${currentUrl}`);

    // 게임에 접속 안 된 경우
    if (!currentUrl.includes('game.php') || currentUrl.includes('screen=login')) {
        if (mode === 'cdp') {
            // CDP 모드에서는 이미 로그인된 브라우저이므로 서버 진입만 시도
            const ok = await enterWorld(page);
            if (!ok) {
                // 혹시 로그인도 필요하면
                const loginOk = await attemptLogin(page);
                if (!loginOk) {
                    log('CDP 모드: 게임 접속 실패 — 브라우저에서 직접 로그인하세요');
                    await page.close();
                    return null;
                }
            }
        } else {
            // Stealth 모드: 로그인 자동화
            const loginOk = await attemptLogin(page);
            currentUrl = page.url();

            if (!loginOk && !currentUrl.includes('game.php')) {
                log('*** 자동 로그인 실패 → 브라우저에서 직접 로그인하세요! (최대 2분 대기) ***');
                const deadline = Date.now() + 120000;
                while (Date.now() < deadline) {
                    await sleep(3000);
                    currentUrl = page.url();
                    if (currentUrl.includes('game.php') && !currentUrl.includes('screen=login')) {
                        log('수동 로그인 확인!');
                        break;
                    }
                }
            }
        }
    }

    currentUrl = page.url();
    if (!currentUrl.includes('game.php') || currentUrl.includes('screen=login')) {
        log('게임 접속 실패');
        await page.close();
        return null;
    }

    log('게임 접속 확인! 쿠키 추출 중...');

    const cookies = await page.cookies();
    const cookieStr = cookies
        .filter(c => c.domain.includes('tribalwars'))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

    if (!cookieStr || !cookieStr.includes('sid')) {
        log('sid 쿠키를 찾지 못했습니다');
        await page.close();
        return null;
    }

    log(`쿠키 확인: ${cookies.filter(c => c.domain.includes('tribalwars')).map(c => c.name).join(', ')}`);
    await page.close();
    return cookieStr;
}

// ============================================
// 메인 쿠키 갱신
// ============================================
async function renewCookie(options = {}) {
    log('=== 쿠키 갱신 시작 ===');

    // --- 방법 1: 실행 중인 Chrome에 CDP로 연결 (가장 좋음, CAPTCHA 없음) ---
    log('[방법 1] 실행 중인 Chrome에 CDP 연결 시도...');
    let conn = await tryConnectCDP();

    if (conn) {
        try {
            const cookieStr = await extractCookiesFromPage(conn.browser, 'cdp');
            if (cookieStr) {
                fs.writeFileSync(COOKIE_FILE, cookieStr, 'utf-8');
                log('성공! cookie.txt 저장 완료 (CDP 모드)');
                conn.browser.disconnect(); // CDP는 disconnect (브라우저 안 닫음)
                return cookieStr;
            }
            conn.browser.disconnect();
        } catch (err) {
            log(`CDP 모드 에러: ${err.message}`);
            try { conn.browser.disconnect(); } catch {}
        }
    } else {
        log('[방법 1] CDP 포트 미열림 → 방법 2 시도');
    }

    // --- 방법 2: Chrome을 디버그 포트로 새로 시작 ---
    log('[방법 2] Chrome을 디버그 포트로 시작 시도...');
    conn = await tryLaunchWithDebug();

    if (conn) {
        try {
            const cookieStr = await extractCookiesFromPage(conn.browser, 'cdp');
            if (cookieStr) {
                fs.writeFileSync(COOKIE_FILE, cookieStr, 'utf-8');
                log('성공! cookie.txt 저장 완료 (디버그 모드)');
                conn.browser.disconnect();
                return cookieStr;
            }
            conn.browser.disconnect();
        } catch (err) {
            log(`디버그 모드 에러: ${err.message}`);
            try { conn.browser.disconnect(); } catch {}
        }
    } else {
        log('[방법 2] 실패 → 방법 3 시도');
    }

    // --- 방법 3: Stealth Puppeteer + 자동 로그인 (최후 수단) ---
    log('[방법 3] Stealth 모드로 시작...');
    const stealthConn = await tryStealthLaunch();

    if (!stealthConn) {
        log('모든 방법 실패');
        return null;
    }

    try {
        const cookieStr = await extractCookiesFromPage(stealthConn.browser, 'stealth');
        if (cookieStr) {
            fs.writeFileSync(COOKIE_FILE, cookieStr, 'utf-8');
            log('성공! cookie.txt 저장 완료 (stealth 모드)');
        }
        await stealthConn.browser.close();
        if (stealthConn.usedTempProfile) cleanupTemp();
        return cookieStr;
    } catch (err) {
        log(`stealth 모드 에러: ${err.message}`);
        await stealthConn.browser.close().catch(() => {});
        if (stealthConn.usedTempProfile) cleanupTemp();
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
