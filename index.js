const fs = require('fs');
const path = require('path');
const { CONFIG, buildHeaders, sleep } = require('./config');

// ============================================
// 입력 파일 파싱
// ============================================
function loadTargets(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath, 'utf-8');

    if (ext === '.json') {
        // JSON 형식: [{ "village": 26266, "target": 25554 }, ...]
        return JSON.parse(content);
    }

    if (ext === '.csv') {
        // CSV 형식: village,target (첫 줄 헤더)
        const lines = content.trim().split('\n');
        return lines.slice(1).map(line => {
            const [village, target] = line.split(',').map(s => s.trim());
            return { village: Number(village), target: Number(target) };
        });
    }

    throw new Error(`지원하지 않는 파일 형식: ${ext} (.json 또는 .csv만 가능)`);
}

// ============================================
// API 요청
// ============================================
async function fetchCommand(village, target) {
    const url = `${CONFIG.baseUrl}?village=${village}&screen=place&ajax=command&target=${target}`;

    const res = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(),
    });

    const status = res.status;
    let body;
    try {
        body = await res.json();
    } catch {
        body = await res.text();
    }

    return { status, body };
}

// ============================================
// 메인 실행
// ============================================
async function main() {
    console.log('========================================');
    console.log(' Tribal Wars Bulk Requester');
    console.log('========================================\n');

    // 입력 파일 로드
    const targets = loadTargets(CONFIG.inputFile);
    console.log(`${targets.length}개 요청 로드됨 (${CONFIG.inputFile})\n`);

    const results = [];

    for (let i = 0; i < targets.length; i++) {
        const { village, target } = targets[i];
        const label = `[${i + 1}/${targets.length}] village=${village}, target=${target}`;

        try {
            const { status, body } = await fetchCommand(village, target);
            console.log(`${label} -> ${status}`);
            console.log(JSON.stringify(body, null, 2));
            console.log('---');
            results.push({ village, target, status, success: true, body });
        } catch (err) {
            console.error(`${label} -> ERROR: ${err.message}`);
            results.push({ village, target, status: null, success: false, error: err.message });
        }

        // 마지막 요청이 아니면 딜레이
        if (i < targets.length - 1) {
            await sleep(CONFIG.commandDelayMs);
        }
    }

    // 결과 저장
    const outFile = `./results_${Date.now()}.json`;
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf-8');

    console.log('\n========================================');
    console.log(`성공: ${results.filter(r => r.success).length}`);
    console.log(`실패: ${results.filter(r => !r.success).length}`);
    console.log(`결과 저장: ${outFile}`);
    console.log('========================================');
}

main().catch(console.error);
