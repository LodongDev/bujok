const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

// ============================================
// cookie-renew.js — 사람처럼 Chrome 열고 쿠키 읽기
// ============================================
// Junction 포인트로 Chrome의 실제 프로필 데이터를 사용하면서
// remote-debugging-port를 활성화 → 자동화 탐지 없음
//
// 흐름:
// 1) CDP 포트 이미 열려있으면 바로 연결
// 2) 아니면 Chrome 종료 → junction 경로로 디버그 포트와 함께 재시작
// 3) 게임 접속 → 쿠키 추출 → cookie.txt 저장

const { CONFIG } = require('./config');

const COOKIE_FILE = path.join(__dirname, 'cookie.txt');
const CHROME_USER_DATA = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const JUNCTION_PATH = path.join(__dirname, '.chrome-link');
const CDP_PORT = 9222;
const GAME_URL = 'https://en153.tribalwars.net/game.php';
const WORLD = 'en153';

function log(msg) {
    const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    console.log(`[${ts}] [쿠키 갱신] ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 시스템 Chrome 경로 찾기
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

// Junction 포인트 생성 (없으면)
function ensureJunction() {
    try {
        const stat = fs.lstatSync(JUNCTION_PATH);
        if (stat.isSymbolicLink() || stat.isDirectory()) return true;
    } catch {}

    try {
        // mklink /J는 관리자 권한 불필요
        execSync(`mklink /J "${JUNCTION_PATH}" "${CHROME_USER_DATA}"`, {
            stdio: 'ignore', windowsHide: true, shell: 'cmd.exe',
        });
        log('Junction 포인트 생성 완료');
        return true;
    } catch (err) {
        log(`Junction 생성 실패: ${err.message}`);
        return false;
    }
}

// CDP WebSocket URL 가져오기
async function getCDPWebSocket() {
    try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
            signal: AbortSignal.timeout(2000),
        });
        const data = await res.json();
        return data.webSocketDebuggerUrl || null;
    } catch {
        return null;
    }
}

// Chrome 프로세스 확인
function isChromeRunning() {
    try {
        const result = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
            encoding: 'utf-8', windowsHide: true,
        });
        return result.includes('chrome.exe');
    } catch {
        return false;
    }
}

// Chrome 실행 (junction 경로 + 디버그 포트)
function launchChrome(chromePath) {
    const proc = spawn(chromePath, [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${JUNCTION_PATH}`,
        '--profile-directory=Profile 2',
        '--restore-last-session',
    ], {
        detached: true,
        stdio: 'ignore',
    });
    proc.unref();
}

// CDP로 쿠키 추출
async function extractCookies(wsUrl) {
    const browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
    });

    try {
        const page = await browser.newPage();

        // 게임 페이지 접속 시도
        await page.goto(GAME_URL, {
            waitUntil: 'networkidle2',
            timeout: 15000,
        }).catch(() => {});

        await sleep(1000);
        let currentUrl = page.url();
        log(`현재 URL: ${currentUrl}`);

        // 게임에 접속 안 됐으면 → 서버 진입 / 로그인 시도
        if (!currentUrl.includes('game.php') || currentUrl.includes('screen=login')) {
            log('게임 세션 없음 → 서버 접속 시도...');

            // 먼저 서버 직접 접속 시도
            const worldOk = await enterWorld(page);
            if (!worldOk) {
                // 서버 접속 실패 → 로그인 필요
                log('로그인 시도...');
                const loginOk = await tryLogin(page);
                if (!loginOk) {
                    log('자동 로그인 실패');
                    log('  -> Chrome에서 tribalwars에 직접 로그인 후 다시 실행하세요');
                    await page.close();
                    return null;
                }
            }
            currentUrl = page.url();
        }

        if (!currentUrl.includes('game.php') || currentUrl.includes('screen=login')) {
            log('게임 접속 실패');
            await page.close();
            return null;
        }

        // 쿠키 추출
        const cookies = await page.cookies();
        const twCookies = cookies.filter(c => c.domain.includes('tribalwars'));
        await page.close();

        if (!twCookies.length) {
            log('tribalwars 쿠키 없음');
            return null;
        }

        const cookieStr = twCookies.map(c => `${c.name}=${c.value}`).join('; ');
        log(`쿠키 ${twCookies.length}개 추출: ${twCookies.map(c => c.name).join(', ')}`);

        if (!cookieStr.includes('sid')) {
            log('sid 쿠키 없음 — 세션 만료');
            return null;
        }

        return cookieStr;
    } finally {
        browser.disconnect();
    }
}

