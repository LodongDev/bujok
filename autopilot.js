const fs = require('fs');
const path = require('path');
const { CONFIG, buildHeaders, sleep, distance } = require('./config');
const scanner = require('./scanner');
const reporter = require('./reporter');
const { renewCookie } = require('./cookie-renew');

const COOKIE_FILE = path.join(__dirname, 'cookie.txt');
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');

// whitelist.json에서 허용 좌표 목록 실시간 로드 ("XXX|YYY" 형식)
function getWhitelist() {
    try {
        const list = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf-8'));
        return new Set(list.map(s => s.trim()));
    } catch { return new Set(); }
}

// ============================================
// 세션 keep-alive — 사이클마다 호출하여 세션 유지 + 쿠키 갱신
// ============================================
async function keepAlive() {
    try {
        const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=overview`;
        const res = await fetch(url, {
            headers: buildHeaders(),
            redirect: 'manual',  // 리다이렉트 따라가지 않음 (로그인 페이지 감지용)
            signal: AbortSignal.timeout(15000),
        });

        // 로그인 페이지로 리다이렉트 → 세션 만료
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location') || '';
            if (location.includes('login') || location.includes('sid_wrong')) {
                log('[keep-alive] 세션 만료 감지 (리다이렉트)');
                return false;
            }
        }

        // 응답에서 Set-Cookie 추출 → cookie.txt 갱신
        const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        if (setCookies.length > 0) {
            const currentCookie = fs.readFileSync(COOKIE_FILE, 'utf-8').trim();
            const cookieMap = {};
            // 기존 쿠키 파싱
            for (const pair of currentCookie.split(';')) {
                const [k, ...v] = pair.trim().split('=');
                if (k) cookieMap[k.trim()] = v.join('=');
            }
            // 새 쿠키 병합
            let updated = false;
            for (const sc of setCookies) {
                const cookiePart = sc.split(';')[0]; // "name=value" 부분만
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
        }

        // 응답 본문으로 세션 상태 확인
        const html = await res.text();
        if (html.includes('screen=login') || html.includes('session_expired')) {
            log('[keep-alive] 세션 만료 감지 (본문)');
            return false;
        }

        return true;
    } catch (err) {
        log(`[keep-alive] 에러: ${err.message}`);
        return false;
    }
}

// ============================================
// 마을 ID 자동 감지 (여러 방법 시도)
// ============================================
async function detectVillageId(x, y) {
    const coordStr = `(${x}|${y})`;

    // Method 1: overview_villages 페이지 — 좌표 근처에서 village ID 찾기
    try {
        const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=overview_villages`;
        const headers = buildHeaders();
        headers['Accept'] = 'text/html,application/xhtml+xml,*/*';
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
        const html = await res.text();

        // 좌표를 먼저 찾고, 주변에서 village= 추출
        const coordIdx = html.indexOf(coordStr);
        if (coordIdx >= 0) {
            const start = Math.max(0, coordIdx - 600);
            const context = html.slice(start, coordIdx + 200);
            const matches = [...context.matchAll(/village=(\d+)/g)];
            if (matches.length > 0) {
                return parseInt(matches[matches.length - 1][1]); // 좌표에 가장 가까운 것
            }
        }

        // 반대 방향: village= 뒤에 좌표
        const regex = /village=(\d+)/g;
        let match;
        while ((match = regex.exec(html)) !== null) {
            const after = html.slice(match.index, match.index + 500);
            if (after.includes(coordStr)) {
                return parseInt(match[1]);
            }
        }
    } catch (err) {
        log(`  감지 method1 실패: ${err.message}`);
    }

    // Method 2: overview_villages AJAX — JSON 응답에서 찾기
    try {
        const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=overview_villages&mode=combined&page=0&ajax=load_villages`;
        const res = await fetch(url, { headers: buildHeaders(), signal: AbortSignal.timeout(30000) });
        const json = await res.json();
        const text = JSON.stringify(json);
        const coordIdx = text.indexOf(coordStr);
        if (coordIdx >= 0) {
            const start = Math.max(0, coordIdx - 500);
            const context = text.slice(start, coordIdx + 200);
            const matches = [...context.matchAll(/village=(\d+)/g)];
            if (matches.length > 0) {
                return parseInt(matches[matches.length - 1][1]);
            }
        }
    } catch (err) {
        log(`  감지 method2 실패: ${err.message}`);
    }

    // Method 3: game_data에서 player.villages 확인
    try {
        const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=overview`;
        const headers = buildHeaders();
        headers['Accept'] = 'text/html,*/*';
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
        const html = await res.text();

        // game_data JSON 추출
        const gdMatch = /game_data\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(html);
        if (gdMatch) {
            try {
                const gd = JSON.parse(gdMatch[1]);
                if (gd.player && gd.player.villages) {
                    for (const [id, v] of Object.entries(gd.player.villages)) {
                        if ((v.x == x && v.y == y) || v.coord === `${x}|${y}`) {
                            return parseInt(id);
                        }
                    }
                }
            } catch {}
        }
    } catch (err) {
        log(`  감지 method3 실패: ${err.message}`);
    }

    return null;
}

// ============================================
// 멀티 마을 초기화 — CONFIG.villages의 id가 null인 마을 자동 감지
// ============================================
async function initVillages() {
    const villages = CONFIG.villages;
    if (!villages || villages.length === 0) {
        return [{ name: '내 마을', id: CONFIG.myVillageId, x: CONFIG.myX, y: CONFIG.myY, farmDir: null }];
    }

    for (const v of villages) {
        if (v.id) continue;
        log(`[마을 감지] ${v.name} (${v.x},${v.y}) ID 탐색 중...`);
        const detectedId = await detectVillageId(v.x, v.y);
        if (detectedId) {
            v.id = detectedId;
            log(`[마을 감지] ${v.name} -> ID ${detectedId}`);
        } else {
            log(`[마을 감지] ${v.name} ID 감지 실패! config.js에 직접 입력하세요.`);
        }
    }

    const active = villages.filter(v => v.id);
    if (active.length === 0) {
        log('[마을 감지] 활성 마을 없음 → 기본 마을 사용');
        return [{ name: '내 마을', id: CONFIG.myVillageId, x: CONFIG.myX, y: CONFIG.myY, farmDir: null }];
    }

    return active;
}

