// ============================================
// 수신 공격 감시 모듈 (Attack Watcher)
// 60초마다 수신 공격 체크 → 속도 기반 유형 분류 + 귀족열차 감지
// ============================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const { CONFIG, buildHeaders, sleep, distance } = require('./config');
const { renewCookie } = require('./cookie-renew');

const COOKIE_FILE = path.join(__dirname, 'cookie.txt');

const ATTACKS_FILE = path.join(__dirname, 'attacks.json');

const UNIT_SPEED = { spear: 18, sword: 22, axe: 18, spy: 9, light: 10, heavy: 11, ram: 30, catapult: 30, snob: 35 };

// commandId → attack info
const seenAttacks = new Map();
let lastCheckTime = null;

function ts() { return new Date().toLocaleTimeString('ko-KR', { hour12: false }); }
function log(msg) { console.log(`[${ts()}] [WATCHER] ${msg}`); }

// ============================================
// 응답 Set-Cookie → cookie.txt 갱신
// ============================================
function updateCookieFromResponse(res) {
    try {
        const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        if (setCookies.length === 0) return;

        const currentCookie = fs.readFileSync(COOKIE_FILE, 'utf-8').trim();
        const cookieMap = {};
        for (const pair of currentCookie.split(';')) {
            const [k, ...v] = pair.trim().split('=');
            if (k) cookieMap[k.trim()] = v.join('=');
        }

        let updated = false;
        for (const sc of setCookies) {
            const cookiePart = sc.split(';')[0];
            const [k, ...v] = cookiePart.split('=');
            if (k) {
                const newVal = v.join('=');
                if (cookieMap[k.trim()] !== newVal) {
                    cookieMap[k.trim()] = newVal;
                    updated = true;
                }
            }
        }

        if (updated) {
            const newCookieStr = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
            fs.writeFileSync(COOKIE_FILE, newCookieStr, 'utf-8');
            log('[keep-alive] 쿠키 갱신 완료');
        }
    } catch (err) {
        log(`[keep-alive] 쿠키 갱신 에러: ${err.message}`);
    }
}

// ============================================
// 세션 만료 → 자동 쿠키 갱신
// ============================================
let isRenewing = false;
let lastRenewAttempt = 0;
const RENEW_COOLDOWN = 5 * 60 * 1000; // 갱신 실패 후 5분 쿨다운

async function handleSessionExpiry() {
    if (isRenewing) return false;

    // 쿨다운 체크 — 연속 갱신 시도 방지
    const now = Date.now();
    if (now - lastRenewAttempt < RENEW_COOLDOWN) {
        const waitMin = Math.ceil((RENEW_COOLDOWN - (now - lastRenewAttempt)) / 60000);
        log(`[keep-alive] 쿨다운 중 (${waitMin}분 후 재시도 가능)`);
        return false;
    }

    isRenewing = true;
    lastRenewAttempt = now;
    log('[keep-alive] 세션 만료 감지 → 쿠키 자동 갱신 시도...');
    try {
        const newCookie = await renewCookie({ headless: false, timeout: 120000 });
        if (newCookie) {
            log('[keep-alive] 쿠키 갱신 성공! 계속 감시');
            isRenewing = false;
            return true;
        } else {
            log('[keep-alive] 쿠키 갱신 실패. 5분 후 재시도 또는 수동으로 cookie.txt 업데이트하세요');
            isRenewing = false;
            return false;
        }
    } catch (err) {
        log(`[keep-alive] 쿠키 갱신 에러: ${err.message}`);
        isRenewing = false;
        return false;
    }
}

// 마을 이름 조회
function getVillageName(x, y) {
    if (!CONFIG.villages) return `(${x}|${y})`;
    const v = CONFIG.villages.find(v => v.x === x && v.y === y);
    return v ? `${v.name} (${x}|${y})` : `(${x}|${y})`;
}

