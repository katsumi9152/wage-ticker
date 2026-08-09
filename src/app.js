/**
 * app.js — 画面まわり(DOM)だけを担当する層。
 *
 * 給与計算そのものは src/wage.js・src/aggregate.js の純粋関数に閉じ込めてある。
 * ここでは「重い区分計算(1秒ごと)」と「描画ループ(requestAnimationFrame)」を
 * 分離し、秒単位の数値がなめらかに動くことを最優先にする(SPEC 14)。
 */
(function (WT) {
  'use strict';

  var T = WT.time;
  var P = WT.period;
  var A = WT.aggregate;
  var W = WT.wage;
  var store = WT.storage.Store;

  var $ = function (id) { return document.getElementById(id); };

  /** 現在の集計コンテキスト(1秒ごとに作り直す) */
  var ctx = null;
  var lastLogSavedAt = 0;
  var calMonth = null;
  var editingDayKey = null;
  var resetArmed = false;

  // ------------------------------------------------------------ 表示補助

  function fmtYen(n) {
    return '¥' + Math.floor((n || 0) + 1e-9).toLocaleString('ja-JP');
  }

  function fmtYenParts(n) {
    var v = Math.max(0, n || 0);
    var i = Math.floor(v);
    var d = Math.floor((v - i) * 100);
    return { int: i.toLocaleString('ja-JP'), dec: '.' + T.pad2(d) };
  }

  function fmtHours(minutes) {
    return T.formatMinutes(minutes);
  }

  function fmtSignedYen(n) {
    var sign = n >= 0 ? '+' : '−';
    return sign + fmtYen(Math.abs(n)).slice(1) + '円';
  }

  function fmtSignedMinutes(m) {
    var sign = m >= 0 ? '+' : '−';
    return sign + T.formatMinutes(Math.abs(m));
  }

  function mdLabel(key) {
    var d = T.parseDateKey(key);
    return d.getMonth() + 1 + '/' + d.getDate() + '(' + WT.WEEKDAY_LABELS[d.getDay()] + ')';
  }

  function hhmm(ms) {
    var d = new Date(ms);
    return T.pad2(d.getHours()) + ':' + T.pad2(d.getMinutes());
  }

  // -------------------------------------------------- テーマ(ライト/ダーク)

  var THEME_KEY = 'wageTheme';

  /** 保存された指定を適用する。未指定なら端末の設定に従う(data-theme を付けない) */
  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'light' || theme === 'dark') {
      root.setAttribute('data-theme', theme);
    } else {
      root.removeAttribute('data-theme');
    }
  }

  function currentTheme() {
    var saved = null;
    try { saved = globalThis.localStorage ? globalThis.localStorage.getItem(THEME_KEY) : null; } catch (e) { saved = null; }
    if (saved === 'light' || saved === 'dark') return saved;
    var mq = globalThis.matchMedia && globalThis.matchMedia('(prefers-color-scheme: dark)');
    return mq && mq.matches ? 'dark' : 'light';
  }

  function initTheme() {
    // 指定が無ければ端末の設定に追従する(data-theme を付けない)
    var saved = null;
    try { saved = globalThis.localStorage ? globalThis.localStorage.getItem(THEME_KEY) : null; } catch (e) { saved = null; }
    applyTheme(saved);
    $('themeToggle').addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      try { globalThis.localStorage.setItem(THEME_KEY, next); } catch (e) { /* noop */ }
      applyTheme(next);
    });
  }

  // -------------------------------------------------------- 時計ゲージ

  /**
   * 24時間を二重の文字盤で表す。外側の輪が午前(0:00〜12:00)、内側の輪が午後(12:00〜24:00)。
   * どちらの輪も12時間で1周し、真上が起点(0時 / 12時)。
   */
  var CLOCK = { cx: 100, cy: 100, rAm: 76, rPm: 54 };

  function polar(r, deg) {
    var rad = ((deg - 90) * Math.PI) / 180;
    return { x: CLOCK.cx + r * Math.cos(rad), y: CLOCK.cy + r * Math.sin(rad) };
  }

  /** 円弧のパス。sweep は時計回りの角度。 */
  function arcPath(r, startDeg, sweepDeg) {
    if (!(sweepDeg > 0.01)) return '';
    if (sweepDeg > 359.9) sweepDeg = 359.9;
    var s = polar(r, startDeg);
    var e = polar(r, startDeg + sweepDeg);
    return 'M' + s.x.toFixed(2) + ' ' + s.y.toFixed(2) +
      ' A' + r + ' ' + r + ' 0 ' + (sweepDeg > 180 ? 1 : 0) + ' 1 ' + e.x.toFixed(2) + ' ' + e.y.toFixed(2);
  }

  /** その時刻がどちらの輪に乗るか */
  function ringRadius(minutesOfDay) {
    return ((minutesOfDay % 1440) + 1440) % 1440 < 720 ? CLOCK.rAm : CLOCK.rPm;
  }

  function ringAngle(minutesOfDay) {
    var m = ((minutesOfDay % 1440) + 1440) % 1440;
    return ((m % 720) / 720) * 360;
  }

  /** 時間帯を、午前の輪と午後の輪に切り分けて円弧にする */
  function ringArcs(startMin, spanMin) {
    var out = [];
    var cur = ((startMin % 1440) + 1440) % 1440;
    var remain = spanMin;
    var guard = 0;
    while (remain > 0.01 && guard++ < 8) {
      var base = cur < 720 ? 0 : 720;
      var take = Math.min(remain, base + 720 - cur);
      out.push({ r: cur < 720 ? CLOCK.rAm : CLOCK.rPm, start: ((cur - base) / 720) * 360, sweep: (take / 720) * 360 });
      cur = (cur + take) % 1440;
      remain -= take;
    }
    return out;
  }

  function arcsHtml(startMin, spanMin) {
    var arcs = ringArcs(startMin, spanMin);
    var html = '';
    for (var i = 0; i < arcs.length; i++) {
      var d = arcPath(arcs[i].r, arcs[i].start, arcs[i].sweep);
      if (d) html += '<path d="' + d + '"/>';
    }
    return html;
  }

  /** 文字盤(1時間ごとの目盛りと時刻)を1度だけ組み立てる */
  function buildGauge() {
    var g = $('clockTicks');
    if (!g) return;
    var ticks = '';
    for (var h = 0; h < 12; h++) {
      var deg = (h / 12) * 360;
      var major = h % 3 === 0;
      // 外側=午前
      var a1 = polar(major ? 82 : 84, deg);
      var b1 = polar(88, deg);
      ticks += '<line class="ctick' + (major ? ' is-major' : '') + '" x1="' + a1.x.toFixed(1) + '" y1="' + a1.y.toFixed(1) +
        '" x2="' + b1.x.toFixed(1) + '" y2="' + b1.y.toFixed(1) + '"/>';
      // 内側=午後
      var a2 = polar(major ? 61 : 63, deg);
      var b2 = polar(67, deg);
      ticks += '<line class="ctick' + (major ? ' is-major' : '') + '" x1="' + a2.x.toFixed(1) + '" y1="' + a2.y.toFixed(1) +
        '" x2="' + b2.x.toFixed(1) + '" y2="' + b2.y.toFixed(1) + '"/>';
    }
    g.innerHTML = ticks;

    var labels = '';
    var hours = [0, 3, 6, 9];
    for (var i = 0; i < hours.length; i++) {
      var deg2 = (hours[i] / 12) * 360;
      var p = polar(96, deg2);
      labels += '<text class="clabel" x="' + p.x.toFixed(1) + '" y="' + (p.y + 3.2).toFixed(1) + '">' + hours[i] + '</text>';
      var q = polar(45, deg2);
      labels += '<text class="clabel clabel--pm" x="' + q.x.toFixed(1) + '" y="' + (q.y + 3).toFixed(1) + '">' + (hours[i] + 12) + '</text>';
    }
    $('clockLabels').innerHTML = labels;
  }

  function minutesOfDayOf(ms) {
    var d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }

  /**
   * 24時間の文字盤に、予定(出勤〜退勤)・休憩・実績・現在時刻の針を描く。
   * 実績の弧は「出勤してから今まで」を示し、メーターのように伸びていく。
   */
  function renderClock(settings, nowMs, actual, todayWorkedMinutes) {
    var startMin = T.parseTimeToMinutes(settings.schedule && settings.schedule.start);
    var endMin = T.parseTimeToMinutes(settings.schedule && settings.schedule.end);
    var brk = settings.breakWindow || {};
    var bStart = T.parseTimeToMinutes(brk.start);
    var bEnd = T.parseTimeToMinutes(brk.end);

    $('clockPlanned').innerHTML = (startMin !== null && endMin !== null)
      ? arcsHtml(startMin, (endMin - startMin + 1440) % 1440 || 1440)
      : '';

    $('clockBreak').innerHTML = (bStart !== null && bEnd !== null && bStart !== bEnd)
      ? arcsHtml(bStart, (bEnd - bStart + 1440) % 1440)
      : '';

    if (actual && actual.startMs) {
      var from = minutesOfDayOf(actual.startMs);
      var to = minutesOfDayOf(actual.endMs || nowMs);
      $('clockActual').innerHTML = arcsHtml(from, (to - from + 1440) % 1440);
    } else {
      $('clockActual').innerHTML = '';
    }

    // 現在時刻は、その時刻が乗っている輪の上に印を置く
    var nowMin = minutesOfDayOf(nowMs);
    var r = ringRadius(nowMin);
    var deg = ringAngle(nowMin);
    var tip = polar(r + 9, deg);
    var tail = polar(r - 9, deg);
    var hand = $('clockHand');
    hand.setAttribute('x1', tail.x.toFixed(1));
    hand.setAttribute('y1', tail.y.toFixed(1));
    hand.setAttribute('x2', tip.x.toFixed(1));
    hand.setAttribute('y2', tip.y.toFixed(1));

    $('clockValue').textContent = T.formatMinutes(todayWorkedMinutes);
    $('clockCap').textContent = startMin !== null && endMin !== null
      ? '予定 ' + (settings.schedule.start) + '〜' + (settings.schedule.end) +
        (bStart !== null ? ' / 休憩 ' + brk.start + '〜' + brk.end : '')
      : '';
  }

  /**
   * 今月と先月(同じ経過日数時点)の金額を並べた棒グラフ。
   * 青い破線は基本給のライン。超えていれば残業代の領域に入っている。
   */
  function renderMonthBar(monthAmount, baseSalary, prevAmount) {
    var max = Math.max(baseSalary * 1.15, monthAmount * 1.08, prevAmount * 1.08, 1);
    $('monthBarFill').style.height = ((monthAmount / max) * 100).toFixed(1) + '%';
    $('prevBarFill').style.height = ((prevAmount / max) * 100).toFixed(1) + '%';
    $('monthBarMarks').innerHTML = baseSalary > 0
      ? '<i class="vbar-mark is-base" style="bottom:' + ((baseSalary / max) * 100).toFixed(1) + '%"></i>'
      : '';
    $('monthBar').classList.toggle('over-base', monthAmount > baseSalary && baseSalary > 0);
  }

  // ------------------------------------------------------------ 集計処理

  /** 手動の打刻を最優先に見る。押していなければ自動モードの予定を使う。 */
  function activeSessionOf(settings, autoInfo) {
    if (store.state.status === 'working' && store.state.clockInAt) {
      return {
        startMs: store.state.clockInAt,
        isLegalHoliday: !!store.state.isLegalHoliday,
        breaks: store.state.breaks || [],
        manual: true,
      };
    }
    if (settings.autoMode) return autoInfo.active;
    return null;
  }

  function previousPeriodDays(period, settings) {
    var prev = P.previousPeriod(period, settings.closingDay);
    var hasData = false;
    for (var k in store.calendar) {
      if (Object.prototype.hasOwnProperty.call(store.calendar, k) && k >= prev.startKey && k <= prev.endKey) {
        hasData = true;
        break;
      }
    }
    if (hasData) {
      var agg = A.aggregatePeriod({
        period: prev,
        settings: settings,
        calendar: store.calendar,
        activeSession: null,
        now: T.addDays(prev.end, 1),
        finalize: true,
      });
      return { period: prev, days: agg.days };
    }
    if (store.previousLog && store.previousLog.length) {
      return { period: prev, days: store.previousLog };
    }
    return null;
  }

  /** 重い処理(区分計算・期間集計)。1秒ごと、または操作のたびに呼ぶ。 */
  function heavy() {
    var now = new Date();
    var settings = store.settings;

    store.rollover(now);
    var period = P.resolvePeriod(now, settings.closingDay);
    if (store.state.periodStartKey !== period.startKey) {
      store.state.periodStartKey = period.startKey;
      store.saveState();
    }

    var autoInfo = WT.storage.resolveAutoMode(store, now.getTime());
    var active = activeSessionOf(settings, autoInfo);
    var agg = A.aggregatePeriod({
      period: period,
      settings: settings,
      calendar: store.calendar,
      activeSession: active,
      now: now,
    });

    ctx = {
      now: now,
      settings: settings,
      period: period,
      agg: agg,
      active: active,
      autoInfo: autoInfo,
      prev: previousPeriodDays(period, settings),
    };
    // 先月の確定合計(縦バーの赤いライン)
    ctx.prevTotalAmount = ctx.prev
      ? A.prefixTotals(ctx.prev.days, ctx.prev.period.start, 400).amount
      : 0;

    if (Date.now() - lastLogSavedAt > 60000) {
      lastLogSavedAt = Date.now();
      store.saveCurrentLog(agg.days);
    }

    renderStatic();
  }

  function currentLive(nowMs) {
    if (!ctx || !ctx.active) return null;
    return A.computeLive(ctx.agg, ctx.active, ctx.settings, nowMs);
  }

  // ------------------------------------------------------------ 描画

  function renderStatic() {
    if (!ctx) return;
    var live = currentLive(Date.now());

    var monthTotal = W.cloneBreakdown(ctx.agg.totals);
    var todayTotal = W.cloneBreakdown(ctx.agg.todayFinalized);
    if (live) {
      W.addBreakdown(monthTotal, live.breakdown);
      W.addBreakdown(todayTotal, live.breakdown);
    }

    $('todayAmount').textContent = fmtYen(todayTotal.amount);
    $('todaySub').textContent = fmtHours(todayTotal.workedMinutes);
    $('monthAmount').textContent = fmtYen(monthTotal.amount);
    $('monthSub').textContent = fmtHours(monthTotal.workedMinutes);

    // 前月同時点との差(SPEC 7.2)
    var diffEl = $('monthDiff');
    var cmp = ctx.prev
      ? A.comparePrevious(monthTotal, ctx.prev.days, ctx.prev.period, P.elapsedDays(ctx.period, ctx.now))
      : null;
    if (cmp) {
      diffEl.hidden = false;
      diffEl.textContent = '先月比 ' + fmtSignedYen(cmp.amountDiff);
      diffEl.classList.toggle('is-plus', cmp.amountDiff >= 0);
      diffEl.classList.toggle('is-minus', cmp.amountDiff < 0);
    } else {
      diffEl.hidden = true;
    }

    renderClock(ctx.settings, Date.now(), todayActualSpan(), todayTotal.workedMinutes);
    // 棒グラフの「先月」は、同じ経過日数時点までの金額(月途中でも公平に比べられる)
    renderMonthBar(monthTotal.amount, Number(ctx.settings.monthlyBaseSalary || 0), cmp ? cmp.baseAmount : 0);
    renderStatus(live);
    renderActions();
    if ($('detailsPanel').open) renderDetails(monthTotal, todayTotal, live, cmp);
  }

  /** 時計に描く「今日の実績の弧」。勤務中なら現在まで、終業後は退勤時刻まで。 */
  function todayActualSpan() {
    if (ctx.active) return { startMs: ctx.active.startMs, endMs: null };
    var todayKey = T.dateKey(ctx.now);
    for (var i = ctx.agg.days.length - 1; i >= 0; i--) {
      var d = ctx.agg.days[i];
      if (d.date === todayKey && d.kind === 'work') return { startMs: d.clockIn, endMs: d.clockOut };
    }
    return null;
  }

  function renderStatus(live) {
    var badge = $('statusBadge');
    var working = !!ctx.active;
    badge.classList.toggle('is-working', working);
    var text;
    if (!store.state.configured) text = '未設定';
    else if (!working) text = '待機中';
    else if (live && live.onBreak) text = '休憩中';
    else if (ctx.active.manual) text = '勤務中'; // 手動の打刻が優先されている
    else text = ctx.settings.autoMode ? '自動計測中' : '勤務中';
    $('statusText').textContent = text;
    $('detailsPanel').classList.toggle('is-working', working);
  }

  /**
   * ボタンの出し分け。手動の打刻は自動モードより優先するので、
   * 出勤 / 退勤 / 休憩は常に置いておく。
   */
  function renderActions() {
    var inBtn = $('clockInBtn');
    var outBtn = $('clockOutBtn');
    var brkBtn = $('breakBtn');
    var otBtn = $('overtimeBtn');

    var working = store.state.status === 'working';
    var onManualBreak = store.isOnManualBreak();
    var onLunch = isLunchNow();

    inBtn.hidden = false;
    outBtn.hidden = false;
    brkBtn.hidden = false;

    inBtn.disabled = working;              // 出勤したら退勤しか押せない
    outBtn.disabled = !working;
    // 昼休憩の最中は、手動の休憩を押せない(二重に休むことになるため)
    brkBtn.disabled = !working || onLunch;
    setActLabel(brkBtn, onManualBreak ? '休憩終了' : '休憩開始');
    brkBtn.classList.toggle('is-on', onManualBreak);

    // 自動モードで、手動の打刻がない日だけ「残業開始 / 終了」を出す(SPEC 5.3)
    var autoActive = ctx.settings.autoMode && !working && ctx.active && !ctx.active.manual;
    otBtn.hidden = !autoActive;
    if (autoActive) setActLabel(otBtn, store.state.overtimeFlag ? '残業終了' : '残業開始');
  }

  /** いま設定された昼休憩の時間帯の中か */
  function isLunchNow() {
    var w = ctx.settings.breakWindow;
    if (!w) return false;
    var now = Date.now();
    return W.isOnBreakAt(now, now - T.MS_PER_DAY, w);
  }

  /** ボタンはアイコン + ラベルなので、ラベルの span だけを書き換える */
  function setActLabel(btn, text) {
    var span = btn.querySelector && btn.querySelector('span');
    if (span) span.textContent = text;
    else btn.textContent = text;
  }

  /** 秒単位の描画。ここでは軽い計算しかしない(SPEC 14)。 */
  function renderFrame() {
    if (ctx) {
      var live = currentLive(Date.now());
      var hero = $('heroCard');
      if (live) {
        var parts = fmtYenParts(live.breakdown.amount);
        $('liveInt').textContent = parts.int;
        $('liveDec').textContent = parts.dec;
        $('tickerLabel').textContent = ctx.settings.autoMode ? '今このセッション(自動)' : '今このセッション';
        $('liveMeta').textContent = liveMetaText(live);
        hero.classList.add('is-live');
        setTone(hero, live);
        $('rateStrip').textContent = rateLabel(live);
      } else {
        var last = lastSessionAmount();
        var p2 = fmtYenParts(last.amount);
        $('liveInt').textContent = p2.int;
        $('liveDec').textContent = p2.dec;
        $('tickerLabel').textContent = last.label;
        $('liveMeta').textContent = last.meta;
        hero.classList.remove('is-live');
        setTone(hero, null);
        $('rateStrip').textContent = '';
      }
    }
    requestAnimationFrame(renderFrame);
  }

  function liveMetaText(live) {
    var start = ctx.active ? hhmm(ctx.active.startMs) : '--:--';
    var txt = '出勤 ' + start + ' / 実働 ' + fmtHours(live.workedMinutes);
    if (live.deductedMinutes > 0) txt += ' / 休憩 -' + Math.round(live.deductedMinutes) + '分';
    if (live.onBreak) txt += ' / 休憩中';
    return txt;
  }

  function lastSessionAmount() {
    // 出勤していないときは、その日の最後の勤務ぶんを静かに表示しておく
    var days = ctx.agg.days;
    var todayKey = T.dateKey(ctx.now);
    for (var i = days.length - 1; i >= 0; i--) {
      if (days[i].date === todayKey && days[i].kind === 'work') {
        return {
          amount: days[i].breakdown.amount,
          label: '直近の勤務',
          meta: hhmm(days[i].clockIn) + '〜' + hhmm(days[i].clockOut) + ' / 実働 ' + fmtHours(days[i].workedMinutes),
        };
      }
    }
    return {
      amount: 0,
      label: '今このセッション',
      meta: store.settings.autoMode ? '勤務予定時間外です' : '出勤していません',
    };
  }

  var TONE_LABEL = {
    scheduledInside: '所定内',
    legalInsideOvertime: '法定内残業',
    statutoryOvertime: '法定時間外',
    statutoryOvertimeOver60: '法定時間外 60h超',
    legalHoliday: '法定休日',
  };

  function rateLabel(live) {
    if (live.onBreak) return '休憩中 — カウント停止';
    var label = TONE_LABEL[live.marginal.kind] || '';
    if (T.isNightMs(Date.now())) label += ' + 深夜';
    return label + ' ×' + live.marginal.rate.toFixed(2);
  }

  function setTone(el, live) {
    var tones = ['tone-scheduledInside', 'tone-legalInsideOvertime', 'tone-statutoryOvertime',
      'tone-statutoryOvertimeOver60', 'tone-legalHoliday', 'tone-night', 'tone-break'];
    for (var i = 0; i < tones.length; i++) el.classList.remove(tones[i]);
    if (!live) return;
    var tone;
    if (live.onBreak) tone = 'tone-break';
    else if (live.marginal.kind === 'legalHoliday') tone = 'tone-legalHoliday';
    else if (T.isNightMs(Date.now())) tone = 'tone-night';
    else tone = 'tone-' + live.marginal.kind;
    el.classList.add(tone);
  }

  // ------------------------------------------------------ 補助情報(10.1 ④)

  function kv(k, v, opts) {
    var o = opts || {};
    return '<div class="kv' + (o.zero ? ' is-zero' : '') + '"><span class="k">' + k +
      '</span><span class="v' + (o.money ? ' money' : '') + '">' + v + '</span></div>';
  }

  function renderDetails(monthTotal, todayTotal, live, cmp) {
    var s = ctx.settings;
    var agg = ctx.agg;
    var html = '';

    // --- 内訳
    var b = monthTotal;
    html += '<div class="sec"><h3>今月の内訳</h3>';
    html += kv('所定内(基本給ぶん)', fmtHours(b.scheduledInside.minutes) + ' / ' + fmtYen(b.scheduledInside.amount), { money: true, zero: b.scheduledInside.minutes === 0 });
    html += kv('法定内残業 ×1.00', fmtHours(b.legalInsideOvertime.minutes) + ' / ' + fmtYen(b.legalInsideOvertime.amount), { money: true, zero: b.legalInsideOvertime.minutes === 0 });
    html += kv('法定時間外 ×1.25', fmtHours(b.statutoryOvertime.minutes) + ' / ' + fmtYen(b.statutoryOvertime.amount), { money: true, zero: b.statutoryOvertime.minutes === 0 });
    html += kv('法定時間外 ×1.50(60h超)', fmtHours(b.statutoryOvertimeOver60.minutes) + ' / ' + fmtYen(b.statutoryOvertimeOver60.amount), { money: true, zero: b.statutoryOvertimeOver60.minutes === 0 });
    html += kv('法定休日 ×1.35', fmtHours(b.legalHoliday.minutes) + ' / ' + fmtYen(b.legalHoliday.amount), { money: true, zero: b.legalHoliday.minutes === 0 });
    html += kv('深夜割増 +0.25', fmtHours(b.night.minutes) + ' / ' + fmtYen(b.night.amount), { money: true, zero: b.night.minutes === 0 });
    html += kv('うち未入力の自動加算', fmtHours(b.autoFilledMinutes) + ' / ' + fmtYen(b.autoFilledAmount), { money: true, zero: b.autoFilledMinutes === 0 });
    html += kv('基本給とは別の追加分', fmtYen(b.extraAmount), { money: true, zero: b.extraAmount === 0 });
    html += '</div>';

    // --- 賃金の計算式(この金額がどう出ているか)
    html += '<div class="sec"><h3>賃金の計算式</h3><div class="formula">';
    html += '<div>1日の所定労働時間 = 勤務時間 − 休憩 = <b>' + hourLabel(s.dailyScheduledHours) + '</b></div>';
    html += '<div>月平均所定労働時間 = (365 − ' + s.annualHolidays + '日) × ' + s.dailyScheduledHours +
      '時間 ÷ 12 = <b>' + agg.rates.monthlyAvgScheduledHours.toFixed(1) + '時間</b></div>';
    html += '<div>基礎時給単価 = 基本給 ÷ ' + agg.rates.monthlyAvgScheduledHours.toFixed(1) +
      '時間 = <b class="money">' + fmtYen(agg.rates.baseHourlyRate) + '</b> /時</div>';
    html += '<div>金額 = 基礎時給単価 × 割増率 × 働いた時間</div>';
    html += '</div>';
    html += '<p class="note-line">割増率: 所定内 ×1.00 / 法定内残業 ×1.00 / 法定時間外 ×1.25(月60時間超は ×1.50)/ ' +
      '法定休日 ×1.35 / 深夜(22:00〜翌5:00)は +0.25 を加算</p>';
    html += '<p class="note-line">所定内は基本給に含まれている分の取り崩しとして ×1.00 で積み上げています。' +
      '実際に上乗せされる残業代は「基本給とは別の追加分」をご覧ください。</p>';
    html += '</div>';

    // --- 清算期間
    var remain = P.daysUntilClose(ctx.period, ctx.now);
    var closeLabel = ctx.period.end.getMonth() + 1 + '月' + ctx.period.end.getDate() + '日締め';
    html += '<div class="sec"><h3>清算期間</h3>';
    html += kv('対象期間', mdLabel(ctx.period.startKey) + ' 〜 ' + mdLabel(ctx.period.endKey));
    html += kv(closeLabel, remain === 0 ? '本日が締め日(速報値)' : 'あと ' + remain + '日(速報値)');
    html += kv('所定労働日数 / 総枠', agg.frames.scheduledWorkDays + '日 / ' + fmtHours(agg.frames.scheduledFrameMinutes));
    html += kv('法定労働時間の総枠', fmtHours(agg.frames.legalFrameMinutes));
    if (cmp) {
      html += kv('先月の同時点(' + cmp.elapsedDays + '日経過)',
        fmtYen(cmp.baseAmount) + ' / ' + fmtHours(cmp.baseMinutes), { money: true });
      html += kv('今月との差', fmtSignedYen(cmp.amountDiff) + ' / ' + fmtSignedMinutes(cmp.minutesDiff), { money: true });
    }
    html += '</div>';

    // --- 36協定の目安(SPEC 8.1)
    var otMinutes = b.statutoryOvertime.minutes + b.statutoryOvertimeOver60.minutes;
    var stats = A.agreement36Stats(store.history, {
      label: ctx.period.label,
      statutoryOvertimeHours: otMinutes / 60,
      legalHolidayHours: b.legalHoliday.minutes / 60,
    });
    var pct45 = Math.min(100, (otMinutes / WT.AGREEMENT_36.MONTHLY_GUIDE_MINUTES) * 100);
    html += '<div class="sec"><h3>36協定の目安(参考)</h3>';
    html += kv('今月の法定時間外', fmtHours(otMinutes));
    html += '<div class="bar"><i class="' + (otMinutes > WT.AGREEMENT_36.MONTHLY_GUIDE_MINUTES ? 'over' : '') +
      '" style="width:' + pct45.toFixed(1) + '%"></i></div>';
    html += '<p class="note-line">月45時間(原則上限)まで残り ' +
      fmtHours(Math.max(0, WT.AGREEMENT_36.MONTHLY_GUIDE_MINUTES - otMinutes)) +
      ' / 月60時間(割増率1.50に変わるライン)まで残り ' +
      fmtHours(Math.max(0, WT.OVER60_THRESHOLD_MINUTES - otMinutes)) + '</p>';
    html += kv('直近' + stats.monthsCounted + 'ヶ月の累計', stats.annualOvertimeHours.toFixed(1) + ' 時間');
    html += kv('月45時間超の回数', stats.over45Count + ' 回');
    for (var i = 0; i < stats.averages.length; i++) {
      html += kv('直近' + stats.averages[i].months + 'ヶ月平均(休日労働含む)', stats.averages[i].averageHours.toFixed(1) + ' 時間');
    }
    html += '<p class="note-line">正式な36協定の管理・届出は会社の勤怠システムで行われます。ここでの表示は参考情報です。</p>';
    html += '</div>';

    // --- 気づき(SPEC 8.2)
    var notices = [];
    var todayMinutes = todayTotal.workedMinutes;
    var todayDeducted = (live ? live.deductedMinutes : 0) + todayFinalizedDeduction();
    var bn = A.breakNotice(todayMinutes, todayDeducted);
    if (bn) {
      notices.push('本日は休憩の控除なしで' + bn.threshold + '時間を超えています(法定は' + bn.requiredMinutes + '分以上)。');
    }
    if (notices.length) {
      html += '<div class="sec"><h3>気づき</h3>';
      for (var n = 0; n < notices.length; n++) html += '<p class="note-line">' + notices[n] + '</p>';
      html += '</div>';
    }

    // --- 未入力日(SPEC 6.3: 催促はしない)
    html += '<div class="sec"><h3>未入力の日</h3>';
    if (!agg.unfilledDates.length) {
      html += '<p class="note-line">ありません。</p>';
    } else {
      var list = agg.unfilledDates.map(mdLabel).join('、');
      html += '<p class="note-line">' + agg.unfilledDates.length + '日(' + list +
        ')を、所定内 ' + s.dailyScheduledHours + '時間・残業なしとして自動加算しています。カレンダーから実際の時刻を追記できます(任意)。</p>';
    }
    html += '</div>';

    // --- 先月の確定合計
    if (ctx.prev) {
      var prevTotal = A.prefixTotals(ctx.prev.days, ctx.prev.period.start, 400);
      html += '<div class="sec"><h3>先月(確定)</h3>';
      html += kv(mdLabel(ctx.prev.period.startKey) + ' 〜 ' + mdLabel(ctx.prev.period.endKey),
        fmtYen(prevTotal.amount) + ' / ' + fmtHours(prevTotal.workedMinutes), { money: true });
      html += '</div>';
    }

    $('detailsBody').innerHTML = html;
  }

  function todayFinalizedDeduction() {
    var todayKey = T.dateKey(ctx.now);
    var sum = 0;
    for (var i = 0; i < ctx.agg.days.length; i++) {
      var d = ctx.agg.days[i];
      if (d.date === todayKey && d.kind === 'work') sum += d.deductedMinutes || 0;
    }
    return sum;
  }

  // ------------------------------------------------------------ 打刻操作

  /** 打刻の前にひとこと確認する(押し間違いを防ぐ) */
  var pendingConfirm = null;

  function askConfirm(message, onYes) {
    pendingConfirm = onYes;
    $('confirmText').textContent = message;
    var dlg = $('confirmDialog');
    if (!dlg.open) dlg.showModal();
  }

  function initConfirm() {
    $('confirmYes').addEventListener('click', function () {
      var fn = pendingConfirm;
      pendingConfirm = null;
      $('confirmDialog').close();
      if (fn) fn();
    });
    $('confirmNo').addEventListener('click', function () {
      pendingConfirm = null;
      $('confirmDialog').close();
    });
  }

  function afterPunch() {
    lastLogSavedAt = 0;
    heavy();
  }

  function initActions() {
    $('clockInBtn').addEventListener('click', function () {
      if (!requireSetup()) return;
      askConfirm('出勤しますか?', function () {
        store.clockIn(Date.now());
        afterPunch();
      });
    });

    $('clockOutBtn').addEventListener('click', function () {
      askConfirm('退勤しますか?', function () {
        store.clockOut(Date.now());
        afterPunch();
      });
    });

    $('breakBtn').addEventListener('click', function () {
      if (store.isOnManualBreak()) {
        askConfirm('休憩を終了しますか?', function () {
          store.endBreak(Date.now());
          afterPunch();
        });
      } else {
        askConfirm('休憩を開始しますか?', function () {
          store.startBreak(Date.now());
          afterPunch();
        });
      }
    });

    $('overtimeBtn').addEventListener('click', function () {
      if (!ctx || !ctx.active) return;
      if (!store.state.overtimeFlag) {
        askConfirm('残業を始めますか?(退勤予定時刻での自動確定を止めます)', function () {
          // 退勤予定時刻での自動確定を無効化するフラグを立てるだけ(SPEC 14)
          store.state.overtimeFlag = true;
          store.saveState();
          afterPunch();
        });
      } else {
        askConfirm('残業を終了しますか?', function () {
          var now = Date.now();
          store.endBreak(now);
          store.commitSession(ctx.active.startMs, now, ctx.active.isLegalHoliday, store.state.breaks);
          store.state.overtimeFlag = false;
          store.state.lastClockOutAt = now;
          store.state.breaks = [];
          store.saveState();
          afterPunch();
        });
      }
    });

    $('detailsPanel').addEventListener('toggle', function () { renderStatic(); });
  }

  /** 基本給が未登録なら設定画面へ誘導する(なぜ開いたのかを必ず伝える) */
  function requireSetup() {
    if (store.state.configured && store.settings.monthlyBaseSalary) return true;
    openSettings(true);
    flashHint('先に基本給を入力して「保存」を押してください。');
    return false;
  }

  // -------------------------------------------------------------- 設定

  /** 選択肢を流し込む。options は [{value, label}] */
  function fillSelect(id, options) {
    var html = '';
    for (var i = 0; i < options.length; i++) {
      html += '<option value="' + options[i].value + '">' + options[i].label + '</option>';
    }
    $(id).innerHTML = html;
  }

  /** 保存済みの値が選択肢に無ければ、その値を足してから選ぶ(古い設定を失わないため) */
  function setSelectValue(id, value) {
    var sel = $(id);
    var v = String(value);
    sel.value = v;
    if (sel.value !== v) {
      sel.innerHTML += '<option value="' + v + '">' + v + '</option>';
      sel.value = v;
    }
  }

  function hourLabel(hours) {
    var total = Math.round(hours * 60);
    var h = Math.floor(total / 60);
    var m = total % 60;
    return m === 0 ? h + '時間' : h + '時間' + m + '分';
  }

  /** 15分刻みの時刻の選択肢(00:00〜23:45) */
  function timeOptions() {
    var out = [];
    for (var m = 0; m < 24 * 60; m += 15) {
      var s = T.pad2(Math.floor(m / 60)) + ':' + T.pad2(m % 60);
      out.push({ value: s, label: s });
    }
    return out;
  }

  /** 画面のプルダウンから、いまの1日の所定労働時間を算出する */
  function formDailyHours() {
    var brk = { start: $('setBreakStart').value, end: $('setBreakEnd').value };
    return W.deriveDailyScheduledHours($('setScheduleStart').value, $('setScheduleEnd').value, brk);
  }

  /** 「1日の所定労働時間(自動計算)」の表示を更新する */
  function refreshDailyHours() {
    var hours = formDailyHours();
    $('setDailyHours').textContent = hours === null ? '-' : hourLabel(hours);
  }

  function initSettings() {
    // 金額(基本給)以外は、入力ではなくプルダウンから選ぶ
    var holidays = [];
    for (var d0 = 90; d0 <= 145; d0++) holidays.push({ value: d0, label: d0 + '日' });
    fillSelect('setAnnualHolidays', holidays);

    fillSelect('setBreakStart', timeOptions());
    fillSelect('setBreakEnd', timeOptions());
    fillSelect('setScheduleStart', timeOptions());
    fillSelect('setScheduleEnd', timeOptions());

    var closing = $('setClosingDay');
    var opts = '<option value="last">末日</option>';
    for (var i = 1; i <= 31; i++) opts += '<option value="' + i + '">' + i + '日</option>';
    closing.innerHTML = opts;

    var wd = $('setLegalWeekday');
    var wopts = '';
    for (var w = 0; w < WT.WEEKDAY_ORDER.length; w++) {
      var wday = WT.WEEKDAY_ORDER[w];
      wopts += '<option value="' + wday + '">' + WT.WEEKDAY_LABELS[wday] + '曜日</option>';
    }
    wd.innerHTML = wopts;

    var picker = $('setWorkdays');
    var phtml = '';
    for (var d = 0; d < WT.WEEKDAY_ORDER.length; d++) {
      var wday = WT.WEEKDAY_ORDER[d]; // 月曜始まりで並べる(値は 0=日 のまま)
      phtml += '<button type="button" data-day="' + wday + '">' + WT.WEEKDAY_LABELS[wday] + '</button>';
    }
    picker.innerHTML = phtml;
    picker.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-day]');
      if (!btn) return;
      btn.classList.toggle('is-on');
    });

    // 休憩の開始を選んだら、終了はその1時間後を入れておく(あとから変更可)
    $('setBreakStart').addEventListener('change', function () {
      var m = T.parseTimeToMinutes(this.value);
      if (m !== null) {
        var end = (m + 60) % (24 * 60);
        setSelectValue('setBreakEnd', T.pad2(Math.floor(end / 60)) + ':' + T.pad2(end % 60));
      }
      refreshDailyHours();
    });

    // 勤務時間・休憩終了を変えたら、所定労働時間の表示を追従させる
    ['setBreakEnd', 'setScheduleStart', 'setScheduleEnd'].forEach(function (id) {
      $(id).addEventListener('change', refreshDailyHours);
    });
    $('salaryEye').addEventListener('click', function () {
      var input = $('setSalary');
      input.type = input.type === 'password' ? 'text' : 'password';
      this.textContent = input.type === 'password' ? '表示' : '隠す';
    });
    $('saveSettingsBtn').addEventListener('click', saveSettingsFromForm);
    $('resetAllBtn').addEventListener('click', function () {
      if (!resetArmed) {
        resetArmed = true;
        this.textContent = 'もう一度押すと全部消えます';
        var self = this;
        setTimeout(function () { resetArmed = false; self.textContent = 'すべてのデータを消す'; }, 4000);
        return;
      }
      store.reset();
      location.reload();
    });
    $('openSettings').addEventListener('click', function () { openSettings(false); });
  }

  function openSettings(firstRun) {
    var dlg = $('settingsDialog');
    if (dlg.open) return;
    var s = store.settings;
    // 初回も2回目以降も同じ画面。メッセージ欄は入力に不備があるときだけ使う。
    $('firstRunNote').hidden = true;
    $('firstRunNote').textContent = '';
    $('settingsTitle').textContent = '設定';
    $('setSalary').value = s.monthlyBaseSalary == null ? '' : String(s.monthlyBaseSalary);
    $('setSalary').type = 'password';
    $('salaryEye').textContent = '表示';
    $('setSalary').placeholder = String(WT.BASE_SALARY_PLACEHOLDER);
    setSelectValue('setAnnualHolidays', s.annualHolidays);
    $('setClosingDay').value = String(s.closingDay);
    $('setLegalWeekday').value = String(s.legalHolidayWeekday);

    var btns = $('setWorkdays').querySelectorAll('button[data-day]');
    for (var i = 0; i < btns.length; i++) {
      var day = Number(btns[i].getAttribute('data-day'));
      btns[i].classList.toggle('is-on', s.workdays.indexOf(day) >= 0);
    }

    var brk = s.breakWindow || WT.DEFAULT_SETTINGS.breakWindow;
    setSelectValue('setBreakStart', brk.start);
    setSelectValue('setBreakEnd', brk.end);

    $('setAutoMode').checked = !!s.autoMode;
    setSelectValue('setScheduleStart', (s.schedule && s.schedule.start) || '09:00');
    setSelectValue('setScheduleEnd', (s.schedule && s.schedule.end) || '17:30');

    refreshDailyHours();
    dlg.showModal();
  }

  function saveSettingsFromForm() {
    var salary = Number(String($('setSalary').value).replace(/[^\d.]/g, ''));
    var daily = formDailyHours(); // 勤務時間 − 休憩 から自動算出
    var holidays = Number($('setAnnualHolidays').value);
    if (!(salary > 0)) { flashHint('基本給を入力してください。'); return; }
    if (!(daily > 0 && daily <= 24)) { flashHint('出勤時間・退勤時間・休憩時間を確認してください(所定労働時間が0になっています)。'); return; }
    if (!(holidays >= 0 && holidays < 365)) { flashHint('年間所定休日数を確認してください。'); return; }

    var workdays = [];
    var btns = $('setWorkdays').querySelectorAll('button[data-day].is-on');
    for (var i = 0; i < btns.length; i++) workdays.push(Number(btns[i].getAttribute('data-day')));
    if (!workdays.length) { flashHint('所定労働日の曜日を1つ以上選んでください。'); return; }
    workdays.sort();

    var closing = $('setClosingDay').value;
    var s = store.settings;
    s.monthlyBaseSalary = salary;
    s.dailyScheduledHours = daily;
    s.annualHolidays = holidays;
    s.closingDay = closing === 'last' ? 'last' : Number(closing);
    s.legalHolidayWeekday = Number($('setLegalWeekday').value);
    s.workdays = workdays;
    s.breakWindow = { start: $('setBreakStart').value || '12:00', end: $('setBreakEnd').value || '13:00' };
    s.autoMode = $('setAutoMode').checked;
    s.schedule = { start: $('setScheduleStart').value || '09:00', end: $('setScheduleEnd').value || '17:30' };

    store.saveSettings();
    store.state.configured = true;
    store.saveState();
    $('settingsDialog').close();
    lastLogSavedAt = 0;
    heavy();
  }

  /** 保存できなかった理由を、フォームの一番上に出す */
  function flashHint(msg) {
    var note = $('firstRunNote');
    note.hidden = false;
    note.textContent = msg;
    if (note.scrollIntoView) note.scrollIntoView({ block: 'start' });
  }

  // ---------------------------------------------------------- カレンダー

  function initCalendar() {
    var head = '';
    for (var i = 0; i < WT.WEEKDAY_ORDER.length; i++) {
      head += '<div class="cal-head-cell">' + WT.WEEKDAY_LABELS[WT.WEEKDAY_ORDER[i]] + '</div>';
    }
    $('calHead').innerHTML = head;

    $('openCalendar').addEventListener('click', function () {
      if (!requireSetup()) return;
      calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      renderCalendar();
      $('calendarDialog').showModal();
    });
    $('calPrev').addEventListener('click', function () {
      calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
      renderCalendar();
    });
    $('calNext').addEventListener('click', function () {
      calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
      renderCalendar();
    });
    $('calGrid').addEventListener('click', function (e) {
      var cell = e.target.closest('button[data-date]');
      if (!cell) return;
      openDayDialog(cell.getAttribute('data-date'));
    });
  }

  function renderCalendar() {
    var y = calMonth.getFullYear();
    var m = calMonth.getMonth();
    $('calTitle').textContent = y + '年' + (m + 1) + '月';

    var first = new Date(y, m, 1);
    var days = T.daysInMonth(y, m);
    var todayKey = T.dateKey(new Date());
    var period = ctx ? ctx.period : P.resolvePeriod(new Date(), store.settings.closingDay);

    // 週の始まりは WEEKDAY_ORDER の先頭(月曜)に合わせて空きマスを置く
    var leading = (first.getDay() - WT.WEEKDAY_ORDER[0] + 7) % 7;
    var html = '';
    for (var pad = 0; pad < leading; pad++) html += '<button class="cal-cell is-empty" disabled></button>';

    for (var d = 1; d <= days; d++) {
      var date = new Date(y, m, d);
      var key = T.dateKey(date);
      var entry = store.calendar[key];
      var cls = 'cal-cell';
      if (key === todayKey) cls += ' is-today';
      if (!P.containsDate(period, date)) cls += ' is-outside';

      var mark = '';
      if (entry && (entry.clockIn || entry.coveredBy)) mark = 'work';
      else if (entry && entry.type === 'paid_leave') mark = 'leave';
      else if (entry && entry.type === 'company_holiday') mark = entry.holidayKind === 'legal' ? 'legal' : 'scheduled';
      else if (key < todayKey && A.isScheduledWorkDay(date, store.settings, store.calendar)) mark = 'auto';
      else if (!A.isScheduledWorkDay(date, store.settings, store.calendar)) {
        mark = A.judgeLegalHoliday(date, store.settings, store.calendar) ? 'legal' : 'scheduled';
      }

      html += '<button class="' + cls + '" data-date="' + key + '"><span>' + d +
        '</span><span class="mk ' + mark + '"></span></button>';
    }
    $('calGrid').innerHTML = html;
  }

  // ------------------------------------------------------------ 日の編集

  function initDayDialog() {
    $('dayKind').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-kind]');
      if (!btn) return;
      selectSeg($('dayKind'), btn);
      syncDayRows();
    });
    $('dayHolidayKind').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-holiday]');
      if (!btn) return;
      selectSeg($('dayHolidayKind'), btn);
    });
    $('dayCancel').addEventListener('click', function () { $('dayDialog').close(); });
    $('daySave').addEventListener('click', saveDayDialog);
  }

  function selectSeg(container, btn) {
    var all = container.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('is-on');
    btn.classList.add('is-on');
  }

  function segValue(container, attr) {
    var on = container.querySelector('button.is-on');
    return on ? on.getAttribute(attr) : null;
  }

  function openDayDialog(key) {
    editingDayKey = key;
    var date = T.parseDateKey(key);
    var entry = store.calendar[key] || null;
    $('dayTitle').textContent = date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate() +
      '(' + WT.WEEKDAY_LABELS[date.getDay()] + ')';

    var kind = 'none';
    if (entry && entry.clockIn) kind = 'work';
    else if (entry && entry.type === 'paid_leave') kind = 'paid_leave';
    else if (entry && entry.type === 'company_holiday') kind = 'company_holiday';

    var kindBtns = $('dayKind').querySelectorAll('button[data-kind]');
    for (var i = 0; i < kindBtns.length; i++) {
      kindBtns[i].classList.toggle('is-on', kindBtns[i].getAttribute('data-kind') === kind);
    }

    var hk = entry && entry.holidayKind ? entry.holidayKind
      : (A.judgeLegalHoliday(date, store.settings, store.calendar) ? 'legal' : 'scheduled');
    var hkBtns = $('dayHolidayKind').querySelectorAll('button[data-holiday]');
    for (var j = 0; j < hkBtns.length; j++) {
      hkBtns[j].classList.toggle('is-on', hkBtns[j].getAttribute('data-holiday') === hk);
    }

    if (entry && entry.clockIn) {
      $('dayIn').value = hhmm(entry.clockIn);
      $('dayOut').value = entry.clockOut ? hhmm(entry.clockOut) : '';
      $('dayOvernight').checked = !!entry.clockOut && T.dateKey(new Date(entry.clockOut)) !== key;
      $('dayIsLegalHoliday').checked = !!entry.isLegalHoliday;
    } else {
      var sc = store.settings.schedule || {};
      $('dayIn').value = sc.start || '09:00';
      $('dayOut').value = sc.end || '17:30';
      $('dayOvernight').checked = false;
      $('dayIsLegalHoliday').checked = A.judgeLegalHoliday(date, store.settings, store.calendar);
    }

    var isPast = key < T.dateKey(new Date());
    var scheduled = A.isScheduledWorkDay(date, store.settings, store.calendar);
    $('dayNote').textContent = !entry && isPast && scheduled
      ? '未入力のため、所定内 ' + store.settings.dailyScheduledHours + '時間・残業なしとして自動加算しています。追記は任意です。'
      : '';

    syncDayRows();
    $('dayDialog').showModal();
  }

  function syncDayRows() {
    var kind = segValue($('dayKind'), 'data-kind');
    $('dayWorkRow').hidden = kind !== 'work';
    $('dayHolidayRow').hidden = kind !== 'company_holiday';
  }

  function saveDayDialog() {
    var key = editingDayKey;
    var kind = segValue($('dayKind'), 'data-kind');
    var date = T.parseDateKey(key);

    if (kind === 'none') {
      store.setDay(key, null);
    } else if (kind === 'paid_leave') {
      store.setDay(key, { type: 'paid_leave' });
    } else if (kind === 'company_holiday') {
      store.setDay(key, { type: 'company_holiday', holidayKind: segValue($('dayHolidayKind'), 'data-holiday') || 'scheduled' });
    } else {
      var inMin = T.parseTimeToMinutes($('dayIn').value);
      var outMin = T.parseTimeToMinutes($('dayOut').value);
      if (inMin === null || outMin === null) { $('dayNote').textContent = '出勤・退勤の時刻を入力してください。'; return; }
      var startMs = T.timeOnDate(date, inMin);
      var endMs = T.timeOnDate(date, outMin);
      if ($('dayOvernight').checked || endMs <= startMs) endMs += T.MS_PER_DAY;
      store.setDay(key, null);
      store.commitSession(startMs, endMs, $('dayIsLegalHoliday').checked);
    }

    $('dayDialog').close();
    renderCalendar();
    lastLogSavedAt = 0;
    heavy();
  }

  // -------------------------------------------------------------- 起動

  function boot() {
    store.load();
    initTheme();
    buildGauge();
    initConfirm();
    initActions();
    initSettings();
    initCalendar();
    initDayDialog();

    if (!store.state.configured || !store.settings.monthlyBaseSalary) {
      openSettings(true);
    }

    heavy();
    setInterval(heavy, 1000);
    requestAnimationFrame(renderFrame);

    // タブに戻ったときは、経過時間を取り直す(ぼかしは維持したまま)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) heavy();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})((globalThis.WT = globalThis.WT || {}));
