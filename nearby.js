const fs = require('fs');
const { CONFIG, sleep, distance } = require('./config');

// 맵 청크의 시작 좌표 계산 (20x20 그리드 단위로 정렬)
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

async function main() {
    const { myX, myY, searchRadius } = CONFIG;
    console.log(`========================================`);
    console.log(` Nearby Village Finder`);
    console.log(` 내 마을: (${myX}, ${myY})`);
    console.log(` 탐색 반경: ${searchRadius}칸`);
    console.log(`========================================\n`);

    const chunks = getChunkOrigins(myX, myY, searchRadius);
    console.log(`맵 청크 ${chunks.length}개 요청 중...\n`);

    const allVillages = [];

    for (let i = 0; i < chunks.length; i++) {
        const { x: ox, y: oy } = chunks[i];
        try {
            const jsonArr = await fetchMapChunk(ox, oy);
            const data = jsonArr[0]?.data;
            if (!data) {
                console.log(`  [${i + 1}/${chunks.length}] (${ox},${oy}) — 데이터 없음`);
                continue;
            }

            const { villages, players, allies } = data;
            let count = 0;

            // villages[row][col] = ["id", type, ?, "points", "player_id", ?, ...]
            for (let row = 0; row < 20; row++) {
                const rowData = villages[row];
                if (!rowData) continue;
                for (const col of Object.keys(rowData)) {
                    const v = rowData[col];
                    const vx = ox + row;
                    const vy = oy + parseInt(col);
                    const dist = distance(myX, myY, vx, vy);

                    if (dist <= searchRadius) {
                        const villageId = v[0];
                        const points = v[3];
                        const playerId = v[4];
                        const bonusId = v[6];
                        const villageType = v[10];

                        // 플레이어 정보
                        let playerName = '야만인 마을';
                        let allyName = '';
                        if (playerId && playerId !== '0' && players && players[playerId]) {
                            const p = players[playerId];
                            playerName = p[0];
                            const allyId = p[2];
                            if (allyId && allyId !== '0' && allies && allies[allyId]) {
                                allyName = allies[allyId][2]; // 부족 약칭
                            }
                        }

                        allVillages.push({
                            id: villageId,
                            x: vx,
                            y: vy,
                            distance: Math.round(dist * 100) / 100,
                            points: parseInt(points) || 0,
                            playerId,
                            playerName,
                            ally: allyName,
                            bonus: bonusId,
                            type: villageType,
                        });
                        count++;
                    }
                }
            }
            console.log(`  [${i + 1}/${chunks.length}] (${ox},${oy}) — ${count}개 마을 발견`);
        } catch (err) {
            console.error(`  [${i + 1}/${chunks.length}] (${ox},${oy}) — 에러: ${err.message}`);
        }

        if (i < chunks.length - 1) await sleep(CONFIG.delayMs);
    }

    // 거리순 정렬
    allVillages.sort((a, b) => a.distance - b.distance);

    // 중복 제거 (같은 village id)
    const seen = new Set();
    const unique = allVillages.filter(v => {
        if (seen.has(v.id)) return false;
        seen.add(v.id);
        return true;
    });

    // 콘솔 출력
    console.log(`\n========================================`);
    console.log(` 총 ${unique.length}개 마을 (반경 ${searchRadius}칸)`);
    console.log(`========================================\n`);

    console.log('거리 | 좌표       | ID    | 포인트 | 소유자          | 부족');
    console.log('-----|------------|-------|--------|-----------------|------');
    for (const v of unique) {
        const coord = `(${v.x},${v.y})`.padEnd(10);
        const id = String(v.id).padEnd(5);
        const pts = String(v.points).padEnd(6);
        const dist = v.distance.toFixed(1).padStart(4);
        const owner = v.playerName.slice(0, 15).padEnd(15);
        const ally = v.ally || '-';
        console.log(`${dist} | ${coord} | ${id} | ${pts} | ${owner} | ${ally}`);
    }

    // 결과 저장
    const outFile = `./nearby_villages.json`;
    fs.writeFileSync(outFile, JSON.stringify(unique, null, 2), 'utf-8');
    console.log(`\n결과 저장: ${outFile}`);
}

main().catch(console.error);
