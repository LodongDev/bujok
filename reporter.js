const fs = require('fs');
const { CONFIG, buildHeaders, sleep } = require('./config');

// ============================================
// reporter.js — 리포트 수집 + farm-db 업데이트
// ============================================
// 1. 리포트 목록 페이지에서 리포트 ID 추출
// 2. 개별 리포트에서 전투 결과 파싱
// 3. farm-db.json 업데이트 (avgHaul, losses, wallLevel)

// ============================================
// 리포트 목록 가져오기
// ============================================
async function fetchReportList(page = 0) {
    const from = page * 12; // 페이지당 12개씩
    const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=report&mode=attack&group_id=0&from=${from}`;

    const headers = buildHeaders();
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

    const res = await fetch(url, { headers });
    return res.text();
}

// 리포트 목록 HTML에서 리포트 ID 추출
function parseReportIds(html) {
    const ids = [];

    // 패턴 1: view=12345678 링크
    const viewRegex = /view=(\d{5,})/g;
    let match;
    while ((match = viewRegex.exec(html)) !== null) {
        const id = match[1];
        if (!ids.includes(id)) {
            ids.push(id);
        }
    }

    return ids;
}

// ============================================
// 개별 리포트 가져오기
// ============================================
async function fetchReport(reportId) {
    const url = `${CONFIG.baseUrl}?village=${CONFIG.myVillageId}&screen=report&mode=all&group_id=0&view=${reportId}`;

    const headers = buildHeaders();
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

    const res = await fetch(url, { headers });
    return res.text();
}

// ============================================
// 리포트 HTML 파싱
// ============================================
function parseReport(html, reportId) {
    const report = {
        id: reportId,
        type: null,        // 'attack' | 'defense' | 'other'
        target: null,      // { x, y, villageId, name }
        attacker: null,     // { name, villageId }
        troops: {},         // { spear: { sent, lost }, ... }
        haul: { wood: 0, clay: 0, iron: 0, total: 0, capacity: 0 },
        wallBefore: null,
        wallAfter: null,
        fullHaul: false,
        timestamp: null,
    };

    // --- 공격/방어 판별 ---
    if (html.includes('att_hack_header') || html.includes('attack_results') || html.includes('attacks')) {
        report.type = 'attack';
    } else if (html.includes('def_hack_header') || html.includes('defense_results') || html.includes('defends')) {
        report.type = 'defense';
    } else {
        report.type = 'other';
    }

    // --- 타겟 마을 좌표 추출 ---
    // 패턴: (XXX|YYY) 형식의 좌표
    // 보통 "Defender" 섹션 또는 링크에 좌표가 있음
    const coordRegex = /\((\d{3})\|(\d{3})\)/g;
    const coords = [];
    let coordMatch;
    while ((coordMatch = coordRegex.exec(html)) !== null) {
        coords.push({ x: parseInt(coordMatch[1]), y: parseInt(coordMatch[2]) });
    }

    // 내 마을이 아닌 좌표 = 타겟
    if (coords.length > 0) {
        const target = coords.find(c => c.x !== CONFIG.myX || c.y !== CONFIG.myY);
        if (target) {
            report.target = target;
        }
    }

    // --- 타겟 마을 ID 추출 ---
    const villageIdRegex = /village=(\d+)/g;
    const villageIds = [];
    let vidMatch;
    while ((vidMatch = villageIdRegex.exec(html)) !== null) {
        const vid = parseInt(vidMatch[1]);
        if (vid !== CONFIG.myVillageId && !villageIds.includes(vid)) {
            villageIds.push(vid);
        }
    }
    if (villageIds.length > 0 && report.target) {
        report.target.villageId = villageIds[0];
    }

    // --- 약탈 자원 파싱 ---
    // 실제 구조: Haul:    20 134 154    308/400
    // HTML 태그를 벗기고 "Haul" 이후 숫자들을 순서대로 추출
    const haulSectionRegex = /Haul[\s\S]{0,500}/i;
    const haulSection = haulSectionRegex.exec(html);

    if (haulSection) {
        // HTML 태그 제거 → 텍스트만
        const stripped = haulSection[0].replace(/<[^>]+>/g, ' ');
        // 모든 숫자 추출 (점 구분자 포함: 1.234)
        const numbers = stripped.match(/[\d.]+/g);

        // [wood, clay, iron, total, capacity] 순서
        if (numbers && numbers.length >= 5) {
            report.haul.wood = parseInt(numbers[0].replace(/\./g, ''));
            report.haul.clay = parseInt(numbers[1].replace(/\./g, ''));
            report.haul.iron = parseInt(numbers[2].replace(/\./g, ''));
            report.haul.total = parseInt(numbers[3].replace(/\./g, ''));
            report.haul.capacity = parseInt(numbers[4].replace(/\./g, ''));
            report.fullHaul = report.haul.total >= report.haul.capacity;
        } else if (numbers && numbers.length >= 3) {
            // total/capacity 없이 자원만 있는 경우
            report.haul.wood = parseInt(numbers[0].replace(/\./g, ''));
            report.haul.clay = parseInt(numbers[1].replace(/\./g, ''));
            report.haul.iron = parseInt(numbers[2].replace(/\./g, ''));
            report.haul.total = report.haul.wood + report.haul.clay + report.haul.iron;
        }
    }

    // --- 성벽 레벨 ---
    // 패턴: "Wall" 또는 "wall" 근처에 "Level X" 또는 숫자
    const wallRegex = /[Ww]all[^<]*?(?:Level|Lv\.?)\s*(\d+)/;
    const wallMatch = wallRegex.exec(html);
    if (wallMatch) {
        report.wallAfter = parseInt(wallMatch[1]);
    }

    // 성벽 데미지 패턴: Wall: Level X -> Level Y
    const wallDmgRegex = /[Ww]all[^<]*?(\d+)\s*(?:->|→|⇒)\s*(\d+)/;
    const wallDmgMatch = wallDmgRegex.exec(html);
    if (wallDmgMatch) {
        report.wallBefore = parseInt(wallDmgMatch[1]);
        report.wallAfter = parseInt(wallDmgMatch[2]);
    }

    // --- 병력 손실 ---
    // 유닛별 sent/lost 테이블 파싱은 HTML 구조에 크게 의존
    // 일단 총 손실 여부만 체크
    const lossIndicators = ['unit_icon_death', 'lost', 'casualt'];
    report.hasLosses = lossIndicators.some(ind => html.toLowerCase().includes(ind));

    // --- 타임스탬프 ---
    // 패턴: MMM DD, YYYY HH:MM:SS 또는 DD.MM.YYYY HH:MM
    const timeRegex = /(\w{3}\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)/;
    const timeMatch = timeRegex.exec(html);
    if (timeMatch) {
        report.timestamp = timeMatch[1];
    }

    return report;
}

// ============================================
// farm-db.json 업데이트
// ============================================
function updateFarmDb(reports) {
    if (!fs.existsSync(CONFIG.farmDbFile)) {
        console.log('farm-db.json이 없습니다. 스킵합니다.');
        return;
    }

    const db = JSON.parse(fs.readFileSync(CONFIG.farmDbFile, 'utf-8'));
    let updated = 0;

    for (const report of reports) {
        if (!report.target) continue;

        // farm-db에서 매칭되는 마을 찾기
        const farm = db.farms.find(f => {
            if (report.target.villageId && f.id === String(report.target.villageId)) return true;
            if (f.x === report.target.x && f.y === report.target.y) return true;
            return false;
        });

        if (!farm) continue;

        // 히스토리에 추가
        farm.history.push({
            reportId: report.id,
            date: report.timestamp || new Date().toISOString(),
            haul: report.haul.total,
            fullHaul: report.fullHaul,
            hasLosses: report.hasLosses,
        });

        // 평균 약탈량 업데이트
        const hauls = farm.history.filter(h => h.haul > 0).map(h => h.haul);
        if (hauls.length > 0) {
            farm.avgHaul = Math.round(hauls.reduce((a, b) => a + b, 0) / hauls.length);
        }

        // 손실 카운트
        farm.losses = farm.history.filter(h => h.hasLosses).length;

        // 성벽 레벨
        if (report.wallAfter !== null) {
            farm.wallLevel = report.wallAfter;
        }

        updated++;
    }

    // 리포트 데이터 기반 재분류
    reclassifyFarms(db);

    db.lastReportSync = new Date().toISOString();
    fs.writeFileSync(CONFIG.farmDbFile, JSON.stringify(db, null, 2), 'utf-8');
    console.log(`\n[저장] farm-db.json 업데이트: ${updated}개 마을 갱신`);
}

// ============================================
// 리포트 데이터 기반 재분류
// ============================================
function reclassifyFarms(db) {
    let reclassified = 0;

    for (const farm of db.farms) {
        if (farm.history.length < 2) continue; // 데이터 부족

        const oldTier = farm.tier;

        // 손실이 2회 이상 → risk로 강등
        if (farm.losses >= 2) {
            farm.tier = 'risk';
        }
        // 평균 약탈량 높고 손실 없으면 → core로 승급
        else if (farm.avgHaul >= 100 && farm.losses === 0 && farm.distance <= 15) {
            farm.tier = 'core';
        }
        // 평균 약탈량 보통, 손실 없음 → growth
        else if (farm.avgHaul >= 30 && farm.losses === 0) {
            farm.tier = 'growth';
        }

        if (farm.tier !== oldTier) {
            reclassified++;
            console.log(`  [재분류] ${farm.id} (${farm.x},${farm.y}): ${oldTier} -> ${farm.tier}`);
        }
    }

    // stats 갱신
    db.stats = {
        core: db.farms.filter(f => f.tier === 'core').length,
        growth: db.farms.filter(f => f.tier === 'growth').length,
        risk: db.farms.filter(f => f.tier === 'risk').length,
        excluded: db.stats?.excluded || 0,
    };

    if (reclassified > 0) {
        console.log(`  [재분류] ${reclassified}개 마을 등급 변경`);
    }
}

// ============================================
// 메인: 리포트 수집 + 파싱 + 업데이트
// ============================================
async function main(pagesArg) {
    const pages = pagesArg || parseInt(process.argv[2]) || 1; // 수집할 페이지 수

    console.log('========================================');
    console.log(' Tribal Wars Report Collector');
    console.log(`  ${pages} 페이지 수집 예정`);
    console.log('========================================\n');

    // Step 1: 리포트 목록에서 ID 수집
    const allReportIds = [];

    for (let p = 0; p < pages; p++) {
        console.log(`[목록] 페이지 ${p + 1}/${pages} 로딩...`);
        const listHtml = await fetchReportList(p);
        const ids = parseReportIds(listHtml);
        console.log(`  ${ids.length}개 리포트 ID 발견`);
        allReportIds.push(...ids);

        if (p < pages - 1) await sleep(CONFIG.delayMs);
    }

    // 중복 제거
    const uniqueIds = [...new Set(allReportIds)];
    console.log(`\n총 ${uniqueIds.length}개 고유 리포트\n`);

    if (uniqueIds.length === 0) {
        console.log('수집할 리포트가 없습니다.');
        return;
    }

    // Step 2: 개별 리포트 파싱
    const reports = [];

    for (let i = 0; i < uniqueIds.length; i++) {
        const rid = uniqueIds[i];
        console.log(`[리포트] [${i + 1}/${uniqueIds.length}] #${rid} 로딩...`);

        try {
            const html = await fetchReport(rid);

            // 첫 번째 리포트 HTML 디버그 저장
            if (i === 0) {
                fs.writeFileSync('./debug_report.html', html, 'utf-8');
                console.log('  [DEBUG] 원본 HTML 저장: ./debug_report.html');
            }

            const parsed = parseReport(html, rid);

            const targetStr = parsed.target
                ? `(${parsed.target.x}|${parsed.target.y})`
                : '(?)';
            const h = parsed.haul;
            let haulStr;
            if (h.total > 0) {
                const pct = h.capacity > 0 ? Math.round(h.total / h.capacity * 100) : 0;
                haulStr = `W:${h.wood} C:${h.clay} I:${h.iron} = ${h.total}/${h.capacity} (${pct}%)`;
                if (pct >= 100) haulStr += ' FULL';
            } else {
                haulStr = '약탈 없음';
            }
            const lossStr = parsed.hasLosses ? 'LOSS' : 'OK';

            console.log(`  ${parsed.type} -> ${targetStr} | ${haulStr} | ${lossStr}`);
            reports.push(parsed);
        } catch (err) {
            console.error(`  에러: ${err.message}`);
        }

        if (i < uniqueIds.length - 1) await sleep(CONFIG.delayMs);
    }

    // Step 3: 결과 저장 (원본)
    const rawFile = `./reports_${Date.now()}.json`;
    fs.writeFileSync(rawFile, JSON.stringify(reports, null, 2), 'utf-8');
    console.log(`\n[저장] 원본 리포트: ${rawFile}`);

    // Step 4: farm-db 업데이트
    const attackReports = reports.filter(r => r.type === 'attack' && r.target);
    console.log(`\n공격 리포트 ${attackReports.length}개로 farm-db 업데이트...`);
    updateFarmDb(attackReports);

    // 요약
    console.log('\n========================================');
    console.log(` 수집 완료: ${reports.length}개 리포트`);
    console.log(`  공격: ${reports.filter(r => r.type === 'attack').length}`);
    console.log(`  방어: ${reports.filter(r => r.type === 'defense').length}`);
    console.log(`  기타: ${reports.filter(r => r.type === 'other').length}`);
    const totals = reports.reduce((s, r) => ({
        wood: s.wood + r.haul.wood,
        clay: s.clay + r.haul.clay,
        iron: s.iron + r.haul.iron,
        haul: s.haul + r.haul.total,
        capacity: s.capacity + r.haul.capacity,
    }), { wood: 0, clay: 0, iron: 0, haul: 0, capacity: 0 });
    if (totals.haul > 0) {
        const avgPct = totals.capacity > 0 ? Math.round(totals.haul / totals.capacity * 100) : 0;
        console.log(`  총 약탈: W:${totals.wood} C:${totals.clay} I:${totals.iron} = ${totals.haul}/${totals.capacity} (${avgPct}%)`);
    }
    console.log('========================================');
}

// 모듈로 사용 시 export, 직접 실행 시 main()
module.exports = { main, fetchReportList, parseReportIds, fetchReport, parseReport, updateFarmDb };
if (require.main === module) main().catch(console.error);
