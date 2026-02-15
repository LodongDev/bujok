const fs = require('fs');
const { CONFIG, buildHeaders, sleep } = require('./config');

// ============================================
// farmer.js — 스마트 병력 배분 파밍
// ============================================
// 페이즈 자동 감지 → 마을당 병력 자동 계산 → 놀리는 병력 0

const UNIT_TYPES = ['spear', 'sword', 'axe', 'spy', 'light', 'heavy', 'ram', 'catapult', 'snob'];

// 유닛 스펙
const UNIT_SPEED = { spear: 18, sword: 22, axe: 18, spy: 9, light: 10, heavy: 11, ram: 30, catapult: 30, snob: 35 };
const UNIT_CARRY = { spear: 25, sword: 15, axe: 10, spy: 0, light: 80, heavy: 50, ram: 0, catapult: 0, snob: 0 };

// 페이즈별 설정
const PHASE_CONFIG = {
    early: {
        name: '초반 (경기병 파밍)',
        maxDistMinutes: 30,
        mainUnit: 'light',
        minPerTarget: { light: 1 },
        maxPerTarget: { light: 10 },
    },
    transition: {
        name: '전환기 (경기병)',
        maxDistMinutes: 30,
        mainUnit: 'light',
        minPerTarget: { light: 1 },
        maxPerTarget: { light: 10 },
    },
    lc_dominant: {
        name: '중반 (경기병)',
        maxDistMinutes: 40,
        mainUnit: 'light',
        minPerTarget: { light: 1 },
        maxPerTarget: { light: 10 },
    },
};

function loadFarmDb() {
    if (!fs.existsSync(CONFIG.farmDbFile)) {
        console.error('farm-db.json이 없습니다. 먼저 scanner.js를 실행하세요.');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(CONFIG.farmDbFile, 'utf-8'));
}

function saveFarmDb(db) {
    fs.writeFileSync(CONFIG.farmDbFile, JSON.stringify(db, null, 2), 'utf-8');
}

function troopStr(troops) {
    return Object.entries(troops).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ') || '없음';
}

// ============================================
// 페이즈 감지
// ============================================
function detectPhase(available) {
    const lc = available.light || 0;
    const spear = available.spear || 0;

    if (lc === 0) return 'early';
    if (lc < spear) return 'transition';
    return 'lc_dominant';
}

// ============================================
// 이동 시간 계산 (편도, 분)
// ============================================
function travelTime(distance, phase) {
    return distance * UNIT_SPEED.light;
}