// ============================================
// autopilot.js — 완전 자동화 (스캔 + 파밍 + 리포트)
// ============================================
// node autopilot.js              — 전부 자동 실행
// node autopilot.js --dry-run    — 실행 안 하고 계획만

const REPORT_EVERY_N_CYCLES = 5;  // N사이클마다 리포트 수집
const RESCAN_EVERY_N_CYCLES = 50; // N사이클마다 재스캔

const UNIT_TYPES = ['spear', 'sword', 'axe', 'spy', 'light', 'heavy', 'ram', 'catapult', 'snob'];

// 유닛 스펙
const UNIT_SPEED = { spear: 18, sword: 22, axe: 18, spy: 9, light: 10, heavy: 11, ram: 30, catapult: 30, snob: 35 };
const UNIT_CARRY = { spear: 25, sword: 15, axe: 10, spy: 0, light: 80, heavy: 50, ram: 0, catapult: 0, snob: 0 };

// 유닛 생산 비용
const UNIT_COST = {
    spear:  { wood: 50,  clay: 30,  iron: 10,  pop: 1, building: 'barracks' },
    sword:  { wood: 30,  clay: 30,  iron: 70,  pop: 1, building: 'barracks' },
    axe:    { wood: 60,  clay: 30,  iron: 40,  pop: 1, building: 'barracks' },
    spy:    { wood: 50,  clay: 50,  iron: 20,  pop: 2, building: 'stable' },
    light:  { wood: 125, clay: 100, iron: 250, pop: 4, building: 'stable' },
    heavy:  { wood: 200, clay: 150, iron: 600, pop: 6, building: 'stable' },
    ram:    { wood: 300, clay: 200, iron: 200, pop: 5, building: 'garage' },
    catapult: { wood: 320, clay: 400, iron: 100, pop: 8, building: 'garage' },
    snob:   { wood: 40000, clay: 50000, iron: 50000, pop: 100, building: 'snob' },
};

// 생산 우선순위 (페이즈별)
const RECRUIT_PRIORITY = {
    early:       [{ unit: 'spear', ratio: 0.7 }, { unit: 'sword', ratio: 0.3 }],
    transition:  [{ unit: 'light', ratio: 0.5 }, { unit: 'spear', ratio: 0.3 }, { unit: 'sword', ratio: 0.2 }],
    lc_dominant: [{ unit: 'light', ratio: 0.8 }, { unit: 'spear', ratio: 0.1 }, { unit: 'sword', ratio: 0.1 }],
};

// 페이즈별 파밍 설정 (farmer.js와 동일)
const PHASE_CONFIG = {
    early:       { name: '초반 (창병)', maxDistMin: 30, mainUnit: 'light', minPerTarget: { light: 1 }, maxPerTarget: { light: 10 } },
    transition:  { name: '전환기 (혼용)', maxDistMin: 30, mainUnit: 'light', minPerTarget: { light: 1 }, maxPerTarget: { light: 10 } },
    lc_dominant: { name: '중반 (LC)', maxDistMin: 500, mainUnit: 'light', minPerTarget: { light: 1 }, maxPerTarget: { light: 10 } },
};

