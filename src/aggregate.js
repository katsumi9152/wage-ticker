/**
 * aggregate.js — 清算期間の集計(純粋関数 / DOM 非依存)
 *
 * SPEC 6章(有給・会社休日・未入力日)、7章(月次サマリー・前月比較・36協定履歴)、
 * 8章(気づき表示)の計算を担当する。カレンダー(日別データ)を唯一の入力とし、
 * 期間の頭から順に日を消化していくことで、フレックスの総枠判定を成立させる。
 */
(function (WT) {
  'use strict';

  var T = WT.time;
  var W = WT.wage;

  // -------------------------------------------------------- カレンダー判定

  function getEntry(calendar, key) {
    return (calendar && calendar[key]) || null;
  }

  /** その日は所定労働日か(会社休日の指定と、所定労働日の曜日設定から判定) */
  function isScheduledWorkDay(date, settings, calendar) {
    var key = T.dateKey(date);
    var entry = getEntry(calendar, key);
    if (entry && entry.type === 'company_holiday') return false;
    var workdays = settings.workdays || [];
    return workdays.indexOf(date.getDay()) >= 0;
  }

  /**
   * その日が「法定休日」に当たるか(SPEC 6.1)。
   * 会社休日として指定済みならその指定を優先し、未指定なら
   * 「所定労働日でない かつ 法定休日の曜日」を法定休日とみなす。
   */
  function judgeLegalHoliday(date, settings, calendar) {
    var key = T.dateKey(date);
    var entry = getEntry(calendar, key);
    if (entry && entry.type === 'company_holiday') {
      return entry.holidayKind === 'legal';
    }
    if (entry && typeof entry.isLegalHoliday === 'boolean') {
      return entry.isLegalHoliday;
    }
    var workdays = settings.workdays || [];
    var isWorkday = workdays.indexOf(date.getDay()) >= 0;
    return !isWorkday && date.getDay() === Number(settings.legalHolidayWeekday);
  }

  /** 清算期間内の所定労働日数 */
  function countScheduledWorkDays(period, settings, calendar) {
    var count = 0;
    for (var d = new Date(period.start); d.getTime() <= period.end.getTime(); d = T.addDays(d, 1)) {
      if (isScheduledWorkDay(d, settings, calendar)) count++;
    }
    return count;
  }

  /** 所定労働時間の総枠・法定労働時間の総枠(SPEC 3.2) */
  function computeFrames(period, settings, calendar) {
    var scheduledWorkDays = countScheduledWorkDays(period, settings, calendar);
    return {
      scheduledWorkDays: scheduledWorkDays,
      scheduledFrameMinutes: Number(settings.dailyScheduledHours || 0) * 60 * scheduledWorkDays,
      legalFrameMinutes: (WT.WEEKLY_LEGAL_HOURS * period.calendarDays * 60) / 7,
    };
  }

  // ------------------------------------------------------------ 期間の集計

  /**
   * 清算期間を頭から集計する。
   *
   * @param {object} o
   * @param {object} o.period   period.resolvePeriod() の戻り値
   * @param {object} o.settings 設定
   * @param {object} o.calendar 日別データ(確定済みの打刻・有給・会社休日)
   * @param {?{startMs:number,isLegalHoliday:boolean}} o.activeSession 進行中の勤務
   * @param {Date}   o.now      現在時刻
   * @param {boolean} o.finalize 締め処理用。true なら未来日を含めず期間末まで確定させる
   */
  function aggregatePeriod(o) {
    var settings = o.settings;
    var calendar = o.calendar || {};
    var now = o.now;
    var rates = W.deriveRates(settings);
    var frames = computeFrames(o.period, settings, calendar);
    var cursor = W.createCursor(frames);

    var todayKey = T.dateKey(now);
    var activeKey = o.activeSession ? T.dateKey(new Date(o.activeSession.startMs)) : null;

    var totals = W.emptyBreakdown();
    var todayFinalized = W.emptyBreakdown();
    var days = [];
    var unfilledDates = [];
    var autoFilledDays = 0;

    for (var d = new Date(o.period.start); d.getTime() <= o.period.end.getTime(); d = T.addDays(d, 1)) {
      var key = T.dateKey(d);
      if (!o.finalize && key > todayKey) break;

      var entry = getEntry(calendar, key);
      var record = null;

      if (entry && entry.coveredBy) {
        // 日をまたいだ勤務の継続日。前日の記録に含まれているので何もしない。
        continue;
      }

      if (entry && entry.clockIn && entry.clockOut) {
        // 打刻あり(会社休日への出勤もここに入る)
        var isHoliday = typeof entry.isLegalHoliday === 'boolean'
          ? entry.isLegalHoliday
          : judgeLegalHoliday(d, settings, calendar);
        var res = W.calcEarnings(cursor, entry.clockIn, entry.clockOut, settings, rates, {
          isLegalHoliday: isHoliday,
          breaks: entry.breaks,
        });
        record = {
          date: key,
          kind: 'work',
          isLegalHoliday: isHoliday,
          clockIn: entry.clockIn,
          clockOut: entry.clockOut,
          rawMinutes: res.rawMinutes,
          deductedMinutes: res.deductedMinutes,
          workedMinutes: res.workedMinutes,
          breakdown: res.breakdown,
        };
      } else if (entry && entry.type === 'paid_leave') {
        // 有給休暇: 所定労働時間分を所定内として計上(SPEC 6.1)
        var bdLeave = W.allocateScheduledDay(cursor, settings, rates, {});
        record = {
          date: key,
          kind: 'paid_leave',
          isLegalHoliday: false,
          workedMinutes: bdLeave.workedMinutes,
          breakdown: bdLeave,
        };
      } else if (entry && entry.type === 'company_holiday') {
        // 打刻のない会社休日: 所定労働日から除外。未入力日にもしない。
        continue;
      } else if (key === activeKey) {
        // 進行中の勤務。確定値には含めず、リアルタイム側で加算する。
        continue;
      } else if (key < todayKey && isScheduledWorkDay(d, settings, calendar)) {
        // 未入力日(すでに過ぎた所定労働日): 所定内・残業なしで自動加算(SPEC 6.2)
        var bdAuto = W.allocateScheduledDay(cursor, settings, rates, { autoFilled: true });
        autoFilledDays++;
        unfilledDates.push(key);
        record = {
          date: key,
          kind: 'auto_filled',
          isLegalHoliday: false,
          workedMinutes: bdAuto.workedMinutes,
          breakdown: bdAuto,
        };
      } else if (o.finalize && key > todayKey && isScheduledWorkDay(d, settings, calendar)) {
        // 締め処理で未来日まで確定させる場合(通常は起こらない)
        var bdFuture = W.allocateScheduledDay(cursor, settings, rates, { autoFilled: true });
        autoFilledDays++;
        unfilledDates.push(key);
        record = {
          date: key,
          kind: 'auto_filled',
          isLegalHoliday: false,
          workedMinutes: bdFuture.workedMinutes,
          breakdown: bdFuture,
        };
      }

      if (record) {
        days.push(record);
        W.addBreakdown(totals, record.breakdown);
        if (key === todayKey) W.addBreakdown(todayFinalized, record.breakdown);
      }
    }

    return {
      period: o.period,
      rates: rates,
      frames: frames,
      days: days,
      totals: totals,
      todayFinalized: todayFinalized,
      cursor: cursor, // 進行中セッションを計算する直前の状態
      unfilledDates: unfilledDates,
      autoFilledDays: autoFilledDays,
    };
  }

  /**
   * 進行中の勤務ぶんを、集計済みカーソルの続きとして計算する。
   * 毎フレーム呼ばれても軽いよう、期間の再走査はしない(SPEC 14)。
   */
  function computeLive(aggregate, activeSession, settings, nowMs) {
    if (!activeSession) return null;
    var cursor = W.cloneCursor(aggregate.cursor);
    var res = W.calcEarnings(cursor, activeSession.startMs, nowMs, settings, aggregate.rates, {
      isLegalHoliday: !!activeSession.isLegalHoliday,
      breaks: activeSession.breaks,
    });
    var margin = W.marginalRate(cursor, aggregate.rates, {
      isLegalHoliday: !!activeSession.isLegalHoliday,
      isNight: T.isNightMs(nowMs),
      onBreak: res.onBreak,
    });
    return {
      cursor: cursor,
      rawMinutes: res.rawMinutes,
      deductedMinutes: res.deductedMinutes,
      workedMinutes: res.workedMinutes,
      onBreak: res.onBreak,
      breakdown: res.breakdown,
      marginal: margin,
    };
  }

  // ------------------------------------------------------------ 前月比較

  /** 日別ログの先頭 n 日ぶんを合計する(SPEC 7.2) */
  function prefixTotals(days, periodStart, elapsedDays) {
    var limitKey = T.dateKey(T.addDays(periodStart, elapsedDays - 1));
    var total = W.emptyBreakdown();
    for (var i = 0; i < days.length; i++) {
      if (days[i].date > limitKey) break;
      W.addBreakdown(total, days[i].breakdown);
    }
    return total;
  }

  /**
   * 前月の同経過日数時点との比較(SPEC 7.2)。
   * @returns {?{amountDiff:number, minutesDiff:number, baseAmount:number, elapsedDays:number}}
   */
  function comparePrevious(currentTotals, previousDays, previousPeriod, elapsedDays) {
    if (!previousDays || !previousDays.length) return null;
    var base = prefixTotals(previousDays, previousPeriod.start, elapsedDays);
    return {
      elapsedDays: elapsedDays,
      baseAmount: base.amount,
      baseMinutes: base.workedMinutes,
      amountDiff: currentTotals.amount - base.amount,
      minutesDiff: currentTotals.workedMinutes - base.workedMinutes,
    };
  }

  // ---------------------------------------------------------- 36協定の目安

  /** 清算期間の確定値から、履歴に残す軽量レコードを作る(SPEC 7.4) */
  function toHistoryRecord(label, totals) {
    return {
      label: label,
      legalInsideOvertimeHours: round2(totals.legalInsideOvertime.minutes / 60),
      statutoryOvertimeHours: round2(
        (totals.statutoryOvertime.minutes + totals.statutoryOvertimeOver60.minutes) / 60
      ),
      legalHolidayHours: round2(totals.legalHoliday.minutes / 60),
      totalWorkedHours: round2(totals.workedMinutes / 60),
    };
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  // ---------------------------------------------------- 休憩・インターバル

  /**
   * 休憩未取得の目安(SPEC 8.2 ①)。
   * その日の実働が6時間/8時間を超えているのに休憩控除が発生していない場合に返す。
   */
  function breakNotice(dayWorkedMinutes, dayDeductedMinutes) {
    if (dayDeductedMinutes > 0) return null;
    if (dayWorkedMinutes > WT.BREAK_LAW.OVER_8H_MINUTES) {
      return { threshold: 8, requiredMinutes: 60 };
    }
    if (dayWorkedMinutes > WT.BREAK_LAW.OVER_6H_MINUTES) {
      return { threshold: 6, requiredMinutes: 45 };
    }
    return null;
  }

  WT.aggregate = {
    getEntry: getEntry,
    isScheduledWorkDay: isScheduledWorkDay,
    judgeLegalHoliday: judgeLegalHoliday,
    countScheduledWorkDays: countScheduledWorkDays,
    computeFrames: computeFrames,
    aggregatePeriod: aggregatePeriod,
    computeLive: computeLive,
    prefixTotals: prefixTotals,
    comparePrevious: comparePrevious,
    toHistoryRecord: toHistoryRecord,
    breakNotice: breakNotice,
  };
})((globalThis.WT = globalThis.WT || {}));
