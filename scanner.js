const fs = require('fs');
const { CONFIG, buildHeaders, sleep, distance } = require('./config');

// ============================================
// 맵 청크 스캔 (nearby.js 로직 재사용)
// ============================================
function getChunkOrigins(cx, cy, radius) {
    const origins = [];
    const startX = Math.floor((cx - radius) / 20) * 20;
    const startY = Math.floor((cy - radius) / 20) * 20;
    const endX = Math.floor((cx + radius) / 20) * 20;
    const endY = Math.floor((cy + radius) / 20) * 20;

    for (let y = startY; y <= endY; y += 20) {
        for (let x = startX; x <= endX; x += 20) {
            origins.push({ x, y });
        }
    }
    return origins;
}

async function fetchMapChunk(ox, oy) {
    const ts = Date.now();
    const url = `${CONFIG.serverUrl}/map.php?v=2&locale=en_DK&e=${ts}&${ox}_${oy}=1`;

    const res = await fetch(url, {
        headers: {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Cookie': CONFIG.cookie,
            'Tribalwars-Ajax': '1',
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
    });

    return res.json();
}

// ============================================
// Step 1: 주변 마을 스캔
// ============================================
async function scanVillages() {
    const { myX, myY, searchRadius } = CONFIG;

    // 멀티 마을: 모든 마을을 포함하는 확장 스캔 영역
    let scanCenterX = myX, scanCenterY = myY, scanRadius = searchRadius;
    if (CONFIG.villages && CONFIG.villages.length > 1) {
        const xs = CONFIG.villages.map(v => v.x);
        const ys = CONFIG.villages.map(v => v.y);
        scanCenterX = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
        scanCenterY = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
        // 마을 간 최대 거리의 절반 + 기본 반경
        const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        scanRadius = searchRadius + Math.ceil(spread / 2);
        console.log(`[스캔] 멀티 마을 확장 스캔: 중심 (${scanCenterX},${scanCenterY}), 반경 ${scanRadius}칸`);
    }

    const chunks = getChunkOrigins(scanCenterX, scanCenterY, scanRadius);
    console.log(`[스캔] 맵 청크 ${chunks.length}개 요청 중...`);

    const allVillages = [];

    for (let i = 0; i < chunks.length; i++) {
        const { x: ox, y: oy } = chunks[i];
        try {
            const jsonArr = await fetchMapChunk(ox, oy);
            const data = jsonArr[0]?.data;
            if (!data) {
                console.log(`  [${i + 1}/${chunks.length}] (${ox},${oy}) -- 데이터 없음`);
                continue;
            }

            const { villages, players, allies } = data;
            let count = 0;

            for (let row = 0; row < 20; row++) {
                const rowData = villages[row];
                if (!rowData) continue;
                for (const col of Object.keys(rowData)) {
                    const v = rowData[col];
                    const vx = ox + row;
                    const vy = oy + parseInt(col);
                    // 아무 마을에서든 반경 안이면 포함
                    let minDist = distance(myX, myY, vx, vy);
                    if (CONFIG.villages && CONFIG.villages.length > 1) {
                        for (const mv of CONFIG.villages) {
                            const d = distance(mv.x, mv.y, vx, vy);
                            if (d < minDist) minDist = d;
                        }
                    }
                    const dist = minDist;

                    if (dist <= searchRadius) {
                        const villageId = v[0];
                        const points = v[3];
                        const playerId = v[4];

                        let playerName = '야만인 마을';
                        let allyName = '';
                        if (playerId && playerId !== '0' && players && players[playerId]) {
                            const p = players[playerId];
                            playerName = p[0];
                            const allyId = p[2];
                            if (allyId && allyId !== '0' && allies && allies[allyId]) {
                                allyName = allies[allyId][2];
                            }
                        }

                        allVillages.push({
                            id: String(villageId),
                            x: vx,
                            y: vy,
                            distance: Math.round(dist * 100) / 100,
                            points: parseInt(points) || 0,
                            playerId: String(playerId),
                            playerName,
                            ally: allyName,
                        });
                        count++;
                    }
                }
            }
            console.log(`  [${i + 1}/${chunks.length}] (${ox},${oy}) -- ${count}개 마을`);
        } catch (err) {
            console.error(`  [${i + 1}/${chunks.length}] (${ox},${oy}) -- 에러: ${err.message}`);
        }

        if (i < chunks.length - 1) await sleep(500 + Math.floor(Math.random() * 500));
    }

    // 중복 제거 + 거리순 정렬
    const seen = new Set();
    const unique = allVillages
        .filter(v => {
            if (seen.has(v.id)) return false;
            seen.add(v.id);
            return true;
        })
        .sort((a, b) => a.distance - b.distance);

    console.log(`[스캔] 총 ${unique.length}개 마을 수집 완료\n`);
    return unique;
}

// ============================================
// Step 2: 파밍 후보 필터링
// ============================================
function filterCandidates(villages) {
    const myId = String(CONFIG.myVillageId);

    const candidates = villages.filter(v => {
        // 내 마을 제외
        if (v.id === myId) return false;
        // 야만인 마을 → 무조건 후보
        if (v.playerId === '0') return true;
        // 유저 마을 중 포인트 낮은 것 → 후보
        if (v.points <= CONFIG.tiers.growth.maxPoints) return true;
        return false;
    });

    const barbarian = candidates.filter(v => v.playerId === '0').length;
    const player = candidates.filter(v => v.playerId !== '0').length;
    console.log(`[필터] 후보 ${candidates.length}개 (야만인: ${barbarian}, 유저: ${player})`);

    return candidates;
}

// ============================================
// Step 3: 초보자 보호 체크 (command API)
// ============================================
async function checkProtection(candidates) {
    const CONCURRENCY = CONFIG.protectionConcurrency || 5;
    const WORKER_DELAY = CONFIG.commandDelayMs;

    console.log(`[보호체크] ${candidates.length}개 후보에 대해 command API 확인 중... (워커 ${CONCURRENCY}개)`);

    // 단일 마을 보호 체크
    async function checkOne(v) {
        const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=place&ajax=command&target=${v.id}`;
        let isProtected = false;

        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: buildHeaders(),
            });

            if (res.status !== 200) {
                isProtected = true;
            } else {
                let body;
                try {
                    body = await res.json();
                } catch {
                    body = await res.text();
                }
                const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
                if (bodyStr.includes('beginner') || bodyStr.includes('protection') || bodyStr.includes('redirect')) {
                    isProtected = true;
                }
            }
        } catch (err) {
            isProtected = true;
        }

        return { ...v, protected: isProtected };
    }

    const results = new Array(candidates.length);
    let protectedCount = 0;
    let processedCount = 0;
    let cursor = 0;

    // 워커 풀: 각 워커가 독립적으로 큐에서 작업을 가져와 처리
    async function worker(workerId) {
        // 워커별 시차 시작 (동시 출발 방지)
        await sleep(workerId * 300 + Math.floor(Math.random() * 200));

        while (cursor < candidates.length) {
            const idx = cursor++;
            if (idx >= candidates.length) return;

            const result = await checkOne(candidates[idx]);
            results[idx] = result;

            processedCount++;
            if (result.protected) {
                protectedCount++;
                console.log(`  [${processedCount}/${candidates.length}] ${result.id} (${result.x},${result.y}) -- 보호중/제외`);
            } else {
                console.log(`  [${processedCount}/${candidates.length}] ${result.id} (${result.x},${result.y}) -- 공격 가능`);
            }

            // 각 워커의 다음 요청까지 딜레이 (개별 워커는 사람처럼 보임)
            await sleep(WORKER_DELAY + Math.floor(Math.random() * 500));
        }
    }

    const workerCount = Math.min(CONCURRENCY, candidates.length);
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));

    const available = results.filter(r => r && !r.protected);
    console.log(`[보호체크] 공격 가능: ${available.length} / 보호중: ${protectedCount}\n`);

    return results.filter(Boolean);
}

// ============================================
// Step 4: 등급 분류 (core / growth / risk)
// ============================================
function classifyTiers(checkedVillages) {
    const { core: coreRule, growth: growthRule } = CONFIG.tiers;

    const farms = checkedVillages
        .filter(v => !v.protected)
        .map(v => {
            let tier;
            if (v.playerId === '0' && v.distance <= coreRule.maxDistance && v.points <= coreRule.maxPoints) {
                tier = 'core';
            } else if (v.distance <= growthRule.maxDistance && v.points <= growthRule.maxPoints) {
                tier = 'growth';
            } else {
                tier = 'risk';
            }

            return {
                id: v.id,
                x: v.x,
                y: v.y,
                distance: v.distance,
                points: v.points,
                playerId: v.playerId,
                playerName: v.playerName,
                ally: v.ally,
                tier,
                protected: false,
                history: [],
                avgHaul: 0,
                losses: 0,
                lastAttack: null,
                wallLevel: 0,
            };
        });

    const stats = {
        core: farms.filter(f => f.tier === 'core').length,
        growth: farms.filter(f => f.tier === 'growth').length,
        risk: farms.filter(f => f.tier === 'risk').length,
        excluded: checkedVillages.filter(v => v.protected).length,
    };

    console.log(`[분류] Core: ${stats.core} | Growth: ${stats.growth} | Risk: ${stats.risk} | 제외: ${stats.excluded}`);

    return { farms, stats };
}

// ============================================
// Step 5: farm-db.json 저장
// ============================================
function saveFarmDb(farms, stats) {
    const db = {
        lastScan: new Date().toISOString(),
        myVillage: {
            id: CONFIG.myVillageId,
            x: CONFIG.myX,
            y: CONFIG.myY,
        },
        farms,
        stats,
    };

    fs.writeFileSync(CONFIG.farmDbFile, JSON.stringify(db, null, 2), 'utf-8');
    console.log(`\n[저장] ${CONFIG.farmDbFile} 저장 완료 (${farms.length}개 파밍 대상)`);
}

// ============================================
// 결과 요약 출력
// ============================================
function printSummary(farms) {
    console.log('\n========================================');
    console.log(' 파밍 대상 요약');
    console.log('========================================\n');

    const tiers = ['core', 'growth', 'risk'];
    for (const tier of tiers) {
        const tierFarms = farms.filter(f => f.tier === tier);
        console.log(`--- ${tier.toUpperCase()} (${tierFarms.length}개) ---`);
        console.log('거리 | 좌표       | ID    | 포인트 | 소유자');
        console.log('-----|------------|-------|--------|--------');
        for (const f of tierFarms) {
            const coord = `(${f.x},${f.y})`.padEnd(10);
            const id = String(f.id).padEnd(5);
            const pts = String(f.points).padEnd(6);
            const dist = f.distance.toFixed(1).padStart(4);
            const owner = f.playerName.slice(0, 15);
            console.log(`${dist} | ${coord} | ${id} | ${pts} | ${owner}`);
        }
        console.log('');
    }
}

// ============================================
// 메인 실행
// ============================================
async function main() {
    console.log('========================================');
    console.log(' Tribal Wars Farm Scanner');
    console.log(` 내 마을: (${CONFIG.myX}, ${CONFIG.myY}) [ID: ${CONFIG.myVillageId}]`);
    console.log(` 탐색 반경: ${CONFIG.searchRadius}칸`);
    console.log('========================================\n');

    // Step 1: 맵 스캔
    const villages = await scanVillages();

    // Step 2: 파밍 후보 필터링
    const candidates = filterCandidates(villages);

    // Step 3: 초보자 보호 체크
    const checked = await checkProtection(candidates);

    // Step 4: 등급 분류
    const { farms, stats } = classifyTiers(checked);

    // Step 5: 저장
    saveFarmDb(farms, stats);

    // 요약 출력
    printSummary(farms);

    console.log('========================================');
    console.log(' 스캔 완료!');
    console.log(` 다음: node autopilot.js --dry-run`);
    console.log('========================================');
}

// 모듈로 사용 시 export, 직접 실행 시 main()
module.exports = { main, scanVillages, filterCandidates, checkProtection, classifyTiers, saveFarmDb };
if (require.main === module) main().catch(console.error);