// ============================================
// 마을당 병력 자동 배정 (히스토리 반영)
// ============================================
// 판단 기준:
//   1. 벽 레벨 (리포트에서 수집)     → 기본 편제 결정
//   2. 손실 이력 + 약탈량           → 보정
//      - 손실 O + 약탈 높음 → 병력 증파 (벽 뚫을 가치 있음)
//      - 손실 O + 약탈 낮음 → 스킵 (손해)
//      - 손실 X + 약탈 높음 → 현행 유지 또는 소폭 증가
//      - 첫 공격 (이력 없음) → 기본 편제
function calculateAllocation(available, farm, phase) {
    const losses = farm.losses || 0;
    const avgHaul = farm.avgHaul || 0;
    const hasHistory = (farm.history || []).length > 0;

    // 손실 있는데 약탈 낮음 → 스킵
    if (losses > 0 && avgHaul < 50 && hasHistory) return null;

    const lc = available.light || 0;
    if (lc < 1) return null;

    // 경기병만 사용, 최대 10마리
    let needed = 5; // 기본

    // --- 히스토리 보정 ---
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

// ============================================
// 스마트 공격 계획 생성
// ============================================
function createAttackPlan(available, targets, phase) {
    const cfg = PHASE_CONFIG[phase];
    const pool = { ...available };
    const plan = [];

    // 거리 필터 (이동 시간 기준)
    const eligible = targets.filter(t => travelTime(t.distance, phase) <= cfg.maxDistMinutes);

    let skippedByHistory = 0;

    for (const farm of eligible) {
        // 이 마을에 보낼 병력 계산 (null이면 히스토리 기반 스킵)
        const alloc = calculateAllocation(pool, farm, phase);

        if (alloc === null) {
            skippedByHistory++;
            continue;
        }

        // 최소 요구량 충족하는지 확인
        let canSend = true;
        for (const [unit, min] of Object.entries(cfg.minPerTarget)) {
            const sending = alloc[unit] || 0;
            const have = pool[unit] || 0;
            if (sending < min || have < (alloc[unit] || 0)) {
                canSend = false;
                break;
            }
        }

        // 풀에 충분한지 확인
        if (canSend) {
            for (const [unit, count] of Object.entries(alloc)) {
                if ((pool[unit] || 0) < count) {
                    canSend = false;
                    break;
                }
            }
        }

        if (!canSend) continue;

        // 풀에서 차감
        for (const [unit, count] of Object.entries(alloc)) {
            pool[unit] = (pool[unit] || 0) - count;
        }

        // 적재량 계산
        const carry = Object.entries(alloc).reduce((sum, [unit, count]) => {
            return sum + (UNIT_CARRY[unit] || 0) * count;
        }, 0);

        const travel = Math.round(travelTime(farm.distance, phase));

        plan.push({ farm, troops: alloc, carry, travelMin: travel });
    }

    return { plan, remaining: pool, skipped: targets.length - eligible.length, skippedByHistory };
}

// ============================================
// 가용 병력 조회
// ============================================
async function getAvailableTroops(targetId) {
    const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=place&ajax=command&target=${targetId}`;
    const res = await fetch(url, { method: 'GET', headers: buildHeaders() });
    const json = await res.json();

    const csrf = json.game_data?.csrf;
    if (!csrf) throw new Error('csrf 토큰을 찾을 수 없습니다');

    const responseHtml = typeof json.response === 'string'
        ? json.response
        : (json.response?.dialog || JSON.stringify(json.response));

    const troops = {};
    for (const unit of UNIT_TYPES) {
        const regex = new RegExp(`name="${unit}"[^>]*data-all-count="(\\d+)"`, 'i');
        const match = regex.exec(responseHtml);
        troops[unit] = match ? parseInt(match[1]) : 0;
    }

    let dynamicToken = null;
    const hiddenRegex = /name="([a-f0-9]{20,})"[^>]*value="([a-f0-9]+)"/g;
    let m = hiddenRegex.exec(responseHtml);
    if (m) dynamicToken = { name: m[1], value: m[2] };
    if (!dynamicToken) {
        const altRegex = /value="([a-f0-9]+)"[^>]*name="([a-f0-9]{20,})"/g;
        m = altRegex.exec(responseHtml);
        if (m) dynamicToken = { name: m[2], value: m[1] };
    }

    return { troops, csrf, dynamicToken };
}

// ============================================
// 3단계 공격 (confirm → send)
// ============================================
async function postConfirm(targetX, targetY, troops, csrf, dynamicToken) {
    const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=place&ajax=confirm`;
    const params = new URLSearchParams();
    if (dynamicToken) params.append(dynamicToken.name, dynamicToken.value);
    params.append('template_id', '');
    params.append('source_village', String(CONFIG.myVillageId));
    for (const unit of UNIT_TYPES) params.append(unit, String(troops[unit] || 0));
    params.append('x', String(targetX));
    params.append('y', String(targetY));
    params.append('input', 'attack');
    params.append('h', csrf);

    const headers = buildHeaders();
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    const res = await fetch(url, { method: 'POST', headers, body: params.toString() });
    const json = await res.json();

    const dialogHtml = typeof json.response === 'string'
        ? json.response : (json.response?.dialog || JSON.stringify(json.response));
    const chMatch = /name="ch"[^>]*value="([^"]+)"/.exec(dialogHtml)
        || /value="([^"]+)"[^>]*name="ch"/.exec(dialogHtml);
    if (!chMatch && !json.response?.ch) throw new Error('ch 해시를 찾을 수 없습니다');
    return chMatch ? chMatch[1] : json.response.ch;
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
    for (const unit of UNIT_TYPES) params.append(unit, String(troops[unit] || 0));
    params.append('building', 'main');
    params.append('h', csrf);

    const headers = buildHeaders();
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    const res = await fetch(url, { method: 'POST', headers, body: params.toString() });
    return res.json();
}