// 서버(월드) 진입
async function enterWorld(page) {
    // 이미 게임 페이지면 성공
    let url = page.url();
    if (url.includes('game.php') && !url.includes('screen=login')) return true;

    // 직접 서버 URL 접속
    log('서버 접속 시도: ' + WORLD);
    await page.goto(`https://${WORLD}.tribalwars.net/`, {
        waitUntil: 'networkidle2', timeout: 15000,
    }).catch(() => {});
    await sleep(2000);

    url = page.url();
    if (url.includes('game.php') && !url.includes('screen=login')) {
        log('서버 접속 성공 (직접 URL)');
        return true;
    }

    // 로비에서 서버 링크 찾아 클릭
    log('로비에서 서버 링크 검색...');
    const clicked = await page.evaluate((world) => {
        // 링크 중 en153 포함된 것 찾기
        for (const a of document.querySelectorAll('a[href]')) {
            if (a.href.includes(world)) {
                a.click();
                return a.href;
            }
        }
        // 버튼/요소 중 en153 또는 153 텍스트 찾기
        for (const el of document.querySelectorAll('a, button, [onclick]')) {
            const text = el.textContent || '';
            if (text.includes('153') || text.includes(world)) {
                el.click();
                return text.trim();
            }
        }
        return null;
    }, WORLD);

    if (clicked) {
        log(`서버 링크 클릭: ${clicked}`);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        await sleep(2000);
    }

    url = page.url();
    if (url.includes('game.php') && !url.includes('screen=login')) {
        log('서버 접속 성공');
        return true;
    }

    log(`서버 접속 실패 (현재 URL: ${url})`);
    return false;
}

// 자동 로그인
async function tryLogin(page) {
    const { username, password } = CONFIG;
    if (!username || !password) return false;

    // 로비 페이지로
    await page.goto('https://www.tribalwars.net', {
        waitUntil: 'networkidle2', timeout: 15000,
    }).catch(() => {});
    await sleep(1000);

    // 로그인 폼 찾기
    const selectors = [
        { user: '#user', pass: '#password', btn: '.btn-login' },
        { user: 'input[name="username"]', pass: 'input[name="password"]', btn: 'input[type="submit"]' },
    ];

    for (const sel of selectors) {
        const userEl = await page.$(sel.user);
        const passEl = await page.$(sel.pass);
        if (!userEl || !passEl) continue;

        log('로그인 폼 발견');

        // 사람처럼 입력
        await userEl.click({ clickCount: 3 });
        await sleep(200 + Math.random() * 300);
        await page.keyboard.type(username, { delay: 50 + Math.random() * 80 });
        await sleep(300 + Math.random() * 300);
        await passEl.click({ clickCount: 3 });
        await sleep(200 + Math.random() * 300);
        await page.keyboard.type(password, { delay: 50 + Math.random() * 80 });
        await sleep(300 + Math.random() * 300);

        const btn = await page.$(sel.btn);
        if (btn) await btn.click();
        else await page.keyboard.press('Enter');

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        await sleep(2000);

        // 로그인 후 서버 진입
        return await enterWorld(page);
    }

    return false;
}

// ============================================
// 메인 쿠키 갱신
// ============================================
async function renewCookie() {
    log('=== 쿠키 갱신 시작 ===');

    // 1단계: CDP 포트가 이미 열려있으면 바로 사용
    let wsUrl = await getCDPWebSocket();
    if (wsUrl) {
        log('CDP 포트 열려있음 → 바로 연결');
        try {
            const cookieStr = await extractCookies(wsUrl);
            if (cookieStr) {
                fs.writeFileSync(COOKIE_FILE, cookieStr, 'utf-8');
                log('cookie.txt 저장 완료');
                return cookieStr;
            }
        } catch (err) {
            log(`CDP 에러: ${err.message}`);
        }
    }

    // 2단계: Junction 포인트 확인/생성
    if (!ensureJunction()) {
        log('Junction 생성 실패 — 수동으로 start-chrome.bat 실행 후 다시 시도하세요');
        return null;
    }

    // 3단계: Chrome 경로 확인
    const chromePath = findChromePath();
    if (!chromePath) {
        log('Chrome 실행 파일을 찾을 수 없음');
        return null;
    }

    // 4단계: Chrome 종료 → 디버그 포트로 재시작
    if (isChromeRunning()) {
        log('Chrome 재시작 (디버그 포트 활성화)...');
        log('  기존 탭은 자동 복원됩니다');
        try {
            execSync('taskkill /F /IM chrome.exe', { stdio: 'ignore', windowsHide: true });
        } catch {}
        await sleep(3000);
    }

    // 5단계: Chrome 실행
    log('Chrome 시작 (Profile 2, 디버그 포트)...');
    launchChrome(chromePath);

    // CDP 연결 대기
    for (let i = 0; i < 20; i++) {
        await sleep(1000);
        wsUrl = await getCDPWebSocket();
        if (wsUrl) break;
    }

    if (!wsUrl) {
        log('Chrome CDP 연결 실패');
        return null;
    }

    log('CDP 연결 성공');
    await sleep(3000); // 페이지 로딩 대기

    try {
        const cookieStr = await extractCookies(wsUrl);
        if (cookieStr) {
            fs.writeFileSync(COOKIE_FILE, cookieStr, 'utf-8');
            log('cookie.txt 저장 완료');
            return cookieStr;
        }
    } catch (err) {
        log(`쿠키 추출 에러: ${err.message}`);
    }

    log('');
    log('=== 쿠키 갱신 실패 ===');
    log('  Chrome에서 tribalwars에 로그인 후 다시 실행하세요');
    return null;
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