function ts() { return new Date().toLocaleTimeString('ko-KR', { hour12: false }); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function troopStr(t) { return Object.entries(t).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ') || '없음'; }

// ============================================
// 게임 상태 조회 (command API)
// ============================================
async function getGameState(targetId) {
    const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=place&ajax=command&target=${targetId}`;
    const res = await fetch(url, { method: 'GET', headers: buildHeaders(), signal: AbortSignal.timeout(30000) });
    const json = await res.json();

    const csrf = json.game_data?.csrf;
    if (!csrf) {
        // 디버그: 응답 구조 출력
        const keys = Object.keys(json || {});
        const preview = JSON.stringify(json, null, 2).slice(0, 500);
        throw new Error(`csrf 없음 — 쿠키 만료 가능성. 응답 키: [${keys}]\n${preview}`);
    }

    const gd = json.game_data;
    const v = gd.village;

    // 자원
    const resources = {
        wood: Math.floor(v.wood_float || v.wood || 0),
        clay: Math.floor(v.stone_float || v.stone || 0),
        iron: Math.floor(v.iron_float || v.iron || 0),
    };

    // 인구
    const pop = { current: v.pop || 0, max: v.pop_max || 0, free: (v.pop_max || 0) - (v.pop || 0) };

    // 병력
    const responseHtml = typeof json.response === 'string'
        ? json.response : (json.response?.dialog || JSON.stringify(json.response));

    const troops = {};
    for (const unit of UNIT_TYPES) {
        const regex = new RegExp(`name="${unit}"[^>]*data-all-count="(\\d+)"`, 'i');
        const match = regex.exec(responseHtml);
        troops[unit] = match ? parseInt(match[1]) : 0;
    }

    // 동적 토큰
    let dynamicToken = null;
    const hiddenRegex = /name="([a-f0-9]{20,})"[^>]*value="([a-f0-9]+)"/g;
    let m = hiddenRegex.exec(responseHtml);
    if (m) dynamicToken = { name: m[1], value: m[2] };
    if (!dynamicToken) {
        const altRegex = /value="([a-f0-9]+)"[^>]*name="([a-f0-9]{20,})"/g;
        m = altRegex.exec(responseHtml);
        if (m) dynamicToken = { name: m[2], value: m[1] };
    }

    return { csrf, resources, pop, troops, dynamicToken };
}

// ============================================
// 출정 중인 명령 + 귀환 시간 조회
// ============================================
async function getReturningCommands(phase) {
    // overview 페이지에서 명령 정보 조회
    const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=overview`;
    const headers = buildHeaders();
    headers['Accept'] = 'text/html,application/xhtml+xml,*/*';

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    const html = await res.text();

    const commands = [];

    // 현재 페이즈에서 사용하는 유닛 중 가장 느린 속도 (= 이동시간 결정)
    const phaseCfg = PHASE_CONFIG[phase || 'early'];
    const maxSpeed = Math.max(...Object.keys(phaseCfg.maxPerTarget).map(u => UNIT_SPEED[u] || 18));

    // overview 페이지 구조:
    //   data-command-type="return" ... (XXX|YYY) ... data-endtime="..."
    //   data-command-type="attack" ... (XXX|YYY) ... data-endtime="..."
    const typeRegex = /data-command-type="(return|attack)"/g;
    let typeMatch;

    while ((typeMatch = typeRegex.exec(html)) !== null) {
        const type = typeMatch[1];
        const afterPos = typeMatch.index + typeMatch[0].length;
        const remaining = html.slice(afterPos, afterPos + 2000);

        const endtimeMatch = /data-endtime="(\d+)"/.exec(remaining);
        if (!endtimeMatch) continue;

        const endtimeSec = parseInt(endtimeMatch[1]);
        const endtimeMs = endtimeSec * 1000;

        // 타겟 좌표 추출: (XXX|YYY) 형식
        const coordMatch = /\((\d{3})\|(\d{3})\)/.exec(remaining);
        let targetX = null, targetY = null;
        if (coordMatch) {
            targetX = parseInt(coordMatch[1]);
            targetY = parseInt(coordMatch[2]);
        }

        if (type === 'return') {
            // 귀환 중 → endtime = 마을 도착 시간 (정확)
            commands.push({ type, endtimeMs, availableAt: endtimeMs, targetX, targetY });
        } else {
            // 공격 중 → endtime = 타겟 도착 시간
            // 복귀 시간 = 타겟 도착 + 편도 이동 시간
            let availableAt = endtimeMs; // 기본값 (좌표 없으면 타겟 도착 시간)
            if (targetX !== null && targetY !== null) {
                const dist = Math.sqrt((targetX - CONFIG.myX) ** 2 + (targetY - CONFIG.myY) ** 2);
                const oneWayMs = dist * maxSpeed * 60 * 1000;
                availableAt = endtimeMs + oneWayMs;
            }
            commands.push({ type, endtimeMs, availableAt: Math.round(availableAt), targetX, targetY });
        }
    }

    // 대안: data-command-type을 못 찾은 경우, data-endtime만이라도 추출
    if (commands.length === 0) {
        const timerRegex = /widget-command-timer[^>]*data-endtime="(\d+)"/g;
        let match;
        while ((match = timerRegex.exec(html)) !== null) {
            const endtimeMs = parseInt(match[1]) * 1000;
            commands.push({ type: 'unknown', endtimeMs, availableAt: endtimeMs });
        }
    }

    // 미래만 + availableAt 기준 정렬
    const now = Date.now();
    const pending = commands
        .filter(c => c.availableAt > now)
        .sort((a, b) => a.availableAt - b.availableAt);

    const returns = pending.filter(c => c.type === 'return');
    const attacks = pending.filter(c => c.type === 'attack');

    // 가장 빨리 병력이 돌아오는 시간
    const nextAvailable = pending.length > 0 ? pending[0].availableAt : null;

    return {
        total: pending.length,
        returns: returns.length,
        attacks: attacks.length,
        nextAvailable,
        allPending: pending,
    };
}

// ============================================
// 페이즈 감지
// ============================================
function detectPhase(troops) {
    const lc = troops.light || 0;
    const sp = troops.spear || 0;
    if (lc === 0) return 'early';
    if (lc < sp) return 'transition';
    return 'lc_dominant';
}

// ============================================
// 마을별 예상 자원 계산 (자원 생산량 × 경과 시간)
// ============================================
function estimateResources(farm) {
    const pts = farm.points || 0;

    // 포인트 기반 기본 생산량 (총 자원/시간)
    let prodPerHour;
    if (pts <= 26)       prodPerHour = 60;
    else if (pts <= 50)  prodPerHour = 100;
    else if (pts <= 100) prodPerHour = 180;
    else if (pts <= 200) prodPerHour = 300;
    else if (pts <= 500) prodPerHour = 500;
    else                 prodPerHour = 800;

    // 실제 haul 데이터로 생산량 보정 (최근 5회)
    const haulEntries = (farm.history || []).filter(h => h.haul !== undefined && h.haul > 0);
    if (haulEntries.length >= 2) {
        const recent = haulEntries.slice(-5);
        let totalHaul = 0, totalHours = 0;
        for (let i = 1; i < recent.length; i++) {
            const hours = (new Date(recent[i].date) - new Date(recent[i - 1].date)) / 3600000;
            if (hours > 0.1 && hours < 24) {
                totalHaul += recent[i].haul;
                totalHours += hours;
            }
        }
        if (totalHours > 0) {
            const observed = totalHaul / totalHours;
            prodPerHour = Math.round(observed * 0.7 + prodPerHour * 0.3);
        }
    }

    // 마지막 공격 이후 경과 시간
    const lastRaid = farm.lastAttack ? new Date(farm.lastAttack).getTime() : 0;
    const hoursSince = lastRaid > 0 ? (Date.now() - lastRaid) / 3600000 : 24;

    // 창고 용량 (포인트 기반 추정)
    const storage = pts <= 50 ? 1000 : pts <= 100 ? 2000 : pts <= 300 ? 4000 : 8000;

    return Math.min(Math.round(prodPerHour * hoursSince), storage);
}

// ============================================
// 병력 생산
// ============================================
async function recruitTroops(csrf, resources, pop, phase) {
    const priority = RECRUIT_PRIORITY[phase];
    const recruited = {};
    let totalRecruited = 0;

    for (const { unit, ratio } of priority) {
        const cost = UNIT_COST[unit];
        if (!cost) continue;

        // 자원으로 최대 생산 가능 수
        const maxByWood = Math.floor(resources.wood / cost.wood);
        const maxByClay = Math.floor(resources.clay / cost.clay);
        const maxByIron = Math.floor(resources.iron / cost.iron);
        const maxByPop = Math.floor(pop.free / cost.pop);
        const maxPossible = Math.min(maxByWood, maxByClay, maxByIron, maxByPop);

        if (maxPossible <= 0) continue;

        // 자원의 일정 비율만 사용 (전부 쓰면 안 됨)
        const budgetCount = Math.max(1, Math.floor(maxPossible * ratio));
        const count = Math.min(budgetCount, maxPossible);

        if (count <= 0) continue;

        // 생산 요청
        const building = cost.building;
        const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=${building}&ajaxaction=train&mode=train&h=${csrf}`;

        const params = new URLSearchParams();
        params.append(`units[${unit}]`, String(count));
        params.append('h', csrf);

        const headers = buildHeaders();
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';

        try {
            const res = await fetch(url, { method: 'POST', headers, body: params.toString() });
            const status = res.status;

            if (status === 200) {
                recruited[unit] = count;
                totalRecruited += count;

                // 자원 차감 (로컬 추적)
                resources.wood -= cost.wood * count;
                resources.clay -= cost.clay * count;
                resources.iron -= cost.iron * count;
                pop.free -= cost.pop * count;

                log(`  생산 요청: ${unit} x${count} (${building})`);
            } else {
                log(`  생산 실패: ${unit} x${count} -> HTTP ${status}`);
            }
        } catch (err) {
            log(`  생산 에러: ${unit} -> ${err.message}`);
        }

        await sleep(500);
    }

    return { recruited, totalRecruited };
}

// ============================================
// 파밍 로직 (farmer.js 핵심 로직 인라인)
// ============================================
function calculateAllocation(pool, farm, phase) {
    const cfg = PHASE_CONFIG[phase];
    const losses = farm.losses || 0;
    const avgHaul = farm.avgHaul || 0;
    const hasHistory = (farm.history || []).length > 0;

    if (losses > 0 && avgHaul < 50 && hasHistory) return null;

    const lc = pool.light || 0;
    if (lc < 1) return null;

    // 경기병만 사용, 최대 10마리
    const estRes = estimateResources(farm);
    let needed = Math.max(1, Math.ceil(estRes * 1.2 / UNIT_CARRY.light));

    // 히스토리 보정
    if (hasHistory) {
        if (losses > 0 && avgHaul >= 50) {
            const boost = Math.min(losses, 3);
            needed = Math.ceil(needed * (1 + 0.3 * boost));
        }
        const recentFull = (farm.history || []).slice(-3).filter(h => h.fullHaul).length;
        if (recentFull >= 2 && losses === 0) {
            needed = Math.ceil(needed * 1.3);
        }
    }

    // 상한 10마리, 보유량 이내
    needed = Math.min(needed, 10, lc);

    return { light: needed };
}

function createAttackPlan(available, targets, phase, outgoingTargets) {
    const cfg = PHASE_CONFIG[phase];
    const pool = { ...available };
    const plan = [];
    const speed = phase === 'early' ? UNIT_SPEED.spear : UNIT_SPEED.light;

    // 야만인 마을 + 화이트리스트 유저 마을 | 이동시간 범위 | 출정 중 아닌 | 보호 아닌 | 자원 충분
    const now = new Date().toISOString();
    const whitelist = getWhitelist();
    let lowResSkipped = 0;
    const eligible = targets.filter(t => {
        const coordKey = `${t.x}|${t.y}`;
        const isWhitelisted = whitelist.has(coordKey);
        if (!isWhitelisted && t.playerId && t.playerId !== '0' && t.playerId !== 0) return false;
        if (t.distance * speed > cfg.maxDistMin) return false;
        if (outgoingTargets && outgoingTargets.has(t.id)) return false;
        if (t.protectedUntil && t.protectedUntil > now) return false;
        // 자원 추정: 예상 자원이 LC 1대 적재량(80) 미만이면 스킵
        const estRes = estimateResources(t);
        if (estRes < 80) { lowResSkipped++; return false; }
        return true;
    });
    if (lowResSkipped > 0) log(`  자원 부족 추정: ${lowResSkipped}개 마을 스킵`);

    // 효율 정렬: 예상 자원 / 이동시간 (높은 순) → 가까이 자원 많은 곳 우선
    eligible.sort((a, b) => {
        const aEff = estimateResources(a) / a.distance;
        const bEff = estimateResources(b) / b.distance;
        return bEff - aEff;
    });

    for (const farm of eligible) {
        const alloc = calculateAllocation(pool, farm, phase);
        if (!alloc) continue;

        let canSend = true;
        // alloc에 뭔가 있어야 보낼 수 있음
        const totalAlloc = Object.values(alloc).reduce((s, v) => s + v, 0);
        if (totalAlloc === 0) canSend = false;
        if (canSend) {
            for (const [u, c] of Object.entries(alloc)) {
                if ((pool[u] || 0) < c) { canSend = false; break; }
            }
        }
        if (!canSend) continue;

        for (const [u, c] of Object.entries(alloc)) pool[u] = (pool[u] || 0) - c;

        const carry = Object.entries(alloc).reduce((s, [u, c]) => s + (UNIT_CARRY[u] || 0) * c, 0);
        const travelMin = Math.round(farm.distance * speed);

        plan.push({ farm, troops: alloc, carry, travelMin });
    }

    // 2차: 남은 LC를 각 타겟에 균등 추가 분배 (유휴 병력 방지)
    if (phase === 'lc_dominant' && plan.length > 0 && (pool.light || 0) > 0) {
        const extraPerTarget = Math.floor(pool.light / plan.length);
        if (extraPerTarget > 0) {
            for (const p of plan) {
                const maxAllowed = (cfg.maxPerTarget.light || 50) - (p.troops.light || 0);
                const extra = Math.min(extraPerTarget, maxAllowed);
                if (extra > 0) {
                    p.troops.light = (p.troops.light || 0) + extra;
                    p.carry += extra * UNIT_CARRY.light;
                    pool.light -= extra;
                }
            }
        }
    }

    return plan;
}

async function postConfirm(targetX, targetY, troops, csrf, dynamicToken) {
    const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=place&ajax=confirm`;
    const params = new URLSearchParams();
    if (dynamicToken) params.append(dynamicToken.name, dynamicToken.value);
    params.append('template_id', '');
    params.append('source_village', String(CONFIG.myVillageId));
    for (const u of UNIT_TYPES) params.append(u, String(troops[u] || 0));
    params.append('x', String(targetX));
    params.append('y', String(targetY));
    params.append('attack', 'true');
    params.append('h', csrf);

    const headers = buildHeaders();
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    const res = await fetch(url, { method: 'POST', headers, body: params.toString(), signal: AbortSignal.timeout(30000) });
    const json = await res.json();

    const dialog = typeof json.response === 'string' ? json.response : (json.response?.dialog || JSON.stringify(json.response));

    // ch 추출 시도: hidden input, JSON 필드 등
    const chM = /name="ch"[^>]*value="([^"]+)"/.exec(dialog) || /value="([^"]+)"[^>]*name="ch"/.exec(dialog);
    if (chM) return chM[1];
    if (json.response?.ch) return json.response.ch;

    // 보호 감지 (초보자 보호 / 포인트 비율 보호)
    const errStr = JSON.stringify(json);
    if (errStr.includes('beginner protection') || errStr.includes('ratio between')) {
        throw new Error('VILLAGE_PROTECTED');
    }

    log(`    [DEBUG] confirm 전체 응답: ${errStr.slice(0, 500)}`);
    throw new Error('ch 없음 — confirm 응답 확인 필요');
}

async function sendAttack(targetX, targetY, troops, csrf, ch) {
    const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=place&ajaxaction=popup_command`;
    const params = new URLSearchParams();
    params.append('attack', 'true');
    params.append('ch', ch);
    params.append('cb', 'troop_confirm_submit');
    params.append('x', String(targetX));
    params.append('y', String(targetY));
    params.append('source_village', String(CONFIG.myVillageId));
    params.append('village', String(CONFIG.myVillageId));
    for (const u of UNIT_TYPES) params.append(u, String(troops[u] || 0));
    params.append('building', 'main');
    params.append('h', csrf);

    const headers = buildHeaders();
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    const res = await fetch(url, { method: 'POST', headers, body: params.toString(), signal: AbortSignal.timeout(30000) });
    return res.json();
}

// ============================================
// 실시간 적응형 파밍 — 매 공격마다 병력 재조회 + 배분
// ============================================
async function farmAdaptive(targets, phase, outgoingTargets, db, dirOptions = {}) {
    const { farmDir, villageX, villageY, dirBoundaryY } = dirOptions;
    const cfg = PHASE_CONFIG[phase];
    const speed = phase === 'early' ? UNIT_SPEED.spear : UNIT_SPEED.light;
    const whitelist = getWhitelist();
    const attackedThisCycle = new Set();
    let totalAttacks = 0;
    let lastTroops = null;

    while (true) {
        // 1. 타겟 선정 (매 루프 재필터 — 이번 사이클 공격한 곳 제외)
        const now = new Date().toISOString();
        const eligible = targets.filter(t => {
            if (attackedThisCycle.has(t.id)) return false;
            const coordKey = `${t.x}|${t.y}`;
            const isWhitelisted = whitelist.has(coordKey);
            if (!isWhitelisted && t.playerId && t.playerId !== '0' && t.playerId !== 0) return false;
            // 방향 필터 (north: 경계선 이북, south: 경계선 이남)
            if (farmDir === 'north' && dirBoundaryY !== null && dirBoundaryY !== undefined && t.y > dirBoundaryY) return false;
            if (farmDir === 'south' && dirBoundaryY !== null && dirBoundaryY !== undefined && t.y <= dirBoundaryY) return false;
            // 이 마을로부터의 거리 계산
            const dist = villageX !== undefined ? distance(t.x, t.y, villageX, villageY) : t.distance;
            if (dist * speed > cfg.maxDistMin) return false;
            if (outgoingTargets && outgoingTargets.has(t.id)) return false;
            if (t.protectedUntil && t.protectedUntil > now) return false;
            // 가까운 마을은 자원 적어도 보냄 (놀리는 것보다 나음)
            const estRes = estimateResources(t);
            const minRes = dist <= 3 ? 20 : 50;
            if (estRes < minRes) return false;
            return true;
        }).sort((a, b) => {
            const distA = villageX !== undefined ? distance(a.x, a.y, villageX, villageY) : a.distance;
            const distB = villageX !== undefined ? distance(b.x, b.y, villageX, villageY) : b.distance;
            return estimateResources(b) / distB - estimateResources(a) / distA;
        });

        if (eligible.length === 0) {
            if (totalAttacks === 0) log('  보낼 마을 없음');
            else log(`  대상 소진`);
            break;
        }

        const farm = eligible[0];

        // 2. 실시간 병력 + 토큰 조회 (타겟별 개별 조회)
        let state;
        try {
            state = await getGameState(farm.id);
        } catch (err) {
            log(`  상태 조회 실패: ${err.message}`);
            break;
        }

        const pool = state.troops;
        lastTroops = { ...pool };

        // 3. 병력 체크 — LC 최소 3 미만이면 종료
        if ((pool.light || 0) < 3) {
            log(`  LC 소진 (잔여: ${troopStr(pool)})`);
            break;
        }

        // 4. 실시간 병력 기반 배분
        const alloc = calculateAllocation(pool, farm, phase);
        if (!alloc || Object.values(alloc).reduce((s, v) => s + v, 0) === 0) {
            attackedThisCycle.add(farm.id);
            continue;
        }

        // 실제 보유 확인
        let canSend = true;
        for (const [u, c] of Object.entries(alloc)) {
            if ((pool[u] || 0) < c) { canSend = false; break; }
        }
        if (!canSend) { attackedThisCycle.add(farm.id); continue; }

        const carry = Object.entries(alloc).reduce((s, [u, c]) => s + (UNIT_CARRY[u] || 0) * c, 0);
        const estRes = estimateResources(farm);
        log(`  [${totalAttacks + 1}] ${farm.id} (${farm.x},${farm.y}) ${troopStr(alloc)} | 적재:${carry} | 예상:${estRes}`);

        if (totalAttacks === 0) {
            log(`    token: ${state.dynamicToken ? state.dynamicToken.name.slice(0, 8) + '...' : 'null'}, csrf: ${state.csrf.slice(0, 8)}...`);
        }

        // 5. 공격 전송
        try {
            await sleep(800);
            const ch = await postConfirm(farm.x, farm.y, alloc, state.csrf, state.dynamicToken);
            await sleep(800);
            const result = await sendAttack(farm.x, farm.y, alloc, state.csrf, ch);
            const success = !result.error;

            log(success ? '    -> 전송!' : `    -> 실패: ${JSON.stringify(result.error)}`);

            const dbFarm = db.farms.find(f => f.id === farm.id);
            if (success) {
                totalAttacks++;
                if (dbFarm) {
                    dbFarm.lastAttack = new Date().toISOString();
                    dbFarm.history.push({ date: new Date().toISOString(), troops: alloc, carry, success: true });
                }
            } else if (dbFarm) {
                dbFarm.history.push({ date: new Date().toISOString(), troops: alloc, carry, success: false });
            }

            attackedThisCycle.add(farm.id);
        } catch (err) {
            if (err.message === 'VILLAGE_PROTECTED') {
                const dbFarm = db.farms.find(f => f.id === farm.id);
                if (dbFarm) {
                    dbFarm.protectedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                    log(`    보호 중 → 24시간 스킵`);
                }
                attackedThisCycle.add(farm.id);
            } else {
                log(`    에러: ${err.message}`);
                break;
            }
        }

        await sleep(CONFIG.commandDelayMs);
    }

    log(`  전송 완료: ${totalAttacks}회`);
    return { totalAttacks, lastTroops };
}

// ============================================
// 메인 루프
// ============================================
async function autopilot(options = {}) {
    const { dryRun } = options;

    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║   Tribal Wars Autopilot              ║');
    console.log('║   Ctrl+C 로 중단                     ║');
    if (dryRun) {
        console.log('║   [DRY RUN MODE]                     ║');
    }
    console.log('╚══════════════════════════════════════╝');
    console.log('');

    const watcher = require('./watcher');
    watcher.startBackground();

    // --- 0. 시작 시 스캔 (farm-db 없거나 오래된 경우) ---
    const needScan = !fs.existsSync(CONFIG.farmDbFile) || (() => {
        try {
            const db = JSON.parse(fs.readFileSync(CONFIG.farmDbFile, 'utf-8'));
            const age = Date.now() - new Date(db.lastScan).getTime();
            return age > 6 * 60 * 60 * 1000; // 6시간 이상 경과
        } catch { return true; }
    })();

    if (needScan) {
        log('[초기 스캔] farm-db가 없거나 오래됨 → 스캔 시작...');
        try {
            await scanner.main();
            log('[초기 스캔] 완료!');
        } catch (err) {
            log(`[초기 스캔] 에러: ${err.message}`);
            if (!fs.existsSync(CONFIG.farmDbFile)) {
                log('farm-db.json을 생성할 수 없습니다. 종료합니다.');
                process.exit(1);
            }
        }
    }

    // --- 멀티 마을 초기화 ---
    log('[마을 초기화]');
    let activeVillages = await initVillages();
    let dirBoundaryY = activeVillages.length >= 2
        ? Math.floor(activeVillages.reduce((s, v) => s + v.y, 0) / activeVillages.length)
        : null;

    for (const v of activeVillages) {
        const dirLabel = v.farmDir === 'north' ? '북쪽' : v.farmDir === 'south' ? '남쪽' : '전체';
        log(`  ${v.name} (${v.x},${v.y}) ID:${v.id} → ${dirLabel} 파밍`);
    }
    if (dirBoundaryY !== null) {
        log(`  방향 경계선: y=${dirBoundaryY} (이하=북, 초과=남)`);
    }

    let cycle = 0;
    let consecutiveErrors = 0;

    while (true) {
        cycle++;
        let waitMs = 5 * 60 * 1000; // 기본 5분

        try {

        // --- 미감지 마을 재시도 ---
        if (CONFIG.villages && activeVillages.length < CONFIG.villages.length) {
            const missing = CONFIG.villages.filter(v => !v.id);
            for (const v of missing) {
                try {
                    log(`[마을 감지] ${v.name} (${v.x},${v.y}) 재시도...`);
                    const detectedId = await detectVillageId(v.x, v.y);
                    if (detectedId) {
                        v.id = detectedId;
                        activeVillages.push(v);
                        log(`[마을 감지] ${v.name} -> ID ${detectedId} 감지 성공!`);
                        // 경계선 재계산
                        dirBoundaryY = Math.floor(activeVillages.reduce((s, vi) => s + vi.y, 0) / activeVillages.length);
                        log(`  방향 경계선 갱신: y=${dirBoundaryY}`);
                    }
                } catch (err) {
                    log(`[마을 감지] ${v.name} 재시도 실패: ${err.message}`);
                }
            }
        }

        // --- 주기적 재스캔 ---
        if (cycle > 1 && cycle % RESCAN_EVERY_N_CYCLES === 0) {
            log('[재스캔] 주기적 마을 재스캔...');
            try { await scanner.main(); } catch (err) { log(`  재스캔 에러: ${err.message}`); }
        }

        // --- 주기적 리포트 수집 ---
        if (cycle > 1 && cycle % REPORT_EVERY_N_CYCLES === 0) {
            log('[리포트] 전투 리포트 수집...');
            try { await reporter.main(1); } catch (err) { log(`  리포트 에러: ${err.message}`); }
        }

        const db = JSON.parse(fs.readFileSync(CONFIG.farmDbFile, 'utf-8'));
        const targets = db.farms.sort((a, b) => a.distance - b.distance);

        if (targets.length === 0) {
            log('대상 마을이 없습니다. 재스캔 필요.');
            break;
        }

        console.log('');
        log(`======= 사이클 #${cycle} =======`);

        // --- 세션 keep-alive ---
        const sessionOk = await keepAlive();
        if (!sessionOk) {
            log('[keep-alive] 세션 만료 → 쿠키 갱신 시도...');
            try {
                const newCookie = await renewCookie({ headless: false, timeout: 120000 });
                if (newCookie) {
                    log('[keep-alive] 쿠키 갱신 성공! 계속 진행');
                } else {
                    log('[keep-alive] 쿠키 갱신 실패. 수동으로 cookie.txt를 업데이트하세요');
                    await sleep(5 * 60 * 1000);
                    continue;
                }
            } catch (renewErr) {
                log(`[keep-alive] 갱신 에러: ${renewErr.message}`);
                await sleep(5 * 60 * 1000);
                continue;
            }
        }

        // --- 멀티 마을 순회 파밍 ---
        let globalEarliestNext = null;
        let globalIdleLC = 0;

        for (const village of activeVillages) {
            // 마을 전환
            CONFIG.myVillageId = village.id;
            CONFIG.myX = village.x;
            CONFIG.myY = village.y;

            try {
                const dirLabel = village.farmDir === 'north' ? '북쪽' : village.farmDir === 'south' ? '남쪽' : '전체';
                console.log('');
                log(`--- ${village.name} (${village.x},${village.y}) [${dirLabel}] ---`);

                // --- 1. 상태 조회 ---
                const state = await getGameState(targets[0].id);
                const { troops, resources, pop } = state;
                const phase = detectPhase(troops);

                log(`  병력: ${troopStr(troops)}`);
                log(`  자원: W:${resources.wood} C:${resources.clay} I:${resources.iron}`);
                log(`  페이즈: ${PHASE_CONFIG[phase].name}`);

                await sleep(500);

                // --- 2. 출정 중인 마을 제외 ---
                let outgoingTargets = new Set();
                try {
                    const cmdsPreCheck = await getReturningCommands(phase);
                    for (const cmd of cmdsPreCheck.allPending) {
                        if (cmd.type !== 'attack') continue;
                        if (cmd.targetX && cmd.targetY) {
                            const match = targets.find(t => t.x === cmd.targetX && t.y === cmd.targetY);
                            if (match) outgoingTargets.add(match.id);
                        }
                    }
                    if (outgoingTargets.size > 0) {
                        log(`  공격 진행 중 ${outgoingTargets.size}개 제외`);
                    }
                } catch (err) {
                    log(`  출정 체크 실패: ${err.message}`);
                }

                // --- 3. 파밍 (실시간 적응형 + 방향 필터) ---
                log('[파밍]');
                if (!dryRun) {
                    const farmResult = await farmAdaptive(targets, phase, outgoingTargets, db, {
                        farmDir: village.farmDir,
                        villageX: village.x,
                        villageY: village.y,
                        dirBoundaryY,
                    });
                    fs.writeFileSync(CONFIG.farmDbFile, JSON.stringify(db, null, 2), 'utf-8');

                    if (farmResult.lastTroops) Object.assign(troops, farmResult.lastTroops);
                    log(`  잔여 병력: ${troopStr(troops)}`);
                } else {
                    const plan = createAttackPlan(troops, targets, phase, outgoingTargets);
                    if (plan.length === 0) log('  보낼 병력이 없습니다');
                    else {
                        log(`  [DRY] 공격 계획: ${plan.length}회`);
                        for (const p of plan) {
                            const estRes = estimateResources(p.farm);
                            log(`    ${p.farm.id} (${p.farm.x},${p.farm.y}) ${troopStr(p.troops)} | 예상:${estRes}`);
                        }
                    }
                }

                // --- 4. 귀환 체크 ---
                log('[귀환 체크]');
                try {
                    const cmds = await getReturningCommands(phase);
                    log(`  출정: ${cmds.total}개 (귀환:${cmds.returns} 공격:${cmds.attacks})`);

                    if (cmds.allPending.length > 0) {
                        for (const cmd of cmds.allPending.slice(0, 3)) {
                            const coordStr = cmd.targetX ? `(${cmd.targetX}|${cmd.targetY})` : '';
                            const returnEta = Math.round((cmd.availableAt - Date.now()) / 60000);
                            const returnTime = new Date(cmd.availableAt).toLocaleTimeString('ko-KR', { hour12: false });
                            if (cmd.type === 'return') {
                                log(`    귀환 ${coordStr} -> ${returnEta}분 후 (${returnTime})`);
                            } else if (cmd.type === 'attack') {
                                log(`    공격 ${coordStr} -> 복귀 ${returnEta}분 후 (${returnTime})`);
                            }
                        }
                    }

                    const idleLC = troops.light || 0;
                    globalIdleLC += idleLC;

                    if (cmds.nextAvailable) {
                        if (!globalEarliestNext || cmds.nextAvailable < globalEarliestNext) {
                            globalEarliestNext = cmds.nextAvailable;
                        }
                    }
                } catch (err) {
                    log(`  귀환 체크 에러: ${err.message}`);
                }

            } catch (err) {
                // 세션 에러는 전체로 전파 → 쿠키 갱신 트리거
                if (err.message.includes('csrf') || err.message.includes('쿠키') || err.message.includes('session')) {
                    throw err;
                }
                log(`  ${village.name} 에러: ${err.message}`);
            }
        }

        // --- 전체 대기 시간 결정 ---
        console.log('');
        if (globalIdleLC >= 3) {
            if (globalEarliestNext) {
                waitMs = globalEarliestNext - Date.now() + 30000;
                const waitMin = Math.round(waitMs / 60000);
                log(`  -> 유휴 ${globalIdleLC} LC (전체), 귀환 후 재확인 (${waitMin}분)`);
            } else {
                waitMs = 5 * 60 * 1000;
                log(`  -> 유휴 ${globalIdleLC} LC (전체), 5분 후 재확인`);
            }
        } else if (globalEarliestNext) {
            waitMs = globalEarliestNext - Date.now() + 30000;
            const waitMin = Math.round(waitMs / 60000);
            const arriveTime = new Date(globalEarliestNext).toLocaleTimeString('ko-KR', { hour12: false });
            log(`  -> 첫 병력 복귀까지 ${waitMin}분 대기 (${arriveTime})`);
        } else {
            waitMs = 5 * 60 * 1000;
            log('  -> 출정 없음, 5분 후 재확인');
        }

        consecutiveErrors = 0; // 성공 시 리셋

        } catch (err) {
            consecutiveErrors++;
            console.log('');
            log(`======= 사이클 #${cycle} 에러 =======`);
            log(`  ${err.message}`);

            if (err.message.includes('session') || err.message.includes('csrf') || err.message.includes('쿠키 만료')) {
                // 세션 만료 → 자동 쿠키 갱신 시도
                log('  -> 세션 만료 감지! 쿠키 자동 갱신 시도...');
                try {
                    const newCookie = await renewCookie({ headless: false, timeout: 120000 });
                    if (newCookie) {
                        log('  -> 쿠키 갱신 성공! 즉시 재시도');
                        consecutiveErrors = 0;
                        waitMs = 5000; // 5초 후 바로 재시도
                    } else {
                        log('  -> 쿠키 갱신 실패. 수동으로 cookie.txt를 업데이트하세요');
                        waitMs = Math.min(30 * 60 * 1000, consecutiveErrors * 5 * 60 * 1000);
                    }
                } catch (renewErr) {
                    log(`  -> 쿠키 갱신 에러: ${renewErr.message}`);
                    waitMs = Math.min(30 * 60 * 1000, consecutiveErrors * 5 * 60 * 1000);
                }
            } else {
                waitMs = 30 * 1000; // 네트워크 에러 → 30초 후 재시도
                log('  -> 30초 후 재시도');
            }
        }

        // 최소 1분, 최대 120분
        // 최소 1분, 최대 15분 (병력 생산 중이므로 자주 확인)
        waitMs = Math.max(60000, Math.min(15 * 60000, waitMs));
        const waitMin = Math.round(waitMs / 60000);
        const nextTime = new Date(Date.now() + waitMs).toLocaleTimeString('ko-KR', { hour12: false });
        log(`[대기] ${waitMin}분 후 다음 사이클 (${nextTime})`);

        if (dryRun) {
            log('[DRY RUN] 1회 사이클 완료, 종료합니다.');
            break;
        }

        await sleep(waitMs);
    }
}

// CLI
const dryRun = process.argv.includes('--dry-run');

// --village 옵션: 특정 마을만 실행 (이름 또는 ID)
// 예: node autopilot.js --village 1번마을
//     node autopilot.js --village 24333
//     node autopilot.js --village 1번마을,3번마을
const villageArgIdx = process.argv.indexOf('--village');
if (villageArgIdx !== -1 && process.argv[villageArgIdx + 1]) {
    const filters = process.argv[villageArgIdx + 1].split(',').map(s => s.trim());
    const original = CONFIG.villages || [];
    const filtered = original.filter(v =>
        filters.some(f => v.name === f || String(v.id) === f)
    );
    if (filtered.length === 0) {
        console.error(`[에러] --village "${filters.join(',')}" 에 해당하는 마을을 찾을 수 없습니다.`);
        console.error(`사용 가능한 마을: ${original.map(v => `${v.name}(${v.id})`).join(', ')}`);
        process.exit(1);
    }
    CONFIG.villages = filtered;
    console.log(`[마을 필터] ${filtered.map(v => v.name).join(', ')} 만 실행합니다.`);
}

autopilot({ dryRun }).catch(err => {
    console.error(`\n[치명적 에러] ${err.message}`);
    process.exit(1);
});
