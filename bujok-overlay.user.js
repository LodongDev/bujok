// ==UserScript==
// @name         Bujok Attack Overlay
// @namespace    bujok
// @version      2.0
// @description  부족전쟁 공격 감시 오버레이 (인라인 — fetch 불필요)
// @match        https://*.tribalwars.net/game.php*
// @match        https://*.tribalwars.co.kr/game.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// overlay.js 코드를 직접 내장 — localhost fetch 없이 즉시 실행
(function () {
    'use strict';
    if (document.getElementById('bujok-overlay')) return;

    console.log('[Bujok] 오버레이 시작 (인라인 v2.0)');

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
        spy:       { color: '#8e44ad', label: '정찰',   svg: function(c){return mkIcon(SVG_PATHS.spy,c)},       svgSm: function(c){return mkIconSm(SVG_PATHS.spy,c)} },
        light:     { color: '#f39c12', label: '경기병',  svg: function(c){return mkIcon(SVG_PATHS.light,c)},     svgSm: function(c){return mkIconSm(SVG_PATHS.light,c)} },
        heavy:     { color: '#e67e22', label: '중기병',  svg: function(c){return mkIcon(SVG_PATHS.heavy,c)},     svgSm: function(c){return mkIconSm(SVG_PATHS.heavy,c)} },
        axe_spear: { color: '#e74c3c', label: '도끼/창', svg: function(c){return mkIcon(SVG_PATHS.axe_spear,c)}, svgSm: function(c){return mkIconSm(SVG_PATHS.axe_spear,c)} },
        sword:     { color: '#c0392b', label: '검병',    svg: function(c){return mkIcon(SVG_PATHS.sword,c)},     svgSm: function(c){return mkIconSm(SVG_PATHS.sword,c)} },
        ram:       { color: '#7f8c8d', label: '공성',    svg: function(c){return mkIcon(SVG_PATHS.ram,c)},       svgSm: function(c){return mkIconSm(SVG_PATHS.ram,c)} },
        snob:      { color: '#f1c40f', label: '귀족',    svg: function(c){return mkIcon(SVG_PATHS.snob,c)},      svgSm: function(c){return mkIconSm(SVG_PATHS.snob,c)} },
    };
    var UNKNOWN = { color: '#95a5a6', label: '미상',
        svg: function(c){return mkIcon('<circle cx="12" cy="12" r="9" fill="none" stroke="__C__" stroke-width="2"/><text x="12" y="16" text-anchor="middle" fill="__C__" font-size="12" font-weight="bold">?</text>',c)},
        svgSm: function(c){return mkIconSm('<circle cx="12" cy="12" r="9" fill="none" stroke="__C__" stroke-width="2"/><text x="12" y="16" text-anchor="middle" fill="__C__" font-size="12" font-weight="bold">?</text>',c)}
    };

    function getUnit(type) { return UNIT[type] || UNKNOWN; }

    // ============================================
    // CSS
    // ============================================
    var css = document.createElement('style');
    css.id = 'bujok-overlay-css';
    css.textContent = '\
#bujok-overlay{position:fixed;top:10px;right:10px;width:440px;max-height:85vh;background:rgba(18,22,30,.96);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#ddd;font-family:"Segoe UI",-apple-system,sans-serif;font-size:12.5px;line-height:1.4;z-index:999999;box-shadow:0 8px 40px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden;transition:width .2s,max-height .2s}\
#bujok-overlay.minimized{max-height:42px;width:260px}\
.bj-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(25,30,42,.98);border-bottom:1px solid rgba(255,255,255,.06);cursor:grab;user-select:none;flex-shrink:0}\
.bj-hdr:active{cursor:grabbing}\
.bj-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}\
.bj-dot.connected{background:#2ecc71;box-shadow:0 0 6px #2ecc71}\
.bj-dot.connecting{background:#f39c12;animation:bjp 1s infinite}\
.bj-dot.error{background:#e74c3c}\
@keyframes bjp{0%,100%{opacity:1}50%{opacity:.4}}\
.bj-ttl{font-weight:600;font-size:13px;color:#fff;flex-grow:1}\
.bj-cnt{background:#e74c3c;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600;min-width:18px;text-align:center}\
.bj-cnt.z{background:#2c3e50;color:#7f8c8d}\
.bj-lc{color:#666;font-size:11px}\
.bj-btn{background:0 0;border:none;color:#888;cursor:pointer;font-size:16px;padding:0 4px;line-height:1}\
.bj-btn:hover{color:#fff}\
.bj-train{padding:6px 12px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;flex-shrink:0}\
.bj-train.cf{background:rgba(231,76,60,.25);border-bottom:1px solid rgba(231,76,60,.3);color:#e74c3c}\
.bj-train.sp{background:rgba(243,156,18,.2);border-bottom:1px solid rgba(243,156,18,.3);color:#f39c12}\
.bj-body{overflow-y:auto;flex:1;min-height:0}\
.bj-body::-webkit-scrollbar{width:5px}\
.bj-body::-webkit-scrollbar-track{background:0 0}\
.bj-body::-webkit-scrollbar-thumb{background:#444;border-radius:3px}\
.bj-empty{padding:30px;text-align:center;color:#555;font-size:14px}\
.bj-row{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.04);transition:background .15s}\
.bj-row:hover{background:rgba(255,255,255,.03)}\
.bj-row.urgent{background:rgba(231,76,60,.08)}\
.bj-row.urgent .bj-cd{color:#e74c3c;font-weight:700}\
.bj-ico{flex-shrink:0;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:rgba(255,255,255,.06)}\
.bj-info{flex:1;min-width:0}\
.bj-info-top{display:flex;align-items:center;gap:6px}\
.bj-tl{font-weight:600;font-size:12px}\
.bj-tag{font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600}\
.bj-tag.cf{background:rgba(231,76,60,.3);color:#e74c3c}\
.bj-tag.sp{background:rgba(243,156,18,.25);color:#f39c12}\
.bj-coords{color:#888;font-size:11px;margin-top:2px}\
.bj-coords span{color:#aaa}\
.bj-tc{text-align:right;flex-shrink:0}\
.bj-cd{font-size:14px;font-weight:600;color:#3498db;font-variant-numeric:tabular-nums}\
.bj-arr{font-size:10px;color:#666;margin-top:1px}\
.bj-cmd-badge{display:inline-flex;align-items:center;gap:3px;margin-left:6px;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600;vertical-align:middle;white-space:nowrap}\
.bj-cmd-badge svg{vertical-align:middle}\
.bj-cmd-loading{color:#888;font-size:10px;margin-left:6px}\
';
    document.head.appendChild(css);

    // ============================================
    // DOM 생성 (플로팅 수신 공격 패널)
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
        drag = true;
        ddx = e.clientX - el.offsetLeft;
        ddy = e.clientY - el.offsetTop;
    });
    document.addEventListener('mousemove', function (e) {
        if (!drag) return;
        el.style.left = (e.clientX - ddx) + 'px';
        el.style.top = (e.clientY - ddy) + 'px';
        el.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { drag = false; });

    // ============================================
    // 컨트롤 버튼
    // ============================================
    document.getElementById('bj-min').addEventListener('click', function () {
        minimized = !minimized;
        el.classList.toggle('minimized', minimized);
        this.textContent = minimized ? '\u25A1' : '\u2500';
    });
    document.getElementById('bj-cls').addEventListener('click', function () {
        el.remove();
        css.remove();
        clearInterval(pollTimer);
        clearInterval(cdTimer);
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
    // 귀족열차 감지 (클라이언트측)
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
    // 수신 공격 데이터 폴링 (watcher API)
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
        }).catch(function () {
            connStatus = 'error';
            render();
        });
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
            var dist = atk.distance ? '<span style="color:#666;font-size:10px">' + atk.distance + '\uCE78</span>' : '';

            return '<div class="bj-row' + (urgent ? ' urgent' : '') + '" data-arr="' + arrMs + '">' +
                '<div class="bj-ico">' + u.svg(u.color) + '</div>' +
                '<div class="bj-info">' +
                    '<div class="bj-info-top">' +
                        '<span class="bj-tl" style="color:' + u.color + '">' + u.label + '</span>' +
                        trainTag + dist +
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
    // 카운트다운 (1초 갱신)
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
    //  커맨드 병종 인라인 표시 (게임 테이블에 직접 주입)
    // ============================================

    var cmdCache = {};

    var UNIT_KR = {
        spear: '창병', sword: '검병', axe: '도끼', spy: '정찰',
        light: '경기', heavy: '중기', ram: '파성추', catapult: '투석기',
        snob: '귀족', knight: '기사', archer: '궁병', marcher: '마궁'
    };

    function classifyBySpeed(speed) {
        if (speed < 9.5) return 'spy';
        if (speed < 10.5) return 'light';
        if (speed < 16) return 'heavy';
        if (speed < 20) return 'axe_spear';
        if (speed < 28) return 'sword';
        if (speed < 33) return 'ram';
        return 'snob';
    }

    function classifyByTroops(troops) {
        if (!troops || Object.keys(troops).length === 0) return null;
        if (troops.snob > 0) return 'snob';
        if ((troops.ram || 0) > 0 || (troops.catapult || 0) > 0) return 'ram';
        var total = 0;
        var keys = Object.keys(troops);
        for (var i = 0; i < keys.length; i++) total += troops[keys[i]] || 0;
        if (total === 0) return null;
        if (troops.spy > 0 && troops.spy === total) return 'spy';
        var combat = { light: troops.light||0, heavy: troops.heavy||0, axe: troops.axe||0,
                       spear: troops.spear||0, sword: troops.sword||0 };
        var maxU = null, maxN = 0;
        var ck = Object.keys(combat);
        for (var j = 0; j < ck.length; j++) {
            if (combat[ck[j]] > maxN) { maxN = combat[ck[j]]; maxU = ck[j]; }
        }
        if (!maxU || maxN === 0) return troops.spy > 0 ? 'spy' : null;
        if (maxU === 'light') return 'light';
        if (maxU === 'heavy') return 'heavy';
        if (maxU === 'axe' || maxU === 'spear') return 'axe_spear';
        if (maxU === 'sword') return 'sword';
        return null;
    }

    function troopSummary(troops) {
        if (!troops) return '';
        var parts = [];
        var order = ['light','heavy','axe','spear','sword','spy','ram','catapult','snob','knight'];
        for (var i = 0; i < order.length; i++) {
            var u = order[i];
            if (troops[u] && troops[u] > 0) parts.push((UNIT_KR[u]||u) + ' ' + troops[u]);
        }
        return parts.join(', ');
    }

    function parseCommandDetail(html) {
        var result = { type: null, summary: '' };

        var doc = new DOMParser().parseFromString(html, 'text/html');
        var troops = {};
        var unitNames = ['spear','sword','axe','archer','spy','light','marcher','heavy','ram','catapult','knight','snob'];
        var tables = doc.querySelectorAll('table');
        for (var ti = 0; ti < tables.length; ti++) {
            var rows = tables[ti].querySelectorAll('tr');
            if (rows.length < 2) continue;
            var unitCols = {};
            var hCells = rows[0].querySelectorAll('th, td');
            for (var ci = 0; ci < hCells.length; ci++) {
                var img = hCells[ci].querySelector('img[src*="unit_"]');
                if (!img) continue;
                var src = img.getAttribute('src') || '';
                for (var ui = 0; ui < unitNames.length; ui++) {
                    if (src.indexOf('unit_' + unitNames[ui]) >= 0) { unitCols[ci] = unitNames[ui]; break; }
                }
            }
            if (Object.keys(unitCols).length < 3) continue;
            var dCells = rows[1].querySelectorAll('td');
            var colKeys = Object.keys(unitCols);
            for (var ki = 0; ki < colKeys.length; ki++) {
                var idx = parseInt(colKeys[ki]);
                if (dCells[idx]) troops[unitCols[idx]] = parseInt(dCells[idx].textContent.trim()) || 0;
            }
            if (Object.keys(troops).length > 0) break;
        }

        var troopType = classifyByTroops(troops);
        result.summary = troopSummary(troops);
        if (troopType) { result.type = troopType; return result; }

        var endtimes = [];
        var re = /data-endtime="(\d+)"/g, m;
        while ((m = re.exec(html)) !== null) endtimes.push(parseInt(m[1]) * 1000);

        var coords = [];
        var cre = /\((\d{3})\|(\d{3})\)/g;
        while ((m = cre.exec(html)) !== null) coords.push({ x: parseInt(m[1]), y: parseInt(m[2]) });

        if (endtimes.length >= 2 && coords.length >= 2) {
            endtimes.sort(function(a,b){ return a-b; });
            var launch = endtimes[0];
            var arrival = endtimes[endtimes.length - 1];
            var ox = coords[0].x, oy = coords[0].y;
            var tx = coords[1].x, ty = coords[1].y;
            var dist = Math.sqrt((ox-tx)*(ox-tx) + (oy-ty)*(oy-ty));
            if (dist > 0 && arrival > launch) {
                var speed = (arrival - launch) / 60000 / dist;
                result.type = classifyBySpeed(speed);
                if (!result.summary) result.summary = speed.toFixed(1) + ' min/field, ' + dist.toFixed(1) + '\uCE78';
            }
        }

        return result;
    }

    function fetchCommandDetail(link) {
        var href = link.href || link.getAttribute('href');
        if (href.indexOf('http') !== 0) href = window.location.origin + '/' + href.replace(/^\//, '');
        return fetch(href, { credentials: 'same-origin' })
            .then(function(r) { return r.text(); })
            .then(function(html) { return parseCommandDetail(html); });
    }

    function injectCmdBadge(row, type, summary) {
        var u = getUnit(type);
        var badge = document.createElement('span');
        badge.className = 'bj-cmd-badge';
        badge.style.cssText = 'background:' + u.color + '22;color:' + u.color + ';border:1px solid ' + u.color + '44;';
        badge.innerHTML = u.svgSm(u.color) + ' ' + u.label;
        badge.title = summary || u.label;
        var lastCell = row.querySelector('td:last-child');
        if (lastCell) lastCell.appendChild(badge);
    }

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
                if (cmdCache[cmdId].type) injectCmdBadge(row, cmdCache[cmdId].type, cmdCache[cmdId].summary);
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

    function processQueue(queue) {
        var idx = 0;
        function next() {
            if (idx >= queue.length) return;
            var item = queue[idx++];
            fetchCommandDetail(item.link)
                .then(function(result) {
                    cmdCache[item.cmdId] = result;
                    if (item.loading && item.loading.parentNode) item.loading.remove();
                    if (result.type) injectCmdBadge(item.row, result.type, result.summary);
                })
                .catch(function() {
                    if (item.loading && item.loading.parentNode) item.loading.textContent = '';
                })
                .finally(function() { setTimeout(next, 500); });
        }
        next();
    }

    // ============================================
    // 시작
    // ============================================
    fetchData();
    var pollTimer = setInterval(fetchData, POLL_MS);
    var cdTimer = setInterval(updateCd, 1000);

    enrichCommands();

    console.log('[Bujok] 오버레이 초기화 완료');
})();