// ============================================
// 메인
// ============================================
async function runFarming(options = {}) {
    const db = loadFarmDb();
    const { tier: targetTier, dryRun } = options;

    console.log('========================================');
    console.log(' Tribal Wars Smart Farmer');
    console.log(`  내 마을: (${db.myVillage.x}, ${db.myVillage.y})`);
    console.log('========================================\n');

    // 대상 목록
    const tiersToFarm = targetTier ? [targetTier] : ['core', 'growth', 'risk'];
    const targets = db.farms
        .filter(f => tiersToFarm.includes(f.tier))
        .sort((a, b) => a.distance - b.distance);

    if (targets.length === 0) {
        console.log('공격 대상이 없습니다.');
        return;
    }

    // 병력 조회
    console.log('[1] 병력 조회 중...');
    const { troops: available, csrf, dynamicToken } = await getAvailableTroops(targets[0].id);

    // 페이즈 감지
    const phase = detectPhase(available);
    const phaseInfo = PHASE_CONFIG[phase];

    console.log(`\n  가용 병력: ${troopStr(available)}`);
    console.log(`  페이즈: ${phaseInfo.name}`);
    console.log(`  주력: ${phaseInfo.mainUnit} | 최대 편도: ${phaseInfo.maxDistMinutes}분`);

    // 공격 계획 자동 생성
    console.log('\n[2] 병력 배분 계산 중...\n');
    const { plan, remaining, skipped, skippedByHistory } = createAttackPlan(available, targets, phase);

    if (plan.length === 0) {
        console.log('병력이 부족하거나 범위 내 대상이 없습니다.');
        return;
    }

    // 계획 출력
    const skipInfo = [];
    if (skipped > 0) skipInfo.push(`거리초과: ${skipped}`);
    if (skippedByHistory > 0) skipInfo.push(`손해마을: ${skippedByHistory}`);
    console.log(`  공격: ${plan.length}회` + (skipInfo.length > 0 ? ` | 제외: ${skipInfo.join(', ')}` : ''));
    console.log('');
    console.log('  #  | tier   | 대상              | 거리  | 편도  | 병력                   | 적재');
    console.log('-----|--------|-------------------|-------|-------|------------------------|-----');
    for (let i = 0; i < plan.length; i++) {
        const { farm: f, troops, carry, travelMin } = plan[i];
        const num = String(i + 1).padStart(3);
        const tier = f.tier.padEnd(6);
        const target = `${f.id} (${f.x},${f.y})`.padEnd(17);
        const dist = f.distance.toFixed(1).padStart(5);
        const time = `${travelMin}분`.padStart(5);
        const ts = troopStr(troops).padEnd(22);
        console.log(`  ${num} | ${tier} | ${target} | ${dist} | ${time} | ${ts} | ${carry}`);
    }

    // 총 적재량
    const totalCarry = plan.reduce((s, p) => s + p.carry, 0);
    console.log(`\n  총 적재량: ${totalCarry} | 잔여 병력: ${troopStr(remaining)}`);

    if (dryRun) {
        console.log('\n[DRY RUN 완료]');
        return;
    }

    // 실행
    console.log('\n[3] 공격 실행\n');
    const results = [];
    let sent = 0;

    for (let i = 0; i < plan.length; i++) {
        const { farm, troops } = plan[i];
        console.log(`--- [${i + 1}/${plan.length}] ${farm.id} (${farm.x},${farm.y}) [${farm.tier}] ---`);
        console.log(`  ${troopStr(troops)}`);

        try {
            let curCsrf = csrf;
            let curToken = dynamicToken;

            if (i > 0) {
                const tokenData = await getAvailableTroops(farm.id);
                curCsrf = tokenData.csrf;
                curToken = tokenData.dynamicToken;

                // 실시간 병력 체크
                let canSend = true;
                for (const [unit, count] of Object.entries(troops)) {
                    if ((tokenData.troops[unit] || 0) < count) {
                        canSend = false;
                        break;
                    }
                }
                if (!canSend) {
                    console.log('  [스킵] 병력 부족 (출정 중)');
                    continue;
                }
                await sleep(800);
            }

            const ch = await postConfirm(farm.x, farm.y, troops, curCsrf, curToken);
            await sleep(800);

            const result = await sendAttack(farm.x, farm.y, troops, curCsrf, ch);
            const success = !result.error;

            console.log(success ? '  -> 전송!' : `  -> 실패: ${JSON.stringify(result.error || result)}`);
            if (success) sent++;
            results.push({ farmId: farm.id, success });

            const dbFarm = db.farms.find(f => f.id === farm.id);
            if (dbFarm) {
                dbFarm.lastAttack = new Date().toISOString();
                dbFarm.history.push({ date: new Date().toISOString(), troops, success });
            }
        } catch (err) {
            console.error(`  에러: ${err.message}`);
            results.push({ farmId: farm.id, success: false, error: err.message });
        }

        if (i < plan.length - 1) await sleep(CONFIG.commandDelayMs);
    }

    saveFarmDb(db);

    console.log('\n========================================');
    console.log(` 완료: ${sent}/${plan.length} 전송`);
    console.log(` 잔여: ${troopStr(remaining)}`);
    console.log('========================================');
}

// CLI
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--tier' && args[i + 1]) options.tier = args[++i];
        else if (args[i] === '--dry-run') options.dryRun = true;
    }
    return options;
}

runFarming(parseArgs()).catch(console.error);
