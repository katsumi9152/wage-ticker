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
  /** 覗き見防止の表示状態(SPEC 11: 永続化しない・常にぼかしから始まる) */
  var reveal = { on: false, timer: null, holding: false, downAt: 0 };
  var idleTimer = null;
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

  // ------------------------------------------------------ 覗き見防止(11章)

  function applyReveal() {
    var masked = !reveal.on;
    var nodes = document.querySelectorAll('.amount, .diff, .kv .v.money');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('is-masked', masked);
    }
    $('eyeBtn').classList.toggle('is-on', reveal.on);
  }

  function setReveal(on, autoHideMs) {
    reveal.on = on;
    if (reveal.timer) { clearTimeout(reveal.timer); reveal.timer = null; }
    if (on && autoHideMs) {
      reveal.timer = setTimeout(function () { setReveal(false); }, autoHideMs);
    }
    applyReveal();
  }

  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { setReveal(false); }, 60000);
  }

  function initPrivacy() {
    var eye = $('eyeBtn');
    // 押している間だけ表示 / 短いタップなら数秒だけ表示(SPEC 11)
    eye.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      reveal.holding = true;
      reveal.downAt = Date.now();
      setReveal(true);
    });
    var release = function () {
      if (!reveal.holding) return;
      reveal.holding = false;
      if (Date.now() - reveal.downAt < 300) {
        setReveal(true, 5000);
      } else {
        setReveal(false);
      }
    };
    eye.addEventListener('pointerup', release);
    eye.addEventListener('pointercancel', release);
    eye.addEventListener('pointerleave', release);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) setReveal(false);
    });
    window.addEventListener('blur', function () { setReveal(false); });
    window.addEventListener('pagehide', function () { setReveal(false); });
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, bumpIdle, { passive: true });
    });
    bumpIdle();
  }

  // ------------------------------------------------------------ 集計処理

  function activeSessionOf(settings, autoInfo) {
    if (settings.autoMode) return autoInfo.active;
    if (store.state.status === 'working' && store.state.clockInAt) {
      return { startMs: store.state.clockInAt, isLegalHoliday: !!store.state.isLegalHoliday };
    }
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
      diffEl.textContent = '先月同時点 ' + fmtSignedYen(cmp.amountDiff);
      diffEl.classList.toggle('is-plus', cmp.amountDiff >= 0);
      diffEl.classList.toggle('is-minus', cmp.amountDiff < 0);
    } else {
      diffEl.hidden = true;
    }

    renderStatus(live);
    renderActions();
    if ($('detailsPanel').open) renderDetails(monthTotal, todayTotal, live, cmp);
    applyReveal();
  }

  function renderStatus(live) {
    var badge = $('statusBadge');
    var working = !!ctx.active;
    badge.classList.toggle('is-working', working);
    var text;
    if (!store.state.configured) text = '未設定';
    else if (!working) text = '待機中';
    else if (live && live.onBreak) text = '休憩中';
    else text = ctx.settings.autoMode ? '自動計測中' : '勤務中';
    $('statusText').textContent = text;
    $('detailsPanel').classList.toggle('is-working', working);
  }

  function renderActions() {
    var auto = ctx.settings.autoMode;
    var inBtn = $('clockInBtn');
    var outBtn = $('clockOutBtn');
    var otBtn = $('overtimeBtn');

    inBtn.hidden = auto;
    outBtn.hidden = auto;
    otBtn.hidden = !auto;

    if (!auto) {
      var working = store.state.status === 'working';
      inBtn.disabled = working;
      outBtn.disabled = !working;
      return;
    }

    // 自動モード: 勤務時間中だけ「残業開始」、押した後は「残業終了」(SPEC 5.3)
    if (!ctx.active) {
      otBtn.hidden = true;
      return;
    }
    otBtn.hidden = false;
    otBtn.textContent = store.state.overtimeFlag ? '残業終了' : '残業開始';
  }

  /** 秒単位の描画。ここでは軽い計算しかしない(SPEC 14)。 */
  function renderFrame() {
    if (ctx) {
      var live = currentLive(Date.now());
      var ticker = document.querySelector('.ticker');
      if (live) {
        var parts = fmtYenParts(live.breakdown.amount);
        $('liveInt').textContent = parts.int;
        $('liveDec').textContent = parts.dec;
        $('tickerLabel').textContent = ctx.settings.autoMode ? '今このセッション(自動)' : '今このセッション';
        $('liveMeta').textContent = liveMetaText(live);
        ticker.classList.add('is-live');
        setTone(ticker, live);
        $('rateStrip').hidden = false;
        $('rateStrip').innerHTML = '<span class="chip">' + rateLabel(live) + '</span>';
      } else {
        var last = lastSessionAmount();
        var p2 = fmtYenParts(last.amount);
        $('liveInt').textContent = p2.int;
        $('liveDec').textContent = p2.dec;
        $('tickerLabel').textContent = last.label;
        $('liveMeta').textContent = last.meta;
        ticker.classList.remove('is-live');
        setTone(ticker, null);
        $('rateStrip').hidden = true;
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
    scheduledInside: '所定内 ×1.00',
    legalInsideOvertime: '法定内残業 ×1.00',
    statutoryOvertime: '法定時間外 ×1.25',
    statutoryOvertimeOver60: '法定時間外(60h超) ×1.50',
    legalHoliday: '法定休日 ×1.35',
  };

  function rateLabel(live) {
    var base = TONE_LABEL[live.marginal.kind] || '';
    if (live.onBreak) return '休憩中(カウント停止)';
    var label = base;
    if (T.isNightMs(Date.now())) label += ' + 深夜 ×0.25';
    return label + '  =  ×' + live.marginal.rate.toFixed(2);
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

    // --- 清算期間
    var remain = P.daysUntilClose(ctx.period, ctx.now);
    var closeLabel = ctx.period.end.getMonth() + 1 + '月' + ctx.period.end.getDate() + '日締め';
    html += '<div class="sec"><h3>清算期間</h3>';
    html += kv('対象期間', mdLabel(ctx.period.startKey) + ' 〜 ' + mdLabel(ctx.period.endKey));
    html += kv(closeLabel, remain === 0 ? '本日が締め日(速報値)' : 'あと ' + remain + '日(速報値)');
    html += kv('所定労働日数 / 総枠', agg.frames.scheduledWorkDays + '日 / ' + fmtHours(agg.frames.scheduledFrameMinutes));
    html += kv('法定労働時間の総枠', fmtHours(agg.frames.legalFrameMinutes));
    html += kv('基礎時給単価', fmtYen(agg.rates.baseHourlyRate) + ' /時', { money: true });
    html += kv('月平均所定労働時間', agg.rates.monthlyAvgScheduledHours.toFixed(1) + ' 時間');
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
    var iv = A.intervalNotice(store.state.lastClockOutAt, ctx.active ? ctx.active.startMs : null, s.intervalGuideHours);
    if (iv) {
      notices.push('前回の退勤から ' + T.formatMinutesJa(iv.minutes) + (iv.isShort ? '(目安の' + s.intervalGuideHours + '時間を下回っています)' : '') + '。');
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

  function initActions() {
    $('clockInBtn').addEventListener('click', function () {
      if (!requireSetup()) return;
      store.clockIn(Date.now());
      lastLogSavedAt = 0;
      heavy();
    });
    $('clockOutBtn').addEventListener('click', function () {
      store.clockOut(Date.now());
      lastLogSavedAt = 0;
      heavy();
    });
    $('overtimeBtn').addEventListener('click', function () {
      if (!ctx || !ctx.active) return;
      if (!store.state.overtimeFlag) {
        // 退勤予定時刻での自動確定を無効化するフラグを立てるだけ(SPEC 14)
        store.state.overtimeFlag = true;
        store.saveState();
      } else {
        store.commitSession(ctx.active.startMs, Date.now(), ctx.active.isLegalHoliday);
        store.state.overtimeFlag = false;
        store.state.lastClockOutAt = Date.now();
        store.saveState();
      }
      lastLogSavedAt = 0;
      heavy();
    });
    $('detailsPanel').addEventListener('toggle', function () { renderStatic(); });
  }

  function requireSetup() {
    if (store.state.configured && store.settings.monthlyBaseSalary) return true;
    openSettings(true);
    return false;
  }

  // -------------------------------------------------------------- 設定

  function initSettings() {
    var closing = $('setClosingDay');
    var opts = '<option value="last">末日</option>';
    for (var i = 1; i <= 31; i++) opts += '<option value="' + i + '">' + i + '日</option>';
    closing.innerHTML = opts;

    var wd = $('setLegalWeekday');
    var wopts = '';
    for (var w = 0; w < 7; w++) wopts += '<option value="' + w + '">' + WT.WEEKDAY_LABELS[w] + '曜日</option>';
    wd.innerHTML = wopts;

    var picker = $('setWorkdays');
    var phtml = '';
    for (var d = 0; d < 7; d++) phtml += '<button type="button" data-day="' + d + '">' + WT.WEEKDAY_LABELS[d] + '</button>';
    picker.innerHTML = phtml;
    picker.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-day]');
      if (!btn) return;
      btn.classList.toggle('is-on');
    });

    $('setNoBreakWindow').addEventListener('change', function () {
      var off = this.checked;
      $('setBreakStart').disabled = off;
      $('setBreakEnd').disabled = off;
    });
    $('setAutoMode').addEventListener('change', function () {
      $('scheduleRow').style.display = this.checked ? 'flex' : 'none';
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
    $('firstRunNote').textContent = FIRST_RUN_TEXT;
    $('firstRunNote').hidden = !firstRun && store.state.configured;
    $('settingsTitle').textContent = store.state.configured ? '設定' : 'はじめの設定';
    $('setSalary').value = s.monthlyBaseSalary == null ? '' : String(s.monthlyBaseSalary);
    $('setSalary').type = 'password';
    $('salaryEye').textContent = '表示';
    $('setSalary').placeholder = String(WT.BASE_SALARY_PLACEHOLDER);
    $('setDailyHours').value = s.dailyScheduledHours;
    $('setAnnualHolidays').value = s.annualHolidays;
    $('setClosingDay').value = String(s.closingDay);
    $('setLegalWeekday').value = String(s.legalHolidayWeekday);

    var btns = $('setWorkdays').querySelectorAll('button[data-day]');
    for (var i = 0; i < btns.length; i++) {
      var day = Number(btns[i].getAttribute('data-day'));
      btns[i].classList.toggle('is-on', s.workdays.indexOf(day) >= 0);
    }

    var hasBreak = !!s.breakWindow;
    $('setNoBreakWindow').checked = !hasBreak;
    $('setBreakStart').value = hasBreak ? s.breakWindow.start : '12:00';
    $('setBreakEnd').value = hasBreak ? s.breakWindow.end : '13:00';
    $('setBreakStart').disabled = !hasBreak;
    $('setBreakEnd').disabled = !hasBreak;

    $('setInterval').value = s.intervalGuideHours;
    $('setAutoMode').checked = !!s.autoMode;
    $('scheduleRow').style.display = s.autoMode ? 'flex' : 'none';
    $('setScheduleStart').value = (s.schedule && s.schedule.start) || '09:00';
    $('setScheduleEnd').value = (s.schedule && s.schedule.end) || '17:30';

    dlg.showModal();
  }

  var FIRST_RUN_TEXT = 'はじめに、基本給と働き方を登録してください。データはこの端末のブラウザ内にのみ保存されます。';

  function saveSettingsFromForm() {
    var salary = Number(String($('setSalary').value).replace(/[^\d.]/g, ''));
    var daily = Number($('setDailyHours').value);
    var holidays = Number($('setAnnualHolidays').value);
    if (!(salary > 0)) { flashHint('基本給を入力してください。'); return; }
    if (!(daily > 0 && daily <= 24)) { flashHint('1日の所定労働時間を確認してください。'); return; }
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
    s.breakWindow = $('setNoBreakWindow').checked
      ? null
      : { start: $('setBreakStart').value || '12:00', end: $('setBreakEnd').value || '13:00' };
    s.intervalGuideHours = Number($('setInterval').value) || 0;
    s.autoMode = $('setAutoMode').checked;
    s.schedule = { start: $('setScheduleStart').value || '09:00', end: $('setScheduleEnd').value || '17:30' };

    store.saveSettings();
    store.state.configured = true;
    store.saveState();
    $('settingsDialog').close();
    lastLogSavedAt = 0;
    heavy();
  }

  function flashHint(msg) {
    var note = $('firstRunNote');
    note.hidden = false;
    note.textContent = msg;
    note.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------- カレンダー

  function initCalendar() {
    var head = '';
    for (var i = 0; i < 7; i++) head += '<div class="cal-head-cell">' + WT.WEEKDAY_LABELS[i] + '</div>';
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

    var html = '';
    for (var pad = 0; pad < first.getDay(); pad++) html += '<button class="cal-cell is-empty" disabled></button>';

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
    initPrivacy();
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
