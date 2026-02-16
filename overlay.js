// ============================================
// 공격 감시 대시보드 오버레이 v3
// ============================================
(function () {
    'use strict';
    if (document.getElementById('bujok-overlay')) return;

    var API_BASE = 'http://localhost:3001';
    var POLL_MS = 10000;

    var attacks = [];
    var lastCheck = null;
    var connStatus = 'connecting';
    var minimized = false;

    // ============================================
    // 유닛 아이콘 SVG
    // ============================================
    function mkIcon(paths, color) {
        var inner = paths.replace(/__C__/g, color);
        return '<svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">' + inner + '</svg>';
    }
    function mkIconSm(paths, color) {
        var inner = paths.replace(/__C__/g, color);
        return '<svg viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg">' + inner + '</svg>';
    }

    var SVG_PATHS = {
        spy:       '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" fill="none" stroke="__C__" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="__C__"/>',
        light:     '<path d="M13 2L3 14h9l-1 8 10-12h-9z" fill="__C__"/>',
        heavy:     '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="__C__" stroke-width="2"/>',
        axe_spear: '<line x1="8" y1="2" x2="8" y2="22" stroke="__C__" stroke-width="2.5" stroke-linecap="round"/><path d="M8 4c5 0 8 3 8 5s-3 5-8 5" fill="__C__" opacity="0.8"/>',
        sword:     '<line x1="5" y1="20" x2="19" y2="4" stroke="__C__" stroke-width="2.5" stroke-linecap="round"/><line x1="9" y1="11" x2="15" y2="13" stroke="__C__" stroke-width="2.5" stroke-linecap="round"/>',
        ram:       '<rect x="1" y="9" width="17" height="6" rx="3" fill="__C__" opacity="0.8"/><polygon points="18,9 23,12 18,15" fill="__C__"/>',
        snob:      '<path d="M4 17h16l-2-8-3 4-3-8-3 8-3-4z" fill="__C__"/><rect x="4" y="17" width="16" height="3" rx="1" fill="__C__" opacity="0.7"/>',
    };

    var UNIT = {
        spy:       { color: '#8e44ad', label: '\uC815\uCC30',   svg: function(c){return mkIcon(SVG_PATHS.spy,c)},       svgSm: function(c){return mkIconSm(SVG_PATHS.spy,c)} },
        light:     { color: '#f39c12', label: '\uACBD\uAE30\uBCD1',  svg: function(c){return mkIcon(SVG_PATHS.light,c)},     svgSm: function(c){return mkIconSm(SVG_PATHS.light,c)} },
        heavy:     { color: '#e67e22', label: '\uC911\uAE30\uBCD1',  svg: function(c){return mkIcon(SVG_PATHS.heavy,c)},     svgSm: function(c){return mkIconSm(SVG_PATHS.heavy,c)} },
        axe_spear: { color: '#e74c3c', label: '\uB3C4\uB07C/\uCC3D', svg: function(c){return mkIcon(SVG_PATHS.axe_spear,c)}, svgSm: function(c){return mkIconSm(SVG_PATHS.axe_spear,c)} },
        sword:     { color: '#c0392b', label: '\uAC80\uBCD1',    svg: function(c){return mkIcon(SVG_PATHS.sword,c)},     svgSm: function(c){return mkIconSm(SVG_PATHS.sword,c)} },
        ram:       { color: '#7f8c8d', label: '\uACF5\uC131',    svg: function(c){return mkIcon(SVG_PATHS.ram,c)},       svgSm: function(c){return mkIconSm(SVG_PATHS.ram,c)} },
        snob:      { color: '#f1c40f', label: '\uADC0\uC871',    svg: function(c){return mkIcon(SVG_PATHS.snob,c)},      svgSm: function(c){return mkIconSm(SVG_PATHS.snob,c)} },
    };
    var UNKNOWN = { color: '#95a5a6', label: '\uBBF8\uC0C1',
        svg: function(c){return mkIcon('<circle cx="12" cy="12" r="9" fill="none" stroke="__C__" stroke-width="2"/><text x="12" y="16" text-anchor="middle" fill="__C__" font-size="12" font-weight="bold">?</text>',c)},
        svgSm: function(c){return mkIconSm('<circle cx="12" cy="12" r="9" fill="none" stroke="__C__" stroke-width="2"/><text x="12" y="16" text-anchor="middle" fill="__C__" font-size="12" font-weight="bold">?</text>',c)}
    };

    function getUnit(type) { return UNIT[type] || UNKNOWN; }

    var BASE_SPEED = { spy: 9, light: 10, heavy: 11, axe: 18, spear: 18, sword: 22, ram: 30, catapult: 30, snob: 35 };

    function unitTimesText(dist) {
        if (!dist || dist <= 0) return '';
        var lines = [];
        var show = ['spy','light','heavy','axe','sword','ram','snob'];
        var labels = {spy:'\uC815\uCC30',light:'\uACBD\uAE30',heavy:'\uC911\uAE30',axe:'\uB3C4\uB07C',sword:'\uAC80\uBCD1',ram:'\uACF5\uC131',snob:'\uADC0\uC871'};
        for (var i = 0; i < show.length; i++) {
            var u = show[i];
            var mins = BASE_SPEED[u] * dist;
            var h = Math.floor(mins / 60);
            var m = Math.floor(mins % 60);
            var s = Math.floor((mins * 60) % 60);
            lines.push(labels[u] + ': ' + (h > 0 ? h + ':' : '') + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0'));
        }
        return lines.join(' | ');
    }

    // ============================================
    // CSS
    // ============================================
    var css = document.createElement('style');
    css.id = 'bujok-overlay-css';
    css.textContent = [
'#bujok-overlay{position:fixed;top:10px;right:10px;width:440px;max-height:85vh;background:rgba(18,22,30,.96);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#ddd;font-family:"Segoe UI",-apple-system,sans-serif;font-size:12.5px;line-height:1.4;z-index:999999;box-shadow:0 8px 40px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden;transition:width .2s,max-height .2s}',
'#bujok-overlay.minimized{max-height:42px;width:260px}',
'.bj-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(25,30,42,.98);border-bottom:1px solid rgba(255,255,255,.06);cursor:grab;user-select:none;flex-shrink:0}',
'.bj-hdr:active{cursor:grabbing}',
'.bj-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}',
'.bj-dot.connected{background:#2ecc71;box-shadow:0 0 6px #2ecc71}',
'.bj-dot.connecting{background:#f39c12;animation:bjp 1s infinite}',
'.bj-dot.error{background:#e74c3c}',
'@keyframes bjp{0%,100%{opacity:1}50%{opacity:.4}}',
'.bj-ttl{font-weight:600;font-size:13px;color:#fff;flex-grow:1}',
'.bj-cnt{background:#e74c3c;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600;min-width:18px;text-align:center}',
'.bj-cnt.z{background:#2c3e50;color:#7f8c8d}',
'.bj-lc{color:#666;font-size:11px}',
'.bj-btn{background:0 0;border:none;color:#888;cursor:pointer;font-size:16px;padding:0 4px;line-height:1}',
'.bj-btn:hover{color:#fff}',
'.bj-train{padding:6px 12px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;flex-shrink:0}',
'.bj-train.cf{background:rgba(231,76,60,.25);border-bottom:1px solid rgba(231,76,60,.3);color:#e74c3c}',
'.bj-train.sp{background:rgba(243,156,18,.2);border-bottom:1px solid rgba(243,156,18,.3);color:#f39c12}',
'.bj-body{overflow-y:auto;flex:1;min-height:0}',
'.bj-body::-webkit-scrollbar{width:5px}',
'.bj-body::-webkit-scrollbar-track{background:0 0}',
'.bj-body::-webkit-scrollbar-thumb{background:#444;border-radius:3px}',
'.bj-empty{padding:30px;text-align:center;color:#555;font-size:14px}',
'.bj-row{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.04);transition:background .15s}',
'.bj-row:hover{background:rgba(255,255,255,.03)}',
'.bj-row.urgent{background:rgba(231,76,60,.08)}',
'.bj-row.urgent .bj-cd{color:#e74c3c;font-weight:700}',
'.bj-ico{flex-shrink:0;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:rgba(255,255,255,.06)}',
'.bj-info{flex:1;min-width:0}',
'.bj-info-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
'.bj-tl{font-weight:600;font-size:12px}',
'.bj-tag{font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600}',
'.bj-tag.cf{background:rgba(231,76,60,.3);color:#e74c3c}',
'.bj-tag.sp{background:rgba(243,156,18,.25);color:#f39c12}',
'.bj-coords{color:#888;font-size:11px;margin-top:2px}',
'.bj-coords span{color:#aaa}',
'.bj-tc{text-align:right;flex-shrink:0}',
'.bj-cd{font-size:14px;font-weight:600;color:#3498db;font-variant-numeric:tabular-nums}',
'.bj-arr{font-size:10px;color:#666;margin-top:1px}',
'.bj-meta{color:#666;font-size:10px}',
'.bj-cmd-badge{display:inline-flex;align-items:center;gap:3px;margin-left:6px;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600;vertical-align:middle;white-space:nowrap}',
'.bj-cmd-badge svg{vertical-align:middle}',
'.bj-cmd-loading{color:#888;font-size:10px;margin-left:6px}',
    ].join('\n');
    document.head.appendChild(css);

    // ============================================
    // DOM
    // ============================================
    var el = document.createElement('div');
    el.id = 'bujok-overlay';
    el.innerHTML =
        '<div class="bj-hdr" id="bj-drag">' +
            '<div class="bj-dot connecting" id="bj-dot"></div>' +
            '<span class="bj-ttl">\u2694\uFE0F \uACF5\uACA9 \uAC10\uC2DC</span>' +
            '<span class="bj-cnt z" id="bj-cnt">0</span>' +
            '<span class="bj-lc" id="bj-lc"></span>' +
            '<button class="bj-btn" id="bj-min" title="\uCD5C\uC18C\uD654">\u2500</button>' +
            '<button class="bj-btn" id="bj-cls" title="\uB2EB\uAE30">\u2715</button>' +
        '</div>' +
        '<div id="bj-trains"></div>' +
        '<div class="bj-body" id="bj-body"><div class="bj-empty">\uC5F0\uACB0 \uC911...</div></div>';
    document.body.appendChild(el);

    // ============================================
    // 드래그
    // ============================================
    var drag = false, ddx, ddy;
    document.getElementById('bj-drag').addEventListener('mousedown', function (e) {
        if (e.target.tagName === 'BUTTON') return;
        drag = true; ddx = e.clientX - el.offsetLeft; ddy = e.clientY - el.offsetTop;
    });
    document.addEventListener('mousemove', function (e) {
        if (!drag) return;
        el.style.left = (e.clientX - ddx) + 'px'; el.style.top = (e.clientY - ddy) + 'px'; el.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { drag = false; });

    document.getElementById('bj-min').addEventListener('click', function () {
        minimized = !minimized; el.classList.toggle('minimized', minimized);
        this.textContent = minimized ? '\u25A1' : '\u2500';
    });
    document.getElementById('bj-cls').addEventListener('click', function () {
        el.remove(); css.remove(); clearInterval(pollTimer); clearInterval(cdTimer);
    });

    // ============================================
    // 시간 헬퍼
    // ============================================
    function fmtCd(ms) {
        if (ms <= 0) return '\uB3C4\uCC29!';
        var h = Math.floor(ms / 3600000);
        var m = Math.floor((ms % 3600000) / 60000);
        var s = Math.floor((ms % 60000) / 1000);
        if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        return m + ':' + String(s).padStart(2, '0');
    }
    function fmtTime(iso) {
        if (!iso) return '';
        return new Date(iso).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // ============================================
    // 귀족열차 감지
    // ============================================
    function detectTrains(atks) {
        var groups = {};
        atks.forEach(function (a) {
            if (!a.originX || !a.targetX) return;
            var k = a.originX + '|' + a.originY + '->' + a.targetX + '|' + a.targetY;
            if (!groups[k]) groups[k] = [];
            groups[k].push(a);
        });
        var trains = [];
        Object.keys(groups).forEach(function (k) {
            var g = groups[k];
            if (g.length < 2) return;
            g.sort(function (a, b) { return new Date(a.arrivalTime) - new Date(b.arrivalTime); });
            for (var i = 1; i < g.length; i++) {
                if (new Date(g[i].arrivalTime) - new Date(g[i - 1].arrivalTime) > 120000) return;
            }
            var hasSnob = g.some(function (a) { return a.attackType === 'snob'; });
            var parts = k.split('->');
            trains.push({ origin: parts[0], target: parts[1], count: g.length, confirmed: hasSnob,
                label: hasSnob ? '\uADC0\uC871\uC5F4\uCC28 \uD655\uC815!' : '\uADC0\uC871\uC5F4\uCC28 \uC758\uC2EC!' });
        });
        return trains;
    }

    // ============================================
    // 수신 공격 폴링
    // ============================================
    function fetchData() {
        fetch(API_BASE + '/api/attacks').then(function (r) { return r.json(); }).then(function (data) {
            var now = Date.now();
            attacks = (data.attacks || [])
                .filter(function (a) { return a.arrivalTime && new Date(a.arrivalTime).getTime() > now; })
                .sort(function (a, b) { return new Date(a.arrivalTime) - new Date(b.arrivalTime); });
            lastCheck = data.lastCheck;
            connStatus = 'connected';
            render();
        }).catch(function () { connStatus = 'error'; render(); });
    }

    // ============================================
    // 수신 공격 렌더링
    // ============================================
    function render() {
        document.getElementById('bj-dot').className = 'bj-dot ' + connStatus;
        var cntEl = document.getElementById('bj-cnt');
        cntEl.textContent = attacks.length;
        cntEl.className = 'bj-cnt' + (attacks.length === 0 ? ' z' : '');
        document.getElementById('bj-lc').textContent = lastCheck ? fmtTime(lastCheck) : '';

        var trains = detectTrains(attacks);
        document.getElementById('bj-trains').innerHTML = trains.map(function (t) {
            var cls = t.confirmed ? 'cf' : 'sp';
            return '<div class="bj-train ' + cls + '">\uD83D\uDC51 ' + t.label +
                ' \u2014 ' + t.origin + ' \u2192 ' + t.target + ' (' + t.count + '\uC5F0\uD0C0)</div>';
        }).join('');

        var body = document.getElementById('bj-body');
        if (attacks.length === 0) {
            body.innerHTML = connStatus === 'error'
                ? '<div class="bj-empty">\uC5F0\uACB0 \uC2E4\uD328 \u2014 watcher.js \uC2E4\uD589 \uD655\uC778</div>'
                : '<div class="bj-empty">\uC218\uC2E0 \uACF5\uACA9 \uC5C6\uC74C</div>';
            return;
        }

        var now = Date.now();
        body.innerHTML = attacks.map(function (atk) {
            var u = getUnit(atk.attackType);
            var arrMs = new Date(atk.arrivalTime).getTime();
            var rem = arrMs - now;
            var urgent = rem > 0 && rem < 300000;
            var trainTag = '';
            if (atk.nobleTrain) {
                var tc = atk.nobleTrain.indexOf('\uD655\uC815') >= 0 ? 'cf' : 'sp';
                trainTag = '<span class="bj-tag ' + tc + '">' + atk.nobleTrain + '</span>';
            }
            var distNum = atk.distance || 0;
            var metaParts = [];
            if (distNum) metaParts.push(distNum + '\uCE78');
            if (atk.speed) metaParts.push(atk.speed.toFixed(1) + 'min/f');
            var metaHtml = metaParts.length ? '<span class="bj-meta">' + metaParts.join(' | ') + '</span>' : '';
            var tooltip = distNum ? unitTimesText(distNum) : '';

            return '<div class="bj-row' + (urgent ? ' urgent' : '') + '" data-arr="' + arrMs + '" title="' + tooltip + '">' +
                '<div class="bj-ico">' + u.svg(u.color) + '</div>' +
                '<div class="bj-info">' +
                    '<div class="bj-info-top">' +
                        '<span class="bj-tl" style="color:' + u.color + '">' + u.label + '</span>' +
                        trainTag + metaHtml +
                    '</div>' +
                    '<div class="bj-coords">' +
                        '<span>(' + (atk.originX || '?') + '|' + (atk.originY || '?') + ')</span>' +
                        ' \u2192 <span>(' + (atk.targetX || '?') + '|' + (atk.targetY || '?') + ')</span>' +
                    '</div>' +
                '</div>' +
                '<div class="bj-tc">' +
                    '<div class="bj-cd">' + fmtCd(rem) + '</div>' +
                    '<div class="bj-arr">' + fmtTime(atk.arrivalTime) + '</div>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    // ============================================
    // 카운트다운
    // ============================================
    function updateCd() {
        var now = Date.now();
        var rows = document.querySelectorAll('#bujok-overlay .bj-row');
        for (var i = 0; i < rows.length; i++) {
            var arrMs = parseInt(rows[i].dataset.arr);
            if (!arrMs) continue;
            var rem = arrMs - now;
            var cdEl = rows[i].querySelector('.bj-cd');
            if (cdEl) cdEl.textContent = fmtCd(rem);
            if (rem > 0 && rem < 300000) rows[i].classList.add('urgent');
            else rows[i].classList.remove('urgent');
        }
    }

    // ============================================
    //  커맨드 병종 판별 — 완전히 새로 작성
    // ============================================

    var cmdCache = {};

    var UNIT_KR = {
        spear: '\uCC3D\uBCD1', sword: '\uAC80\uBCD1', axe: '\uB3C4\uB07C', spy: '\uC815\uCC30',
        light: '\uACBD\uAE30', heavy: '\uC911\uAE30', ram: '\uD30C\uC131\uCD94', catapult: '\uD22C\uC11D\uAE30',
        snob: '\uADC0\uC871', knight: '\uAE30\uC0AC', archer: '\uAD81\uBCD1', marcher: '\uB9C8\uAD81'
    };

    // 이미지 src에서 유닛 이름 추출 (다양한 패턴 대응)
    // unit_snob.png, unit/snob.png, unit_nobleman.png 등
    function extractUnitFromSrc(src) {
        if (!src) return null;
        var patterns = [
            /unit_?(spear)/i, /unit_?(sword)/i, /unit_?(axe)/i,
            /unit_?(archer)/i, /unit_?(spy)/i, /unit_?(light)/i,
            /unit_?(marcher|mounted_archer)/i, /unit_?(heavy)/i,
            /unit_?(ram)/i, /unit_?(catapult)/i, /unit_?(knight)/i,
            /unit_?(snob|nobleman)/i
        ];
        var nameMap = { mounted_archer: 'marcher', nobleman: 'snob' };
        for (var i = 0; i < patterns.length; i++) {
            var m = patterns[i].exec(src);
            if (m) {
                var name = m[1].toLowerCase();
                return nameMap[name] || name;
            }
        }
        return null;
    }

    // 속도 -> 가장 가까운 기본 속도에 매칭
    function classifyBySpeed(speed) {
        var units = [
            { speed: 9,  type: 'spy' },
            { speed: 10, type: 'light' },
            { speed: 11, type: 'heavy' },
            { speed: 18, type: 'axe_spear' },
            { speed: 22, type: 'sword' },
            { speed: 30, type: 'ram' },
            { speed: 35, type: 'snob' },
        ];
        var best = 'snob', bestDiff = Infinity;
        for (var i = 0; i < units.length; i++) {
            var diff = Math.abs(speed - units[i].speed);
            if (diff < bestDiff) { bestDiff = diff; best = units[i].type; }
        }
        return best;
    }

    // 병력 구성 -> 대표 유형 (가장 느린 유닛 = 공격 유형)
    function classifyByTroops(troops) {
        if (!troops || Object.keys(troops).length === 0) return null;
        var total = 0;
        var keys = Object.keys(troops);
        for (var i = 0; i < keys.length; i++) total += troops[keys[i]] || 0;
        if (total === 0) return null;

        // 가장 느린 유닛이 공격 속도를 결정
        var slowest = 0;
        var slowestUnit = null;
        var speedMap = { spy: 9, light: 10, heavy: 11, archer: 10,
                         marcher: 10, axe: 18, spear: 18, sword: 22,
                         ram: 30, catapult: 30, knight: 10, snob: 35 };
        for (var j = 0; j < keys.length; j++) {
            var u = keys[j];
            if ((troops[u] || 0) > 0 && speedMap[u] && speedMap[u] > slowest) {
                slowest = speedMap[u];
                slowestUnit = u;
            }
        }
        if (!slowestUnit) return null;

        // 유닛 -> 공격 유형 매핑
        if (slowestUnit === 'snob') return 'snob';
        if (slowestUnit === 'ram' || slowestUnit === 'catapult') return 'ram';
        if (slowestUnit === 'sword') return 'sword';
        if (slowestUnit === 'axe' || slowestUnit === 'spear') return 'axe_spear';
        if (slowestUnit === 'heavy') return 'heavy';
        if (slowestUnit === 'light' || slowestUnit === 'marcher' ||
            slowestUnit === 'archer' || slowestUnit === 'knight') return 'light';
        if (slowestUnit === 'spy') return 'spy';
        return null;
    }

    function troopSummary(troops) {
        if (!troops) return '';
        var parts = [];
        var order = ['light','heavy','axe','spear','sword','spy','ram','catapult','snob','knight','archer','marcher'];
        for (var i = 0; i < order.length; i++) {
            var u = order[i];
            if (troops[u] && troops[u] > 0) parts.push((UNIT_KR[u]||u) + ' ' + troops[u]);
        }
        return parts.join(', ');
    }

    // ============================================
    // 커맨드 상세 파싱 — 3단계 판별
    // ============================================
    function parseCommandDetail(html) {
        var result = { type: null, summary: '', dist: 0, speed: 0, method: '' };

        var doc = new DOMParser().parseFromString(html, 'text/html');

        // ── 좌표 & 거리 ──
        var coords = [];
        var cre = /\((\d{3})\|(\d{3})\)/g, m;
        while ((m = cre.exec(html)) !== null) coords.push({ x: parseInt(m[1]), y: parseInt(m[2]) });
        if (coords.length >= 2) {
            var ox = coords[0].x, oy = coords[0].y;
            var tx = coords[1].x, ty = coords[1].y;
            result.dist = Math.sqrt((ox-tx)*(ox-tx) + (oy-ty)*(oy-ty));
        }

        // ================================================================
        // 전략 1: 모든 유닛 이미지를 찾아서 같은 테이블의 데이터 추출
        // ================================================================
        var troops = null;

        var allImgs = doc.querySelectorAll('img');
        // 유닛 이미지가 포함된 테이블 찾기
        for (var ii = 0; ii < allImgs.length; ii++) {
            var unitName = extractUnitFromSrc(allImgs[ii].getAttribute('src'));
            if (!unitName) continue;
            // 이 이미지가 속한 테이블 찾기
            var table = allImgs[ii].closest('table');
            if (!table) continue;
            // 이 테이블에서 모든 유닛 이미지 매핑
            var headerRow = allImgs[ii].closest('tr');
            if (!headerRow) continue;
            var headerCells = headerRow.querySelectorAll('th, td');
            var unitCols = {};
            for (var hci = 0; hci < headerCells.length; hci++) {
                var imgs = headerCells[hci].querySelectorAll('img');
                for (var imi = 0; imi < imgs.length; imi++) {
                    var un = extractUnitFromSrc(imgs[imi].getAttribute('src'));
                    if (un) { unitCols[hci] = un; break; }
                }
            }
            if (Object.keys(unitCols).length < 2) continue;

            // 헤더 행 다음의 모든 행에서 데이터 추출 시도
            var allRows = table.querySelectorAll('tr');
            var headerIdx = -1;
            for (var ri = 0; ri < allRows.length; ri++) {
                if (allRows[ri] === headerRow) { headerIdx = ri; break; }
            }
            if (headerIdx < 0) continue;

            for (var di = headerIdx + 1; di < allRows.length; di++) {
                var cells = allRows[di].querySelectorAll('td');
                var tempTroops = {};
                var hasPositive = false;
                var colKeys = Object.keys(unitCols);
                for (var ci = 0; ci < colKeys.length; ci++) {
                    var colIdx = parseInt(colKeys[ci]);
                    if (cells[colIdx]) {
                        var val = parseInt(cells[colIdx].textContent.trim());
                        if (!isNaN(val)) {
                            tempTroops[unitCols[colIdx]] = val;
                            if (val > 0) hasPositive = true;
                        }
                    }
                }
                if (hasPositive) {
                    troops = tempTroops;
                    break;
                }
            }
            if (troops) break;
        }

        if (troops) {
            var troopType = classifyByTroops(troops);
            result.summary = troopSummary(troops);
            if (result.dist > 0) result.summary += ' | ' + result.dist.toFixed(1) + '\uCE78';
            if (troopType) {
                result.type = troopType;
                result.method = 'troops';
                console.log('[Bujok] \uBCD1\uB825 \uD30C\uC2F1 \uC131\uACF5:', troops, '->', troopType);
                return result;
            }
        }

        // ================================================================
        // 전략 2: HTML에서 유닛 이미지+숫자 패턴을 직접 regex로 추출
        // ================================================================
        if (!troops || Object.keys(troops || {}).length === 0) {
            var regTroops = {};
            var unitRe = /unit_?(spear|sword|axe|archer|spy|light|marcher|mounted_archer|heavy|ram|catapult|knight|snob|nobleman)[^"]*"[^>]*>[\s\S]*?<\/(?:th|td)>\s*(?:<(?:th|td)[^>]*>\s*(\d+)\s*<\/(?:th|td)>)?/gi;
            // 더 단순한 패턴: 이미지 근처의 숫자
            var simpleRe = /unit_?(spear|sword|axe|archer|spy|light|marcher|mounted_archer|heavy|ram|catapult|knight|snob|nobleman)/gi;
            var unitMatches = [];
            var sm;
            while ((sm = simpleRe.exec(html)) !== null) {
                unitMatches.push({ unit: sm[1].toLowerCase(), pos: sm.index });
            }
            // 각 유닛 이미지 위치 뒤에서 가장 가까운 숫자 찾기
            if (unitMatches.length >= 2) {
                var nameMap2 = { mounted_archer: 'marcher', nobleman: 'snob' };
                for (var ui = 0; ui < unitMatches.length; ui++) {
                    var uname = nameMap2[unitMatches[ui].unit] || unitMatches[ui].unit;
                    if (regTroops[uname] !== undefined) continue; // 첫 번째만
                    // 이미지 위치 +50~200자 내에서 숫자 찾기
                    var searchStart = unitMatches[ui].pos;
                    var searchEnd = Math.min(searchStart + 300, html.length);
                    var snippet = html.substring(searchStart, searchEnd);
                    var numMatch = snippet.match(/>(\d+)</);
                    if (numMatch) {
                        regTroops[uname] = parseInt(numMatch[1]);
                    }
                }
                if (Object.keys(regTroops).length >= 2) {
                    var hasAnyPositive = false;
                    var rk = Object.keys(regTroops);
                    for (var rki = 0; rki < rk.length; rki++) {
                        if (regTroops[rk[rki]] > 0) hasAnyPositive = true;
                    }
                    if (hasAnyPositive) {
                        var rt = classifyByTroops(regTroops);
                        result.summary = troopSummary(regTroops);
                        if (result.dist > 0) result.summary += ' | ' + result.dist.toFixed(1) + '\uCE78';
                        if (rt) {
                            result.type = rt;
                            result.method = 'regex';
                            console.log('[Bujok] regex \uBCD1\uB825 \uD30C\uC2F1:', regTroops, '->', rt);
                            return result;
                        }
                    }
                }
            }
        }

        // ================================================================
        // 전략 3: 좌표+시간 기반 속도 판별 (최후 수단)
        // ================================================================
        var endtimes = [];
        var re2 = /data-endtime="(\d+)"/g;
        while ((m = re2.exec(html)) !== null) endtimes.push(parseInt(m[1]) * 1000);

        if (endtimes.length >= 2 && result.dist > 0) {
            endtimes.sort(function(a,b){ return a-b; });
            var travelMs = endtimes[1] - endtimes[0];
            if (travelMs > 0) {
                result.speed = travelMs / 60000 / result.dist;
                result.type = classifyBySpeed(result.speed);
                result.method = 'speed';
                result.summary = result.speed.toFixed(1) + ' min/f, ' + result.dist.toFixed(1) + '\uCE78';
                console.log('[Bujok] \uC18D\uB3C4 \uAE30\uBC18:', result.speed.toFixed(1), 'min/f ->', result.type);
            }
        }

        if (!result.type) {
            console.log('[Bujok] \uD310\uBCC4 \uC2E4\uD328 - endtimes:', endtimes.length, 'dist:', result.dist.toFixed(1),
                         'troops found:', troops ? Object.keys(troops).length : 0);
        }

        return result;
    }

    // 커맨드 상세 fetch
    function fetchCommandDetail(link) {
        var href = link.href || link.getAttribute('href');
        if (href.indexOf('http') !== 0) href = window.location.origin + '/' + href.replace(/^\//, '');
        return fetch(href, { credentials: 'same-origin' })
            .then(function(r) { return r.text(); })
            .then(function(html) { return parseCommandDetail(html); });
    }

    // 뱃지 주입 (판별 방법도 표시)
    function injectCmdBadge(row, type, summary, method) {
        var u = getUnit(type);
        var badge = document.createElement('span');
        badge.className = 'bj-cmd-badge';
        badge.style.cssText = 'background:' + u.color + '22;color:' + u.color + ';border:1px solid ' + u.color + '44;';
        var methodTag = method === 'troops' ? '' : (method === 'regex' ? ' ~' : ' ?');
        badge.innerHTML = u.svgSm(u.color) + ' ' + u.label + methodTag;
        badge.title = (summary || u.label) + (method ? ' [' + method + ']' : '');
        var lastCell = row.querySelector('td:last-child');
        if (lastCell) lastCell.appendChild(badge);
    }

    // 커맨드 테이블 스캔
    function enrichCommands() {
        var links = document.querySelectorAll('a[href*="info_command"]');
        if (links.length === 0) return;
        var queue = [];
        for (var i = 0; i < links.length; i++) {
            var link = links[i];
            var href = link.href || link.getAttribute('href') || '';
            var match = /id=(\d+)/.exec(href);
            if (!match) continue;
            var cmdId = match[1];
            var row = link.closest('tr');
            if (!row || row.dataset.bjCmd) continue;
            row.dataset.bjCmd = '1';
            if (cmdCache[cmdId]) {
                if (cmdCache[cmdId].type) injectCmdBadge(row, cmdCache[cmdId].type, cmdCache[cmdId].summary, cmdCache[cmdId].method);
            } else {
                var loading = document.createElement('span');
                loading.className = 'bj-cmd-loading';
                loading.textContent = ' \u2022\u2022\u2022';
                var lc = row.querySelector('td:last-child');
                if (lc) lc.appendChild(loading);
                queue.push({ cmdId: cmdId, link: link, row: row, loading: loading });
            }
        }
        if (queue.length > 0) processQueue(queue);
    }

    var PARALLEL = 2; // 동시 요청 수 (429 방지)

    function processQueue(queue) {
        var idx = 0;
        function processItem(item) {
            return fetchCommandDetail(item.link)
                .then(function(result) {
                    cmdCache[item.cmdId] = result;
                    if (item.loading && item.loading.parentNode) item.loading.remove();
                    if (result.type) injectCmdBadge(item.row, result.type, result.summary, result.method);
                })
                .catch(function(e) {
                    console.log('[Bujok] fetch 실패:', e);
                    if (item.loading && item.loading.parentNode) item.loading.textContent = '';
                });
        }
        function nextBatch() {
            if (idx >= queue.length) return;
            var batch = queue.slice(idx, idx + PARALLEL);
            idx += batch.length;
            Promise.all(batch.map(processItem)).then(function() {
                // 2~4초 랜덤 딜레이 후 다음 배치
                if (idx < queue.length) {
                    var delay = 2000 + Math.random() * 2000;
                    setTimeout(nextBatch, delay);
                }
            });
        }
        nextBatch();
    }

    // ============================================
    // 시작
    // ============================================
    fetchData();
    var pollTimer = setInterval(fetchData, POLL_MS);
    var cdTimer = setInterval(updateCd, 1000);
    // enrichCommands(); // 내 공격 판별 비활성화 (429 방지 — incoming만 watcher로 처리)
    console.log('[Bujok] \uC624\uBC84\uB808\uC774 v3 \uCD08\uAE30\uD654 \uC644\uB8CC (incoming only)');
})();
