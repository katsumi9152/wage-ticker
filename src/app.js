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

  /** いま実際に表示している方(選択が無ければ常に 'light'。initTheme と一致させる)。 */
  function currentTheme() {
    var saved = null;
    try { saved = globalThis.localStorage ? globalThis.localStorage.getItem(THEME_KEY) : null; } catch (e) { saved = null; }
    return saved === 'dark' ? 'dark' : 'light';
  }

  function initTheme() {
    // 明示的に選んだことが無ければ、端末の設定(ダークモード)に関わらずライトで開く。
    // 保存はしない(端末側のダーク設定が変わっても、選ぶまでは常にライトから始まる)。
    var saved = null;
    try { saved = globalThis.localStorage ? globalThis.localStorage.getItem(THEME_KEY) : null; } catch (e) { saved = null; }
    applyTheme(saved || 'light');
    $('themeToggle').addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      try { globalThis.localStorage.setItem(THEME_KEY, next); } catch (e) { /* noop */ }
      applyTheme(next);
    });
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

    var prevLastClockOutAt = store.state.lastClockOutAt;
    var autoInfo = WT.storage.resolveAutoMode(store, now.getTime());
    var active = activeSessionOf(settings, autoInfo);

    // 自動モードが「いままさに」自動確定した瞬間だけを検出して、法定休憩の
    // 自動追加控除があればお知らせする(resolveAutoMode は既に確定済みの日にも
    // 毎回 finalized:true を返すが、その場合は lastClockOutAt を書き換えないので
    // 区別できる)
    if (settings.autoMode && autoInfo.finalized && store.state.lastClockOutAt !== prevLastClockOutAt) {
      notifyIfLegalBreakToppedUp(T.dateKey(new Date(store.state.lastClockOutAt)));
    }

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
    var weekSummary = A.weekSummary(ctx.agg.days, ctx.now, ctx.settings, store.calendar);
    var weekTotal = W.cloneBreakdown(weekSummary.totals);
    if (live) {
      W.addBreakdown(monthTotal, live.breakdown);
      W.addBreakdown(weekTotal, live.breakdown); // 今日は必ず今週に含まれる
    }

    $('weekAmount').textContent = fmtYen(weekTotal.amount);
    $('weekSub').textContent = fmtHours(weekTotal.workedMinutes) + ' / ' + fmtHours(weekSummary.scheduledMinutes);
    $('monthAmount').textContent = fmtYen(monthTotal.amount);
    $('monthSub').textContent = fmtHours(monthTotal.workedMinutes) +
      ' / ' + fmtHours(ctx.agg.frames.scheduledFrameMinutes);

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

    renderVisibility();
    renderOvertime(monthTotal);
    renderCompare(monthTotal, ctx.prev
      ? A.prefixTotals(ctx.prev.days, ctx.prev.period.start, P.elapsedDays(ctx.period, ctx.now))
      : null);
    renderStatus(live);
    renderActions();
    if ($('detailsPanel').open) renderDetails(monthTotal, live, cmp);
  }

  /** 「今週」「今月」「今月の残業」「先月との比較」は設定で隠せる。今週/今月は片方だけなら横幅いっぱいに広げる。 */
  function renderVisibility() {
    var showWeek = ctx.settings.showWeek !== false;
    var showMonth = ctx.settings.showMonth !== false;
    $('weekCard').hidden = !showWeek;
    $('monthCard').hidden = !showMonth;
    $('statsSection').hidden = !showWeek && !showMonth;
    $('statsSection').classList.toggle('is-single', showWeek !== showMonth);
    $('otCard').hidden = ctx.settings.showOvertime === false;
    $('compareCard').hidden = ctx.settings.showCompare === false;
  }

  /**
   * 今月の法定時間外と、45時間・60時間までの残り。
   * 45時間は36協定の原則上限、60時間は割増率が 1.25 → 1.50 に変わるライン。
   */
  function renderOvertime(monthTotal) {
    var otMinutes = monthTotal.statutoryOvertime.minutes + monthTotal.statutoryOvertimeOver60.minutes;
    var fixedMin = Number(ctx.settings.fixedOvertimeHours || 0) * 60;
    var m = A.overtimeMeter(otMinutes, fixedMin);
    var pct = function (v) { return v.toFixed(1) + '%'; };

    $('otNow').textContent = fmtHours(otMinutes) + (m.over60 ? '(60時間超過)' : '');
    $('otFill').style.width = pct(m.fillPercent);
    $('otMark45').style.left = pct(m.mark45Percent);
    $('otMark60').style.left = pct(m.mark60Percent);

    var labels = '<span style="left:0%">0</span>' +
      '<span style="left:' + pct(m.mark45Percent) + '">45h</span>' +
      '<span class="is-end" style="left:' + pct(m.mark60Percent) + '">60h</span>';
    if (m.fixedPercent !== null) {
      $('otMarkFixed').hidden = false;
      $('otMarkFixed').style.left = pct(m.fixedPercent);
      labels = '<span class="is-fixed" style="left:' + pct(m.fixedPercent) + '">固定' +
        ctx.settings.fixedOvertimeHours + 'h</span>' + labels;
    } else {
      $('otMarkFixed').hidden = true;
    }
    $('otMarkLabels').innerHTML = labels;

    var meter = $('otMeter');
    meter.classList.toggle('over-45', m.over45);
    meter.classList.toggle('over-60', m.over60);
  }

  /**
   * 先月との比較(同じ経過日数時点)を横棒で見せる。金額は出さず時間だけ。
   * 通常 = 所定内、残業 = 法定内残業 + 法定時間外 + 法定休日。
   */
  function renderCompare(monthTotal, prevTotal) {
    function split(b) {
      if (!b) return { normal: 0, ot: 0, total: 0 };
      var normal = b.scheduledInside.minutes;
      var ot = b.legalInsideOvertime.minutes + b.statutoryOvertime.minutes +
        b.statutoryOvertimeOver60.minutes + b.legalHoliday.minutes;
      return { normal: normal, ot: ot, total: normal + ot };
    }
    var now = split(monthTotal);
    var prev = split(prevTotal);
    var max = Math.max(now.total, prev.total, 1);
    var pct = function (v) { return ((v / max) * 100).toFixed(1) + '%'; };

    $('cmpNowNormal').style.width = pct(now.normal);
    $('cmpNowOt').style.width = pct(now.ot);
    $('cmpPrevNormal').style.width = pct(prev.normal);
    $('cmpPrevOt').style.width = pct(prev.ot);
    $('cmpNowTotal').textContent = fmtHours(now.total);
    $('cmpPrevTotal').textContent = fmtHours(prev.total);
    $('cmpNote').textContent = prevTotal ? '' : '先月の記録がたまると比べられます';
  }

  /** 状態バッジ。待機中/勤務中/休憩中/昼休憩中/残業中/自動計測中を色でも見分けられるようにする。 */
  function renderStatus(live) {
    var badge = $('statusBadge');
    var working = !!ctx.active;
    var text, state;

    if (!store.state.configured) {
      text = '未設定'; state = 'idle';
    } else if (!working) {
      text = '待機中'; state = 'idle';
    } else if (live && live.onBreak) {
      // 手動の休憩とたまたま重なっていれば、押した操作を優先して「休憩中」にする
      text = store.isOnManualBreak() ? '休憩中' : '昼休憩中';
      state = 'break';
    } else if (ctx.active.manual) {
      text = '勤務中'; state = 'working'; // 手動の打刻が優先されている
    } else if (ctx.settings.autoMode && store.state.overtimeFlag) {
      text = '残業中'; state = 'auto';
    } else if (ctx.settings.autoMode) {
      text = '自動計測中'; state = 'auto';
    } else {
      text = '勤務中'; state = 'working';
    }

    $('statusText').textContent = text;
    badge.classList.toggle('is-working', state === 'working');
    badge.classList.toggle('is-break', state === 'break');
    badge.classList.toggle('is-auto', state === 'auto');
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
    // 確定済みの日は「退勤時刻の更新」ができるので押せるままにする
    outBtn.disabled = !working && !store.isFinishedToday(Date.now());
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

  function setLiveInt(text) {
    $('liveInt').textContent = text;
  }

  /** 秒単位の描画。ここでは軽い計算しかしない(SPEC 14)。 */
  function renderFrame() {
    if (ctx) {
      var live = currentLive(Date.now());
      var hero = $('heroCard');
      if (live) {
        var parts = fmtYenParts(live.breakdown.amount);
        setLiveInt(parts.int);
        $('liveDec').textContent = parts.dec;
        $('tickerLabel').textContent = ctx.settings.autoMode ? '今日の勤務(自動)' : '今日の勤務';
        $('liveMeta').textContent = liveMetaText(live);
        hero.classList.add('is-live');
        setTone(hero, live);
        $('rateStrip').textContent = rateLabel(live);
      } else {
        var last = lastSessionAmount();
        var p2 = fmtYenParts(last.amount);
        setLiveInt(p2.int);
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
    if (live.deductedMinutes > 0) txt += ' / 休憩 ' + fmtHours(live.deductedMinutes);
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
      label: '今日の勤務',
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
    return label + ' × ' + live.marginal.rate.toFixed(2);
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

  /** 固定残業代が足りているかを見るときの割増率(法定時間外の下限) */
  var RATE_OT = WT.RATE.STATUTORY_OVERTIME;

  /** 「残り 3:20」または「超過 1:10」 */
  function remainLabel(remainMinutes) {
    return remainMinutes > 0 ? '残り ' + fmtHours(remainMinutes) : '超過 ' + fmtHours(-remainMinutes);
  }

  function kv(k, v, opts) {
    var o = opts || {};
    return '<div class="kv' + (o.zero ? ' is-zero' : '') + '"><span class="k">' + k +
      '</span><span class="v' + (o.money ? ' money' : '') + '">' + v + '</span></div>';
  }

  function renderDetails(monthTotal, live, cmp) {
    var s = ctx.settings;
    var agg = ctx.agg;
    var html = '';

    // --- 内訳
    var b = monthTotal;
    html += '<div class="sec"><h3>今月の内訳</h3>';
    html += kv('所定内(基本給ぶん)', fmtHours(b.scheduledInside.minutes) + ' / ' + fmtYen(b.scheduledInside.amount), { money: true, zero: b.scheduledInside.minutes === 0 });
    html += kv('法定内残業 × 1.00', fmtHours(b.legalInsideOvertime.minutes) + ' / ' + fmtYen(b.legalInsideOvertime.amount), { money: true, zero: b.legalInsideOvertime.minutes === 0 });
    html += kv('固定残業でカバー', fmtHours(b.fixedOvertime.minutes) + ' / ' + fmtYen(b.fixedOvertime.amount), { money: true, zero: b.fixedOvertime.minutes === 0 });
    html += kv('法定時間外 × 1.25', fmtHours(b.statutoryOvertime.minutes) + ' / ' + fmtYen(b.statutoryOvertime.amount), { money: true, zero: b.statutoryOvertime.minutes === 0 });
    html += kv('法定時間外 × 1.50(60h超)', fmtHours(b.statutoryOvertimeOver60.minutes) + ' / ' + fmtYen(b.statutoryOvertimeOver60.amount), { money: true, zero: b.statutoryOvertimeOver60.minutes === 0 });
    html += kv('法定休日 × 1.35', fmtHours(b.legalHoliday.minutes) + ' / ' + fmtYen(b.legalHoliday.amount), { money: true, zero: b.legalHoliday.minutes === 0 });
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
    html += '<p class="note-line">割増率: 所定内 × 1.00 / 法定内残業 × 1.00 / 法定時間外 × 1.25(月60時間超は × 1.50)/ ' +
      '法定休日 × 1.35 / 深夜(22:00〜翌5:00)は +0.25 を加算</p>';
    html += '<p class="note-line">所定内は基本給に含まれている分の取り崩しとして × 1.00 で積み上げています。' +
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
    // 所定の総枠が法定の総枠を超える設定は、通常ありえない(設定の取り違えを疑う)
    if (agg.frames.scheduledFrameMinutes > agg.frames.legalFrameMinutes) {
      html += '<p class="note-line">所定労働時間の総枠が、法定労働時間の総枠を超えています。' +
        '出勤・退勤の時間、休憩、所定労働日の曜日の設定をご確認ください。</p>';
    }
    if (cmp) {
      html += kv('先月の同時点(' + cmp.elapsedDays + '日経過)',
        fmtYen(cmp.baseAmount) + ' / ' + fmtHours(cmp.baseMinutes), { money: true });
      html += kv('今月との差', fmtSignedYen(cmp.amountDiff) + ' / ' + fmtSignedMinutes(cmp.minutesDiff), { money: true });
    }
    html += '</div>';

    // --- 残業時間の目安(SPEC 8.1)。今月ぶんの時間だけを見せる。
    var otMinutes = b.statutoryOvertime.minutes + b.statutoryOvertimeOver60.minutes;
    html += '<div class="sec"><h3>残業時間の目安(参考)</h3>';
    html += kv('今月の法定時間外', fmtHours(otMinutes));
    html += kv('月45時間(36協定の原則上限)まで', remainLabel(WT.AGREEMENT_36.MONTHLY_GUIDE_MINUTES - otMinutes));
    html += kv('月60時間(割増率が1.50に変わる)まで', remainLabel(WT.OVER60_THRESHOLD_MINUTES - otMinutes));
    // 単月100時間未満は、特別条項があっても超えられない法律上の上限(休日労働を含む)
    var singleMonthMinutes = otMinutes + b.legalHoliday.minutes;
    html += kv('単月100時間(休日労働を含む)まで',
      remainLabel(WT.AGREEMENT_36.MONTHLY_HARD_MINUTES - singleMonthMinutes));
    // 固定残業代が、その時間ぶんの割増賃金額を下回っていないか(下回る定めは無効)
    var fixedMinutes = Number(s.fixedOvertimeHours || 0) * 60;
    if (fixedMinutes > 0) {
      var required = (fixedMinutes / 60) * RATE_OT * agg.rates.baseHourlyRate;
      var allowance = Number(s.fixedOvertimeAllowance || 0);
      html += kv('固定残業の消化', fmtHours(Math.min(otMinutes, fixedMinutes)) + ' / ' + fmtHours(fixedMinutes));
      html += kv('固定残業代', fmtYen(allowance) + ' / ' + s.fixedOvertimeHours + '時間ぶん', { money: true });
      if (allowance < required - 1) {
        html += '<p class="note-line">固定残業代が、' + s.fixedOvertimeHours +
          '時間ぶんの割増賃金額(' + fmtYen(required) + ')を下回っています。設定の見直しか、会社の給与規程の確認をおすすめします。</p>';
      }
    }
    html += '<p class="note-line">年間の累計や「月45時間超が年に何回か」といった管理は、会社の勤怠システムが行うものです。ここでは今月ぶんの時間だけを目安として出しています。</p>';
    html += '</div>';

    // --- 気づき(SPEC 8.2)
    var notices = [];
    // 徹夜勤務は始業日の労働として通算する。丸1日を超えたら押し忘れの可能性が高い。
    if (live && live.rawMinutes > 24 * 60) {
      notices.push('出勤から ' + T.formatMinutesJa(live.rawMinutes) +
        ' 続いています。退勤の押し忘れかもしれません(カレンダーから実際の時刻に直せます)。');
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

  /** 打刻の確認とは別の、OKボタンのみの通知ダイアログ */
  function showInfo(message) {
    $('infoText').textContent = message;
    var dlg = $('infoDialog');
    if (!dlg.open) dlg.showModal();
  }

  function initInfo() {
    $('infoOk').addEventListener('click', function () {
      $('infoDialog').close();
    });
  }

  /**
   * dateKey の日の確定済み打刻を読み直し、法定休憩の自動追加控除
   * (wage.sessionWork の legalBreakToppedUpMinutes)が発生していれば知らせる。
   */
  function notifyIfLegalBreakToppedUp(dateKey) {
    var entry = store.calendar[dateKey];
    if (!entry || !entry.clockIn || !entry.clockOut) return;
    var work = W.sessionWork(entry.clockIn, entry.clockOut, store.settings.breakWindow, entry.breaks);
    if (work.legalBreakToppedUpMinutes > 0) {
      showInfo('本日は休憩の控除が法定基準(実働6時間超で45分・8時間超で60分)に届いていなかったため、' +
        T.formatMinutesJa(work.legalBreakToppedUpMinutes) + '分を自動で追加控除しました(退勤時刻の直前から差し引いています)。');
    }
  }

  function afterPunch() {
    lastLogSavedAt = 0;
    heavy();
  }

  function initActions() {
    $('clockInBtn').addEventListener('click', function () {
      if (!requireSetup()) return;
      // 同じ日に2回目の出勤は「再開」。退勤からいままでは休憩になる。
      var resuming = store.isFinishedToday(Date.now());
      var msg = resuming ? '勤務を再開しますか?(退勤からいままでは休憩になります)' : '出勤しますか?';
      // 自動モード中に手動で出勤すると、以後は自動確定の対象から外れる(SPEC 5.3)。
      // 退勤予定時刻を過ぎても勝手には終わらないので、その場で注意しておく。
      if (ctx.settings.autoMode) {
        msg += '(以後は手動扱いになり、退勤予定時刻でも自動的には終わりません。退勤は自分で押してください)';
      }
      askConfirm(msg, function () {
        store.clockIn(Date.now());
        afterPunch();
      });
    });

    $('clockOutBtn').addEventListener('click', function () {
      // すでに確定済みの日なら、退勤時刻を「いま」に更新する
      var updating = store.state.status !== 'working' && store.isFinishedToday(Date.now());
      var msg = updating ? '退勤時刻を、いまの時刻に更新しますか?' : '退勤しますか?';
      askConfirm(msg, function () {
        // clockOut() で state.clockInAt が null にリセットされる前に、対象日を確定しておく
        var wasWorkingStartMs = store.state.status === 'working' ? store.state.clockInAt : null;
        var nowMs = Date.now();
        store.clockOut(nowMs);
        afterPunch();

        var entryKey = wasWorkingStartMs
          ? T.dateKey(new Date(wasWorkingStartMs))
          : T.dateKey(new Date(nowMs)); // storage.js の「確定済み当日の更新」分岐と同じ規則
        notifyIfLegalBreakToppedUp(entryKey);
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

    var fixedHours = [{ value: 0, label: 'なし' }];
    for (var fh = 5; fh <= 80; fh += 5) fixedHours.push({ value: fh, label: fh + '時間' });
    fillSelect('setFixedHours', fixedHours);

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
    $('setFixedAllowance').value = Number(s.fixedOvertimeAllowance || 0) || '';
    setSelectValue('setFixedHours', Number(s.fixedOvertimeHours || 0));
    setSelectValue('setAnnualHolidays', s.annualHolidays);
    $('setClosingDay').value = String(s.closingDay);
    $('setLegalWeekday').value = String(s.legalHolidayWeekday);

    var btns = $('setWorkdays').querySelectorAll('button[data-day]');
    for (var i = 0; i < btns.length; i++) {
      var day = Number(btns[i].getAttribute('data-day'));
      btns[i].classList.toggle('is-on', s.workdays.indexOf(day) >= 0);
    }

    $('setObserveHolidays').checked = s.observeNationalHolidays !== false;

    var brk = s.breakWindow || WT.DEFAULT_SETTINGS.breakWindow;
    setSelectValue('setBreakStart', brk.start);
    setSelectValue('setBreakEnd', brk.end);

    $('setShowWeek').checked = s.showWeek !== false;
    $('setShowMonth').checked = s.showMonth !== false;
    $('setShowOvertime').checked = s.showOvertime !== false;
    $('setShowCompare').checked = s.showCompare !== false;
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
    s.fixedOvertimeAllowance = Math.max(0, Number(String($('setFixedAllowance').value).replace(/[^\d.]/g, '')) || 0);
    s.fixedOvertimeHours = Number($('setFixedHours').value) || 0;
    s.observeNationalHolidays = $('setObserveHolidays').checked;
    s.showWeek = $('setShowWeek').checked;
    s.showMonth = $('setShowMonth').checked;
    s.showOvertime = $('setShowOvertime').checked;
    s.showCompare = $('setShowCompare').checked;
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
      calMonth = clampCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1));
      renderCalendar();
    });
    $('calNext').addEventListener('click', function () {
      calMonth = clampCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1));
      renderCalendar();
    });
    $('calGrid').addEventListener('click', function (e) {
      var cell = e.target.closest('button[data-date]');
      if (!cell) return;
      openDayDialog(cell.getAttribute('data-date'));
    });
  }

  /**
   * 表示できる月の範囲。詳細な記録を持つのが今月と先月なので過去は1ヶ月、
   * 予定を先に入れられるよう未来は3ヶ月まで(合計5ヶ月)。
   */
  var CAL_MONTHS_BACK = 1;
  var CAL_MONTHS_AHEAD = 3;

  function calBounds() {
    var t = new Date();
    return {
      min: new Date(t.getFullYear(), t.getMonth() - CAL_MONTHS_BACK, 1),
      max: new Date(t.getFullYear(), t.getMonth() + CAL_MONTHS_AHEAD, 1),
    };
  }

  function clampCalMonth(d) {
    var b = calBounds();
    if (d.getTime() < b.min.getTime()) return b.min;
    if (d.getTime() > b.max.getTime()) return b.max;
    return d;
  }

  function renderCalendar() {
    calMonth = clampCalMonth(calMonth);
    var y = calMonth.getFullYear();
    var m = calMonth.getMonth();
    var bounds = calBounds();
    $('calTitle').textContent = y + '年' + (m + 1) + '月';
    $('calPrev').disabled = calMonth.getTime() <= bounds.min.getTime();
    $('calNext').disabled = calMonth.getTime() >= bounds.max.getTime();

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
        if (A.judgeLegalHoliday(date, store.settings, store.calendar)) mark = 'legal';
        else if (store.settings.observeNationalHolidays !== false && WT.holidays.isNationalHoliday(date)) mark = 'holiday';
        else mark = 'scheduled';
      }

      html += '<button class="' + cls + '" data-date="' + key + '"><span>' + d +
        '</span><span class="mk ' + mark + '"></span></button>';
    }
    $('calGrid').innerHTML = html;
  }

  // ------------------------------------------------------------ 日の編集

  /** 休憩1件ぶんの入力行 */
  function breakRowHtml(start, end) {
    return '<div class="brk-row">' +
      '<input type="time" class="brk-start" value="' + start + '">' +
      '<span class="tilde">〜</span>' +
      '<input type="time" class="brk-end" value="' + end + '">' +
      '<button type="button" class="icon-btn brk-del" aria-label="この休憩を削除">×</button>' +
      '</div>';
  }

  function renderDayBreaks(breaks) {
    var html = '';
    for (var i = 0; i < (breaks || []).length; i++) {
      var b = breaks[i];
      if (!b || !b.start) continue;
      html += breakRowHtml(hhmm(b.start), b.end ? hhmm(b.end) : hhmm(b.start));
    }
    $('dayBreaks').innerHTML = html;
  }

  /** 入力行から休憩の配列を作る。時刻は勤務区間の中に収まるよう日付を合わせる。 */
  function collectDayBreaks(dayDate, startMs, endMs) {
    var out = [];
    var rows = $('dayBreaks').querySelectorAll ? $('dayBreaks').querySelectorAll('.brk-row') : [];
    for (var i = 0; i < rows.length; i++) {
      var s = T.parseTimeToMinutes(rows[i].querySelector('.brk-start').value);
      var e = T.parseTimeToMinutes(rows[i].querySelector('.brk-end').value);
      if (s === null || e === null) continue;
      var bs = T.timeOnDate(dayDate, s);
      var be = T.timeOnDate(dayDate, e);
      if (bs < startMs) bs += T.MS_PER_DAY; // 日をまたぐ勤務の後半に入れた休憩
      if (be <= bs) be += T.MS_PER_DAY;
      if (bs >= startMs && be <= endMs && be > bs) out.push({ start: bs, end: be });
    }
    return out;
  }

  function initDayDialog() {
    $('dayBreakAdd').addEventListener('click', function () {
      $('dayBreaks').innerHTML += breakRowHtml($('dayIn').value || '12:00', $('dayOut').value || '13:00');
    });
    $('dayBreaks').addEventListener('click', function (e) {
      var del = e.target.closest('.brk-del');
      if (del && del.parentNode) del.parentNode.remove();
    });
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
    /*
     * dayDialog はカレンダーの上に重ねて開く(2重 showModal)と、
     * 環境によっては閉じたあとカレンダー側がオーバーレイとして
     * 描画されなくなり、本文の下に張り付いたまま消えなくなることがある。
     * カレンダーを一旦閉じてから開き、dayDialog が閉じたら再表示する。
     */
    $('dayDialog').addEventListener('close', function () {
      renderCalendar();
      $('calendarDialog').showModal();
    });
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
    renderDayBreaks(entry && entry.breaks);

    var isPast = key < T.dateKey(new Date());
    var scheduled = A.isScheduledWorkDay(date, store.settings, store.calendar);
    var holiday = store.settings.observeNationalHolidays !== false ? WT.holidays.isNationalHoliday(date) : null;
    if (holiday) {
      $('dayNote').textContent = 'この日は「' + holiday.name + '」です。' +
        (entry ? '' : '所定休日として総枠から除外しています。出勤した場合はここから記録できます。');
    } else if (!entry && isPast && scheduled) {
      $('dayNote').textContent = '未入力のため、所定内 ' + store.settings.dailyScheduledHours + '時間・残業なしとして自動加算しています。追記は任意です。';
    } else {
      $('dayNote').textContent = '';
    }

    syncDayRows();
    $('calendarDialog').close();
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
      var breaks = collectDayBreaks(date, startMs, endMs);
      store.setDay(key, null);
      store.commitSession(startMs, endMs, $('dayIsLegalHoliday').checked, breaks);
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
    initConfirm();
    initInfo();
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
