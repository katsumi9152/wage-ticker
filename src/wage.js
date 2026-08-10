/**
 * wage.js — 給与計算のコア(純粋関数 / DOM 非依存 / SPEC 3章・5章)
 *
 * ここでは「フレックスタイム制(コアタイムなし)」を前提に、1日8時間超・週40時間超
 * という日次/週次の残業判定は行わない(SPEC 3.2)。清算期間の累計実働時間を
 *   所定労働時間の総枠 -> 法定労働時間の総枠 -> それ超
 * の順に消化していくカーソル方式で区分する。
 */
(function (WT) {
  'use strict';

  var T = WT.time;
  var RATE = WT.RATE;

  // ---------------------------------------------------------------- 単価

  /**
   * 設定から派生値(月平均所定労働時間・基礎時給単価)を求める(SPEC 3.1)。
   * 基礎時給単価は端数処理せずそのまま使う(SPEC 9: 端数処理は適用しない)。
   */
  function deriveRates(settings) {
    var annualWorkDays = WT.DAYS_IN_YEAR - Number(settings.annualHolidays || 0);
    var monthlyAvgScheduledHours = (annualWorkDays * Number(settings.dailyScheduledHours || 0)) / 12;
    var base = Number(settings.monthlyBaseSalary || 0);
    var baseHourlyRate = monthlyAvgScheduledHours > 0 ? base / monthlyAvgScheduledHours : 0;
    return {
      annualWorkDays: annualWorkDays,
      monthlyAvgScheduledHours: monthlyAvgScheduledHours,
      baseHourlyRate: baseHourlyRate,
      /** 1ミリ秒あたりの所定内単価(なめらかな表示の基準値) */
      baseRatePerMs: baseHourlyRate / 3600000,
    };
  }

  /**
   * 1日の所定労働時間を、標準の勤務時間と休憩時間帯から導く。
   *
   *   所定労働時間 = (退勤 − 出勤) − 勤務時間と重なる休憩
   *
   * 休憩時間帯が未登録なら一律 DEFAULT_BREAK_MINUTES を引く。
   * 退勤が出勤以前なら日をまたぐ勤務として扱う。
   *
   * @returns {?number} 時間(小数2桁まで)。時刻が不正なら null
   */
  function deriveDailyScheduledHours(scheduleStart, scheduleEnd, breakWindow) {
    var s = T.parseTimeToMinutes(scheduleStart);
    var e = T.parseTimeToMinutes(scheduleEnd);
    if (s === null || e === null) return null;
    var span = e - s;
    if (span <= 0) span += 24 * 60;

    var deduct = WT.DEFAULT_BREAK_MINUTES;
    if (breakWindow) {
      var bs = T.parseTimeToMinutes(breakWindow.start);
      var be = T.parseTimeToMinutes(breakWindow.end);
      if (bs !== null && be !== null && bs === be) {
        deduct = 0; // 開始と終了が同じなら休憩なし
      } else if (bs !== null && be !== null) {
        var len = be - bs;
        if (len < 0) len += 24 * 60;
        // 勤務時間と実際に重なる分だけを引く(勤務時間外の休憩は引かない)
        deduct = 0;
        for (var shift = -1440; shift <= 1440; shift += 1440) {
          var a = Math.max(s, bs + shift);
          var b = Math.min(s + span, bs + shift + len);
          if (b > a) deduct += b - a;
        }
      }
    }

    var minutes = Math.max(0, span - deduct);
    return Math.round((minutes / 60) * 100) / 100;
  }

  // ------------------------------------------------------------ 休憩控除

  /**
   * 休憩時間帯が未登録のときの控除分数(SPEC 5.2 の「一律60分」)。
   *
   * 素朴に常時60分を引くと、出勤直後の実働がマイナスになり
   * 「開いた瞬間に増えている」体験(SPEC 1.1)が壊れるため、
   * 所定的な1日(FLAT_BREAK_RAMP_MINUTES)をかけて滑らかに引き切る。
   * 8時間以上働いた時点で控除はちょうど60分となり SPEC の一律60分と一致する。
   */
  function flatBreakDeduction(rawMinutes) {
    if (rawMinutes <= 0) return 0;
    var ratio = Math.min(1, rawMinutes / WT.FLAT_BREAK_RAMP_MINUTES);
    return WT.DEFAULT_BREAK_MINUTES * ratio;
  }

  /**
   * 1回の打刻区間から、休憩控除後の実働セグメント(深夜/非深夜に分割済み)を作る。
   *
   * 控除は3種類あり、いずれも打刻区間から差し引く。重なっていても二重には引かれない。
   *   ① 昼休憩(設定した時間帯) — 出退勤どちらもその時間帯の外にある(=完全に
   *      またいでいる)日だけ丸ごと差し引く。出勤・退勤のどちらかがその時間帯の
   *      途中にある日(半日だけ働く日など)は、そもそも昼休憩を取れていないので
   *      控除しない
   *   ② 手動の休憩(休憩開始/終了) — 押した区間を差し引く。終了前なら現在時刻まで
   *   ③ 法定休憩の自動追加控除(労基法34条) — ①②を終えてなお、実働が6時間超
   *      なのに控除計45分未満、または8時間超なのに60分未満なら、不足分を
   *      退勤直前から自動で追加控除する
   *
   * @param {number} startMs 出勤時刻
   * @param {number} endMs   退勤時刻(リアルタイム表示中は現在時刻)
   * @param {?{start:string,end:string}} breakWindow 昼休憩の時間帯(null なら一律控除)
   * @param {?Array<{start:number,end:?number}>} manualBreaks 手動の休憩
   */
  function sessionWork(startMs, endMs, breakWindow, manualBreaks) {
    var rawMinutes = Math.max(0, (endMs - startMs) / T.MS_PER_MINUTE);
    var segments = T.splitByNight(startMs, endMs);
    var deductedMinutes = 0;

    if (breakWindow && T.parseTimeToMinutes(breakWindow.start) !== null && T.parseTimeToMinutes(breakWindow.end) !== null) {
      var windows = T.breakWindowsIn(startMs, endMs, breakWindow);
      var fullWindows = windows.filter(function (w) {
        var startsInside = startMs > w.startMs && startMs < w.endMs;
        var endsInside = endMs > w.startMs && endMs < w.endMs;
        return !startsInside && !endsInside;
      });
      var before = T.totalMinutes(segments);
      segments = T.subtractWindows(segments, fullWindows);
      deductedMinutes = before - T.totalMinutes(segments);
    } else {
      deductedMinutes = Math.min(rawMinutes, flatBreakDeduction(rawMinutes));
      segments = T.trimFromStart(segments, deductedMinutes);
    }

    if (manualBreaks && manualBreaks.length) {
      var manualWindows = [];
      for (var i = 0; i < manualBreaks.length; i++) {
        var b = manualBreaks[i];
        if (!b || !b.start) continue;
        var bEnd = b.end || endMs; // 終了前の休憩は「いまも休憩中」として現在まで引く
        if (bEnd > b.start) manualWindows.push({ startMs: b.start, endMs: bEnd });
      }
      var beforeManual = T.totalMinutes(segments);
      segments = T.subtractWindows(segments, manualWindows);
      deductedMinutes += beforeManual - T.totalMinutes(segments);
    }

    var legalBreakToppedUpMinutes = 0;
    var workedMinutesSoFar = T.totalMinutes(segments);
    var requiredMinutes = 0;
    if (workedMinutesSoFar > WT.BREAK_LAW.OVER_8H_MINUTES) requiredMinutes = 60;
    else if (workedMinutesSoFar > WT.BREAK_LAW.OVER_6H_MINUTES) requiredMinutes = 45;
    if (requiredMinutes > 0 && deductedMinutes < requiredMinutes) {
      var topUp = Math.min(requiredMinutes - deductedMinutes, workedMinutesSoFar);
      segments = T.trimFromEnd(segments, topUp);
      deductedMinutes += topUp;
      legalBreakToppedUpMinutes = topUp;
    }

    return {
      rawMinutes: rawMinutes,
      deductedMinutes: deductedMinutes,
      workedMinutes: T.totalMinutes(segments),
      legalBreakToppedUpMinutes: legalBreakToppedUpMinutes,
      segments: segments.map(function (s) {
        return { minutes: (s.endMs - s.startMs) / T.MS_PER_MINUTE, isNight: s.isNight, startMs: s.startMs, endMs: s.endMs };
      }),
    };
  }

  // -------------------------------------------------------------- 区分計算

  function emptyBucket() {
    return { minutes: 0, amount: 0 };
  }

  /** 区分別内訳の空オブジェクト */
  function emptyBreakdown() {
    return {
      scheduledInside: emptyBucket(), // 所定内
      legalInsideOvertime: emptyBucket(), // 法定内残業
      fixedOvertime: emptyBucket(), // 固定残業代でカバーされる法定時間外
      statutoryOvertime: emptyBucket(), // 法定時間外(60hまで)
      statutoryOvertimeOver60: emptyBucket(), // 法定時間外(60h超)
      legalHoliday: emptyBucket(), // 法定休日労働
      night: emptyBucket(), // 深夜割増(他区分に加算される分のみ)
      workedMinutes: 0,
      /** 画面に積み上げる金額(所定内も1.00で計上) */
      amount: 0,
      /** うち、基本給とは別に発生した追加支払い分 */
      extraAmount: 0,
      /** 未入力日から自動加算された分(SPEC 6.2) */
      autoFilledMinutes: 0,
      autoFilledAmount: 0,
    };
  }

  var BUCKET_KEYS = [
    'scheduledInside',
    'legalInsideOvertime',
    'fixedOvertime',
    'statutoryOvertime',
    'statutoryOvertimeOver60',
    'legalHoliday',
    'night',
  ];

  function addBreakdown(target, src) {
    for (var i = 0; i < BUCKET_KEYS.length; i++) {
      var k = BUCKET_KEYS[i];
      target[k].minutes += src[k].minutes;
      target[k].amount += src[k].amount;
    }
    target.workedMinutes += src.workedMinutes;
    target.amount += src.amount;
    target.extraAmount += src.extraAmount;
    target.autoFilledMinutes += src.autoFilledMinutes;
    target.autoFilledAmount += src.autoFilledAmount;
    return target;
  }

  function cloneBreakdown(src) {
    return addBreakdown(emptyBreakdown(), src);
  }

  /**
   * 清算期間内の消化状況を持つカーソル。
   * frameMinutes は「所定/法定の総枠を消化した分」。法定休日労働は時間外労働の
   * 枠に算入しない扱いのため、frameMinutes には加算せず holidayMinutes に分ける。
   */
  function createCursor(frames) {
    return {
      scheduledFrameMinutes: frames.scheduledFrameMinutes,
      legalFrameMinutes: frames.legalFrameMinutes,
      /** 固定残業代でカバーされる法定時間外の分数と、その月額 */
      fixedOvertimeMinutes: frames.fixedOvertimeMinutes || 0,
      fixedOvertimeAllowance: frames.fixedOvertimeAllowance || 0,
      frameMinutes: 0, // 総枠を消化した分(法定休日労働を除く)
      statutoryOvertimeMinutes: 0, // 60hラインと固定残業の消化の判定用
      holidayMinutes: 0,
      workedMinutes: 0, // 実働合計(法定休日労働も含む)
    };
  }

  function cloneCursor(cursor) {
    return {
      scheduledFrameMinutes: cursor.scheduledFrameMinutes,
      legalFrameMinutes: cursor.legalFrameMinutes,
      fixedOvertimeMinutes: cursor.fixedOvertimeMinutes,
      fixedOvertimeAllowance: cursor.fixedOvertimeAllowance,
      frameMinutes: cursor.frameMinutes,
      statutoryOvertimeMinutes: cursor.statutoryOvertimeMinutes,
      holidayMinutes: cursor.holidayMinutes,
      workedMinutes: cursor.workedMinutes,
    };
  }

  function pushBucket(bucket, minutes, rate, baseHourlyRate) {
    if (minutes <= 0) return 0;
    var amount = (minutes / 60) * rate * baseHourlyRate;
    bucket.minutes += minutes;
    bucket.amount += amount;
    return amount;
  }

  /**
   * セグメント列をカーソルに沿って区分し、内訳を返す(SPEC 5.4)。
   * cursor は破壊的に更新される(呼び出し側で cloneCursor して使う)。
   *
   * @param {object} cursor createCursor() の戻り値
   * @param {Array<{minutes:number,isNight:boolean}>} segments
   * @param {{isLegalHoliday:boolean, baseHourlyRate:number, autoFilled?:boolean}} opts
   */
  function allocateSegments(cursor, segments, opts) {
    var bd = emptyBreakdown();
    var baseHourlyRate = opts.baseHourlyRate;
    var isLegalHoliday = !!opts.isLegalHoliday;

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var minutes = seg.minutes;
      if (minutes <= 0) continue;

      if (isLegalHoliday) {
        // 法定休日労働は 1.35 固定。深夜と重なれば +0.25 で 1.60(SPEC 3.3)。
        // 時間外労働の枠(所定/法定の総枠・月60hライン)には算入しない。
        pushBucket(bd.legalHoliday, minutes, RATE.LEGAL_HOLIDAY, baseHourlyRate);
        if (seg.isNight) pushBucket(bd.night, minutes, RATE.NIGHT_PREMIUM, baseHourlyRate);
        cursor.holidayMinutes += minutes;
        cursor.workedMinutes += minutes;
        bd.workedMinutes += minutes;
        continue;
      }

      var rest = minutes;

      // ① 所定内労働(所定労働時間の総枠内)
      var scheduledRemain = Math.max(0, cursor.scheduledFrameMinutes - cursor.frameMinutes);
      var inScheduled = Math.min(rest, scheduledRemain);
      if (inScheduled > 0) {
        pushBucket(bd.scheduledInside, inScheduled, RATE.SCHEDULED_INSIDE, baseHourlyRate);
        cursor.frameMinutes += inScheduled;
        rest -= inScheduled;
      }

      // ② 法定内残業(所定超・法定内)
      if (rest > 0) {
        var legalRemain = Math.max(
          0,
          cursor.legalFrameMinutes - Math.max(cursor.frameMinutes, cursor.scheduledFrameMinutes)
        );
        var inLegalInside = Math.min(rest, legalRemain);
        if (inLegalInside > 0) {
          pushBucket(bd.legalInsideOvertime, inLegalInside, RATE.LEGAL_INSIDE_OVERTIME, baseHourlyRate);
          cursor.frameMinutes += inLegalInside;
          rest -= inLegalInside;
        }
      }

      // ③ 法定時間外労働
      if (rest > 0) {
        // ③-a 固定残業代でカバーされる分。割増は上乗せせず、月額を時間で均して積む。
        var covered = 0;
        if (cursor.fixedOvertimeMinutes > 0) {
          covered = Math.min(rest, Math.max(0, cursor.fixedOvertimeMinutes - cursor.statutoryOvertimeMinutes));
          if (covered > 0) {
            bd.fixedOvertime.minutes += covered;
            bd.fixedOvertime.amount += (cursor.fixedOvertimeAllowance / cursor.fixedOvertimeMinutes) * covered;
          }
        }

        // ③-b 残りに通常の割増(月60hを境に 1.25 / 1.50)。
        //     60hラインは固定残業でカバーされた分も含めた累計で判定する。
        var paid = rest - covered;
        if (paid > 0) {
          var consumed = cursor.statutoryOvertimeMinutes + covered;
          var under60 = Math.min(paid, Math.max(0, WT.OVER60_THRESHOLD_MINUTES - consumed));
          if (under60 > 0) {
            pushBucket(bd.statutoryOvertime, under60, RATE.STATUTORY_OVERTIME, baseHourlyRate);
          }
          var over60 = paid - under60;
          if (over60 > 0) {
            pushBucket(bd.statutoryOvertimeOver60, over60, RATE.STATUTORY_OVERTIME_OVER60, baseHourlyRate);
          }
        }

        cursor.statutoryOvertimeMinutes += rest;
        cursor.frameMinutes += rest;
        rest = 0;
      }

      // ④ 深夜割増(①〜③のいずれと重なっても +0.25)
      if (seg.isNight) {
        pushBucket(bd.night, minutes, RATE.NIGHT_PREMIUM, baseHourlyRate);
      }

      cursor.workedMinutes += minutes;
      bd.workedMinutes += minutes;
    }

    bd.amount =
      bd.scheduledInside.amount +
      bd.legalInsideOvertime.amount +
      bd.fixedOvertime.amount +
      bd.statutoryOvertime.amount +
      bd.statutoryOvertimeOver60.amount +
      bd.legalHoliday.amount +
      bd.night.amount;
    bd.extraAmount = bd.amount - bd.scheduledInside.amount;

    if (opts.autoFilled) {
      bd.autoFilledMinutes = bd.workedMinutes;
      bd.autoFilledAmount = bd.amount;
    }
    return bd;
  }

  /**
   * 打刻区間ひとつぶんの金額を計算する(SPEC 5.4 calcEarnings)。
   * 手動モードでも自動モードでも、この関数を共通で使う(SPEC 14)。
   */
  function calcEarnings(cursor, startMs, endMs, settings, rates, opts) {
    var o = opts || {};
    var work = sessionWork(startMs, endMs, settings.breakWindow, o.breaks);
    var breakdown = allocateSegments(cursor, work.segments, {
      isLegalHoliday: !!o.isLegalHoliday,
      baseHourlyRate: rates.baseHourlyRate,
      autoFilled: !!o.autoFilled,
    });
    return {
      rawMinutes: work.rawMinutes,
      deductedMinutes: work.deductedMinutes,
      workedMinutes: work.workedMinutes,
      legalBreakToppedUpMinutes: work.legalBreakToppedUpMinutes,
      onBreak: isOnBreakAt(endMs, startMs, settings.breakWindow) || hasOpenBreak(o.breaks),
      breakdown: breakdown,
    };
  }

  /** 終了していない手動の休憩があるか(= いま休憩中) */
  function hasOpenBreak(breaks) {
    if (!breaks) return false;
    for (var i = 0; i < breaks.length; i++) {
      if (breaks[i] && breaks[i].start && !breaks[i].end) return true;
    }
    return false;
  }

  /**
   * いま休憩時間帯の中か(カウンターを止める判定・SPEC 5.3)。
   * 出社時刻がその休憩帯の中にある(sessionWork では控除しない)場合は、
   * その休憩帯では止めない(金額は増え続けているのに「休憩中」と表示される
   * 矛盾を避けるため)。
   */
  function isOnBreakAt(ms, sessionStartMs, breakWindow) {
    if (!breakWindow) return false;
    var windows = T.breakWindowsIn(Math.min(sessionStartMs, ms), ms + 1, breakWindow);
    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      if (ms < w.startMs || ms >= w.endMs) continue;
      var startsInside = sessionStartMs > w.startMs && sessionStartMs < w.endMs;
      if (!startsInside) return true;
    }
    return false;
  }

  /**
   * 所定労働時間分をまるごと所定内として計上する(有給休暇・未入力日 / SPEC 6.1・6.2)。
   * 深夜・休日・時間外の割増対象にはしない。
   */
  function allocateScheduledDay(cursor, settings, rates, opts) {
    var minutes = Number(settings.dailyScheduledHours || 0) * 60;
    return allocateSegments(cursor, [{ minutes: minutes, isNight: false }], {
      isLegalHoliday: false,
      baseHourlyRate: rates.baseHourlyRate,
      autoFilled: !!(opts && opts.autoFilled),
    });
  }

  /**
   * 現時点の限界単価(1ミリ秒あたりいくら増えているか)。
   * リアルタイム描画のなめらかさと、割増時間帯の色味変化(SPEC 1.2)に使う。
   */
  function marginalRate(cursor, rates, opts) {
    var o = opts || {};
    if (o.onBreak) return { rate: 0, kind: 'break', perMs: 0 };
    var kind, rate;
    if (o.isLegalHoliday) {
      kind = 'legalHoliday';
      rate = RATE.LEGAL_HOLIDAY;
    } else if (cursor.frameMinutes < cursor.scheduledFrameMinutes) {
      kind = 'scheduledInside';
      rate = RATE.SCHEDULED_INSIDE;
    } else if (cursor.frameMinutes < cursor.legalFrameMinutes) {
      kind = 'legalInsideOvertime';
      rate = RATE.LEGAL_INSIDE_OVERTIME;
    } else if (cursor.statutoryOvertimeMinutes < WT.OVER60_THRESHOLD_MINUTES) {
      kind = 'statutoryOvertime';
      rate = RATE.STATUTORY_OVERTIME;
    } else {
      kind = 'statutoryOvertimeOver60';
      rate = RATE.STATUTORY_OVERTIME_OVER60;
    }
    if (o.isNight) rate += RATE.NIGHT_PREMIUM;
    return { rate: rate, kind: kind, perMs: (rates.baseHourlyRate * rate) / 3600000 };
  }

  WT.wage = {
    deriveRates: deriveRates,
    deriveDailyScheduledHours: deriveDailyScheduledHours,
    flatBreakDeduction: flatBreakDeduction,
    sessionWork: sessionWork,
    emptyBreakdown: emptyBreakdown,
    addBreakdown: addBreakdown,
    cloneBreakdown: cloneBreakdown,
    createCursor: createCursor,
    cloneCursor: cloneCursor,
    allocateSegments: allocateSegments,
    allocateScheduledDay: allocateScheduledDay,
    calcEarnings: calcEarnings,
    isOnBreakAt: isOnBreakAt,
    hasOpenBreak: hasOpenBreak,
    marginalRate: marginalRate,
    BUCKET_KEYS: BUCKET_KEYS,
  };
})((globalThis.WT = globalThis.WT || {}));