// ============================================
// game_data.player.incomings 추출
// ============================================
function getIncomingCount(html) {
    const match = /game_data\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(html);
    if (!match) return 0;
    try {
        const gd = JSON.parse(match[1]);
        return parseInt(gd.player?.incomings) || 0;
    } catch {
        return 0;
    }
}

// ============================================
// overview_villages incomings 페이지 fetch
// ============================================
async function fetchIncomingsPage() {
    const villageId = CONFIG.villages?.[0]?.id || CONFIG.myVillageId;
    const url = `${CONFIG.baseUrl}?village=${villageId}&screen=overview_villages&mode=incomings&subtype=attacks`;
    const headers = buildHeaders();
    headers['Accept'] = 'text/html,application/xhtml+xml,*/*';

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    updateCookieFromResponse(res);
    return res.text();
}

// ============================================
// 수신 공격 목록 파싱 (commandId, 좌표, 도착시간)
// ============================================
function parseIncomings(html) {
    const attacks = [];
    const seen = new Set();

    // 패턴: info_command&id=XXXXX&type=other
    const cmdRegex = /screen=info_command&(?:amp;)?id=(\d+)&(?:amp;)?type=other/g;
    let cmdMatch;

    while ((cmdMatch = cmdRegex.exec(html)) !== null) {
        const commandId = cmdMatch[1];
        if (seen.has(commandId)) continue;
        seen.add(commandId);

        const afterPos = cmdMatch.index;
        const start = Math.max(0, afterPos - 500);
        const context = html.slice(start, afterPos + 1500);

        // 좌표 추출: (XXX|YYY) — 첫 번째 = 출발, 두 번째 = 도착
        const coordMatches = [...context.matchAll(/\((\d{3})\|(\d{3})\)/g)];

        // 도착시간 추출
        const endtimeMatch = /data-endtime="(\d+)"/.exec(context);

        let originX = null, originY = null;
        let targetX = null, targetY = null;

        if (coordMatches.length >= 2) {
            originX = parseInt(coordMatches[0][1]);
            originY = parseInt(coordMatches[0][2]);
            targetX = parseInt(coordMatches[1][1]);
            targetY = parseInt(coordMatches[1][2]);
        } else if (coordMatches.length === 1) {
            originX = parseInt(coordMatches[0][1]);
            originY = parseInt(coordMatches[0][2]);
        }

        const arrivalTime = endtimeMatch ? parseInt(endtimeMatch[1]) * 1000 : null;

        attacks.push({ commandId, originX, originY, targetX, targetY, arrivalTime });
    }

    return attacks;
}

// ============================================
// info_command 페이지에서 출발시간 추출
// ============================================
async function fetchCommandDetail(cmdId) {
    const villageId = CONFIG.villages?.[0]?.id || CONFIG.myVillageId;
    const url = `${CONFIG.baseUrl}?village=${villageId}&screen=info_command&id=${cmdId}&type=other`;
    const headers = buildHeaders();
    headers['Accept'] = 'text/html,application/xhtml+xml,*/*';

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    updateCookieFromResponse(res);
    const html = await res.text();

    let launchTime = null;
    let arrivalTime = null;

    // 방법 1: data-endtime 속성들 (작은 값 = 출발, 큰 값 = 도착)
    const allEndtimes = [...html.matchAll(/data-endtime="(\d+)"/g)];
    if (allEndtimes.length >= 2) {
        const times = allEndtimes.map(m => parseInt(m[1]) * 1000).sort((a, b) => a - b);
        launchTime = times[0];
        arrivalTime = times[times.length - 1];
    } else if (allEndtimes.length === 1) {
        arrivalTime = parseInt(allEndtimes[0][1]) * 1000;
    }

    // 방법 2: 날짜 문자열 파싱 (fallback)
    if (!launchTime) {
        const dateRegex = /(\w{3}\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}(?::\d{3})?)/g;
        const dateMatches = [...html.matchAll(dateRegex)];
        if (dateMatches.length >= 2) {
            try {
                launchTime = new Date(dateMatches[0][1].replace(/:(\d{3})$/, '.$1')).getTime();
                if (!arrivalTime) {
                    arrivalTime = new Date(dateMatches[1][1].replace(/:(\d{3})$/, '.$1')).getTime();
                }
            } catch { /* ignore */ }
        }
    }

    return { launchTime, arrivalTime };
}

