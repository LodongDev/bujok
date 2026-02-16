// ============================================
// 공통 설정 — 모든 스크립트에서 import
// ============================================
const fs = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(__dirname, 'cookie.txt');

// cookie.txt에서 실시간으로 쿠키를 읽음 (재시작 없이 갱신 가능)
function getCookie() {
    try {
        return fs.readFileSync(COOKIE_FILE, 'utf-8').trim();
    } catch {
        return CONFIG.cookie; // 파일 없으면 하드코딩 값 사용
    }
}

const CONFIG = {
    // 서버
    serverUrl: 'https://en153.tribalwars.net',
    baseUrl: 'https://en153.tribalwars.net/game.php',

    // 내 마을
    myVillageId: 24333,
    myX: 650,
    myY: 447,

    // 탐색 반경 (칸 수)
    searchRadius: 50,

    // 로그인 계정
    username: 'chosun',
    password: 'nowckh01',

    // 쿠키
    cookie: 'locale=en_DK; cid=1921490166; en_auth=98d4793b3a4d:199cc9180145a17a278243328b144681ef82d1860b97a821af25d9449683036f; sid=0%3A9f8e8cbda05928cc742f76d7a90999534fcb1c0df3c4e1eaffa1c4a7f23ad2d50809db6b401eb809101dd50cb9c2432d2cbb9d270ecff9fd75b3453aee87569f; global_village_id=26266; websocket_available=true',

    // 요청 간 딜레이 (ms)
    delayMs: 500,
    // command API 체크 시 딜레이 (좀 더 보수적)
    commandDelayMs: 1500,
    // 보호체크 병렬 설정
    protectionConcurrency: 3,    // 동시 워커 수 (낮출수록 사람처럼 보임)

    // 파밍 분류 기준
    tiers: {
        core: { maxDistance: 10, maxPoints: 100 },    // 가까운 야만인
        growth: { maxDistance: 20, maxPoints: 200 },   // 중거리
        // 나머지는 risk
    },

    // 입력/출력 파일
    inputFile: './targets.json',
    farmDbFile: './farm-db.json',

    // 멀티 마을 설정 (farmYmin~farmYmax로 y축 영역 배분)
    // id: null이면 자동 감지
    villages: [
        { name: '4번마을', id: 27370, x: 650, y: 435, farmYmax: 441 },            // 북쪽 (y ≤ 441)
        { name: '1번마을', id: 24333, x: 650, y: 447, farmYmin: 442, farmYmax: 448 }, // 중앙 (442 ≤ y ≤ 448)
        { name: '3번마을', id: 26266, x: 647, y: 450, farmYmin: 449 },            // 남쪽 (y ≥ 449)
    ],
};

// 공통 헤더 빌더
function buildHeaders() {
    return {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': getCookie(),
        'Referer': `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=map`,
        'Sec-Ch-Ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Tribalwars-Ajax': '1',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function distance(x1, y1, x2, y2) {
    return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

module.exports = { CONFIG, buildHeaders, sleep, distance };