// ============================================
// 속도 → 공격유형 분류
// ============================================
function classifyAttackType(speed) {
    // 가장 가까운 기본 속도에 매칭 (속도 버프/너프 보정)
    var units = [
        { speed: 9,  type: 'spy',       label: '정찰 (spy)' },
        { speed: 10, type: 'light',     label: '경기병 (light cavalry)' },
        { speed: 11, type: 'heavy',     label: '중기병 (heavy cavalry)' },
        { speed: 18, type: 'axe_spear', label: '도끼/창병 (axe/spear)' },
        { speed: 22, type: 'sword',     label: '검병 (sword)' },
        { speed: 30, type: 'ram',       label: '공성 (ram/catapult)' },
        { speed: 35, type: 'snob',      label: '귀족 (snob)' },
    ];
    var best = units[units.length - 1];
    var bestDiff = Infinity;
    for (var i = 0; i < units.length; i++) {
        var diff = Math.abs(speed - units[i].speed);
        if (diff < bestDiff) { bestDiff = diff; best = units[i]; }
    }
    return { type: best.type, label: best.label };
}

// ============================================
// 귀족열차 그룹 감지
// ============================================
function detectNobleTrains(incomings) {
    // 같은 출발지 → 같은 목표로 그룹핑
    const groups = {};
    for (const atk of incomings) {
        if (!atk.originX || !atk.targetX || !atk.arrivalTime) continue;
        const key = `${atk.originX}|${atk.originY}->${atk.targetX}|${atk.targetY}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(atk);
    }

    const trains = [];
    for (const [key, group] of Object.entries(groups)) {
        if (group.length < 2) continue;

        group.sort((a, b) => a.arrivalTime - b.arrivalTime);

        // 연속 도착 간격 2분 이내 체크
        let isTrain = true;
        for (let i = 1; i < group.length; i++) {
            if (group[i].arrivalTime - group[i - 1].arrivalTime > 2 * 60 * 1000) {
                isTrain = false;
                break;
            }
        }
        if (!isTrain) continue;

        // snob 범위(28+) 속도가 1개 이상이면 "확정", 아니면 "의심"
        const hasSnobSpeed = group.some(a => a.speed && a.speed >= 28);

        trains.push({
            key,
            attacks: group,
            confirmed: hasSnobSpeed,
            label: hasSnobSpeed ? '귀족열차 확정!' : '귀족열차 의심!',
        });
    }

    return trains;
}

// ============================================
// 시간 포맷 헬퍼
// ============================================
function formatTimeRemaining(ms) {
    if (ms <= 0) return '도착!';
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}시간 ${mins}분 후`;
    return `${mins}분 후`;
}

// 한글 포함 문자열 표시폭 계산 (한글 = 2칸)
function displayWidth(str) {
    let w = 0;
    for (const ch of str) {
        const code = ch.codePointAt(0);
        // CJK, Hangul, fullwidth 등 더블폭 문자 판별
        if ((code >= 0x1100 && code <= 0x115F) ||
            (code >= 0x2E80 && code <= 0x303E) ||
            (code >= 0x3040 && code <= 0x9FFF) ||
            (code >= 0xAC00 && code <= 0xD7AF) ||
            (code >= 0xF900 && code <= 0xFAFF) ||
            (code >= 0xFE10 && code <= 0xFE6F) ||
            (code >= 0xFF01 && code <= 0xFF60) ||
            (code >= 0xFFE0 && code <= 0xFFE6)) {
            w += 2;
        } else {
            w += 1;
        }
    }
    return w;
}

// 표시폭 기준 패딩
function padEndDisplay(str, width) {
    const w = displayWidth(str);
    if (w >= width) return str;
    return str + ' '.repeat(width - w);
}

// ============================================
// 도착시간 지난 공격 자동 정리
// ============================================
function cleanupExpired() {
    const now = Date.now();
    for (const [cmdId, atk] of seenAttacks) {
        if (atk.arrivalTime && atk.arrivalTime < now) {
            seenAttacks.delete(cmdId);
        }
    }
}

// ============================================
// JSON 저장
// ============================================
function saveAttacks() {
    const data = {
        lastCheck: new Date().toISOString(),
        attacks: [...seenAttacks.values()].map(a => ({
            commandId: a.commandId,
            originX: a.originX, originY: a.originY,
            targetX: a.targetX, targetY: a.targetY,
            arrivalTime: a.arrivalTime ? new Date(a.arrivalTime).toISOString() : null,
            launchTime: a.launchTime ? new Date(a.launchTime).toISOString() : null,
            speed: a.speed || null,
            attackType: a.attackType?.type || null,
            attackLabel: a.attackType?.label || null,
            distance: a.distance || null,
            nobleTrain: a.nobleTrain || null,
        })),
    };
    fs.writeFileSync(ATTACKS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================
// 콘솔 출력
// ============================================
function printAttackReport(attacks, newCount, trains) {
    const now = Date.now();
    const active = attacks
        .filter(a => a.arrivalTime && a.arrivalTime > now)
        .sort((a, b) => a.arrivalTime - b.arrivalTime);

    if (active.length === 0) return;

    const W = 58; // 박스 내부 폭

    console.log('╔' + '═'.repeat(W) + '╗');
    console.log('║' + padEndDisplay(`  ⚠ 수신 공격: ${active.length}개 (신규: ${newCount})`, W) + '║');
    console.log('╠' + '═'.repeat(W) + '╣');

    active.forEach((atk, i) => {
        if (i > 0) console.log('╠' + '─'.repeat(W) + '╣');

        const tag = atk.isNew ? '[NEW] ' : '';
        const typeLabel = atk.attackType ? atk.attackType.label : '유형 미상';
        console.log('║' + padEndDisplay(`  #${i + 1} ${tag}${typeLabel}`, W) + '║');

        const originStr = atk.originX ? `(${atk.originX}|${atk.originY})` : '미상';
        const targetStr = atk.targetX ? getVillageName(atk.targetX, atk.targetY) : '미상';
        console.log('║' + padEndDisplay(`    출발: ${originStr}  →  도착: ${targetStr}`, W) + '║');

        if (atk.distance && atk.speed) {
            console.log('║' + padEndDisplay(`    거리: ${atk.distance}칸 | 속도: ${atk.speed.toFixed(1)} min/field`, W) + '║');
        }

        if (atk.arrivalTime) {
            const arrTime = new Date(atk.arrivalTime).toLocaleTimeString('ko-KR', { hour12: false });
            const remaining = formatTimeRemaining(atk.arrivalTime - now);
            console.log('║' + padEndDisplay(`    도착 예정: ${arrTime} (${remaining})`, W) + '║');
        }

        if (atk.nobleTrain) {
            console.log('║' + padEndDisplay(`    *** ${atk.nobleTrain} ***`, W) + '║');
        }
    });

    console.log('╚' + '═'.repeat(W) + '╝');

    // 귀족열차 요약
    for (const train of trains) {
        const [origin, target] = train.key.split('->');
        log(`*** 귀족열차 감지: ${origin} → ${target} (${train.attacks.length}연타, ${train.label}) ***`);
    }
}

// ============================================
// 메인 체크 (60초마다 호출)
// ============================================
async function checkIncomings() {
    try {
        cleanupExpired();

        // [1] overview → incomings 수 확인
        const villageId = CONFIG.villages?.[0]?.id || CONFIG.myVillageId;
        const overviewUrl = `${CONFIG.baseUrl}?village=${villageId}&screen=overview`;
        const overviewHeaders = buildHeaders();
        overviewHeaders['Accept'] = 'text/html,application/xhtml+xml,*/*';

        const overviewRes = await fetch(overviewUrl, {
            headers: overviewHeaders,
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
        });

        // 응답 쿠키 갱신
        updateCookieFromResponse(overviewRes);

        // 세션 만료 감지 → 자동 갱신
        if (overviewRes.status >= 300) {
            log('overview 요청 실패 (세션 만료?)');
            const renewed = await handleSessionExpiry();
            if (renewed) {
                // 갱신 성공 → 즉시 재시도
                log('[keep-alive] 갱신 후 재체크...');
                setTimeout(checkIncomings, 3000);
            }
            return;
        }

        const overviewHtml = await overviewRes.text();

        // 본문에서도 세션 만료 체크
        if (overviewHtml.includes('screen=login') || overviewHtml.includes('session_expired')) {
            log('세션 만료 감지 (본문)');
            const renewed = await handleSessionExpiry();
            if (renewed) {
                setTimeout(checkIncomings, 3000);
            }
            return;
        }

        lastCheckTime = Date.now();
        const incomingCount = getIncomingCount(overviewHtml);

        if (incomingCount === 0) return; // 수신 공격 없음 → 요청 1회로 종료

        log(`수신 공격 감지: ${incomingCount}개!`);

        // [2] incomings 페이지 → 공격 목록 파싱
        await sleep(2000 + Math.random() * 4000);
        const incomingsHtml = await fetchIncomingsPage();
        const incomings = parseIncomings(incomingsHtml);

        if (incomings.length === 0) {
            log('수신 공격 파싱 결과 0건 (페이지 구조 확인 필요)');
            return;
        }

        // [3] 신규 공격만 command detail 조회
        let newCount = 0;
        for (const atk of incomings) {
            if (seenAttacks.has(atk.commandId)) {
                // 기존 공격 — 기존 데이터 복사
                const existing = seenAttacks.get(atk.commandId);
                if (atk.arrivalTime) existing.arrivalTime = atk.arrivalTime;
                atk.isNew = false;
                atk.speed = existing.speed;
                atk.attackType = existing.attackType;
                atk.launchTime = existing.launchTime;
                atk.distance = existing.distance;
                atk.nobleTrain = existing.nobleTrain;
                continue;
            }

            atk.isNew = true;
            atk.firstSeenTime = Date.now();
            newCount++;

            // command detail 조회 → 출발시간 추출
            try {
                await sleep(2000 + Math.random() * 4000);
                const detail = await fetchCommandDetail(atk.commandId);
                atk.launchTime = detail.launchTime;
                if (detail.arrivalTime) atk.arrivalTime = detail.arrivalTime;
            } catch (err) {
                log(`  command ${atk.commandId} 상세조회 실패: ${err.message}`);
            }

            // 속도 계산 (2가지 방법)
            if (atk.originX && atk.targetX) {
                const dist = distance(atk.originX, atk.originY, atk.targetX, atk.targetY);
                if (dist > 0) {
                    atk.distance = Math.round(dist * 10) / 10;
                    let travelMs = 0;

                    // 방법 1: 출발시간이 있으면 정확한 계산
                    if (atk.launchTime && atk.arrivalTime) {
                        travelMs = atk.arrivalTime - atk.launchTime;
                    }
                    // 방법 2: 출발시간 없으면 → 처음 발견 시 남은 시간 ≈ 총 이동시간
                    // (30초 간격 체크 → 최대 30초 오차)
                    else if (atk.arrivalTime && atk.firstSeenTime) {
                        travelMs = atk.arrivalTime - atk.firstSeenTime;
                        log(`  command ${atk.commandId}: 출발시간 없음 → 남은시간 기반 추정 (${Math.round(travelMs/60000)}분)`);
                    }

                    if (travelMs > 0) {
                        atk.speed = travelMs / 60000 / dist;
                        atk.attackType = classifyAttackType(atk.speed);
                        log(`  → 속도: ${atk.speed.toFixed(1)} min/f, 거리: ${atk.distance}칸, 판별: ${atk.attackType.label}`);
                    }
                }
            }

            seenAttacks.set(atk.commandId, atk);
        }

        // [4] 귀족열차 감지
        const allTracked = [...seenAttacks.values()].filter(a => a.arrivalTime && a.arrivalTime > Date.now());
        const trains = detectNobleTrains(allTracked);

        // 열차 소속 공격에 태그
        for (const train of trains) {
            for (const a of train.attacks) {
                a.nobleTrain = train.label;
                // seenAttacks에도 반영
                if (seenAttacks.has(a.commandId)) {
                    seenAttacks.get(a.commandId).nobleTrain = train.label;
                }
            }
        }

        // 콘솔 출력 + JSON 저장
        printAttackReport(allTracked, newCount, trains);
        saveAttacks();

    } catch (err) {
        log(`체크 에러: ${err.message}`);
    }
}

// ============================================
// HTTP API 서버 (오버레이에 데이터 제공)
// ============================================
function getAttacksPayload() {
    const now = Date.now();
    const active = [...seenAttacks.values()]
        .filter(a => a.arrivalTime && a.arrivalTime > now)
        .sort((a, b) => a.arrivalTime - b.arrivalTime);

    return {
        lastCheck: lastCheckTime ? new Date(lastCheckTime).toISOString() : null,
        attacks: active.map(a => ({
            commandId: a.commandId,
            originX: a.originX, originY: a.originY,
            targetX: a.targetX, targetY: a.targetY,
            arrivalTime: a.arrivalTime ? new Date(a.arrivalTime).toISOString() : null,
            launchTime: a.launchTime ? new Date(a.launchTime).toISOString() : null,
            speed: a.speed || null,
            attackType: a.attackType?.type || null,
            attackLabel: a.attackType?.label || null,
            distance: a.distance || null,
            nobleTrain: a.nobleTrain || null,
        })),
    };
}

function startApiServer(port = 3001) {
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.url === '/api/attacks') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(getAttacksPayload()));
            return;
        }

        if (req.url === '/overlay.js') {
            try {
                const content = fs.readFileSync(path.join(__dirname, 'overlay.js'), 'utf-8');
                res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
                res.end(content);
            } catch {
                res.writeHead(404);
                res.end('overlay.js not found');
            }
            return;
        }

        res.writeHead(404);
        res.end('Not found');
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            log(`포트 ${port} 이미 사용 중 — API 서버 스킵 (기존 서버 사용)`);
        } else {
            log(`API 서버 에러: ${err.message}`);
        }
    });

    server.listen(port, () => {
        log(`API 서버 시작: http://localhost:${port}`);
    });
}

// ============================================
// 백그라운드 시작 / 중단
// ============================================
let intervalHandle = null;

function scheduleNext() {
    // 25~45초 랜덤 간격
    const delay = 25000 + Math.random() * 20000;
    intervalHandle = setTimeout(() => {
        checkIncomings().then(scheduleNext);
    }, delay);
}

function startBackground() {
    if (intervalHandle) return;
    log('백그라운드 감시 시작 (25~45초 랜덤 간격)');
    startApiServer();
    checkIncomings().then(scheduleNext);
}

function stopBackground() {
    if (intervalHandle) {
        clearTimeout(intervalHandle);
        intervalHandle = null;
        log('백그라운드 감시 중단');
    }
}

module.exports = { startBackground, stopBackground, checkIncomings };

// 단독 실행: node watcher.js
if (require.main === module) {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║   Attack Watcher (standalone)        ║');
    console.log('║   Ctrl+C 로 중단                     ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');
    startBackground();
}
