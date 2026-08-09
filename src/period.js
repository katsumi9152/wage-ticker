/**
 * period.js — 賃金締め日から清算期間を算出する純粋関数(SPEC 3.2 / 14)
 */
(function (WT) {
  'use strict';

  var T = WT.time;

  /**
   * 指定した年月の締め日の Date を返す。
   * closingDay が 'last'、または月末日を超える指定(例: 31日締めの2月)は月末に丸める。
   * monthIndex は 0..11 の範囲外でも Date が正規化する(-1 なら前年12月)。
   */
  function closingDateOf(year, monthIndex, closingDay) {
    var normalized = new Date(year, monthIndex, 1);
    var y = normalized.getFullYear();
    var m = normalized.getMonth();
    var dim = T.daysInMonth(y, m);
    var day = closingDay === 'last' ? dim : Math.min(Number(closingDay), dim);
    return new Date(y, m, day);
  }

  /**
   * date を含む清算期間を返す。
   * 例) 20日締め・8/25 -> 8/21〜9/20 / 末日締め・8/25 -> 8/1〜8/31
   *
   * @returns {{start: Date, end: Date, startKey: string, endKey: string,
   *            label: string, calendarDays: number}}
   */
  function resolvePeriod(date, closingDay) {
    var day0 = T.startOfDay(date);
    var end = closingDateOf(day0.getFullYear(), day0.getMonth(), closingDay);
    if (day0.getTime() > end.getTime()) {
      end = closingDateOf(day0.getFullYear(), day0.getMonth() + 1, closingDay);
    }
    var prevEnd = closingDateOf(end.getFullYear(), end.getMonth() - 1, closingDay);
    var start = T.addDays(prevEnd, 1);
    return buildPeriod(start, end);
  }

  function buildPeriod(start, end) {
    return {
      start: start,
      end: end,
      startKey: T.dateKey(start),
      endKey: T.dateKey(end),
      /** 清算期間ラベルは締め日(期間末)の年月で表す。例: 8/21〜9/20 -> "2026-09" */
      label: end.getFullYear() + '-' + T.pad2(end.getMonth() + 1),
      calendarDays: T.diffDays(end, start) + 1,
    };
  }

  /** 直前の清算期間 */
  function previousPeriod(period, closingDay) {
    return resolvePeriod(T.addDays(period.start, -1), closingDay);
  }

  /** 次の清算期間 */
  function nextPeriod(period, closingDay) {
    return resolvePeriod(T.addDays(period.end, 1), closingDay);
  }

  /** 期間内に date が含まれるか */
  function containsDate(period, date) {
    var t = T.startOfDay(date).getTime();
    return t >= period.start.getTime() && t <= period.end.getTime();
  }

  /** 期間開始日から date までの経過日数(開始日当日を1日目とする / SPEC 7.2) */
  function elapsedDays(period, date) {
    var t = T.startOfDay(date).getTime();
    if (t < period.start.getTime()) return 0;
    var capped = Math.min(t, period.end.getTime());
    return T.diffDays(new Date(capped), period.start) + 1;
  }

  /** 締め日まであと何日か(締め日当日は0) */
  function daysUntilClose(period, date) {
    return Math.max(0, T.diffDays(period.end, date));
  }

  WT.period = {
    closingDateOf: closingDateOf,
    resolvePeriod: resolvePeriod,
    buildPeriod: buildPeriod,
    previousPeriod: previousPeriod,
    nextPeriod: nextPeriod,
    containsDate: containsDate,
    elapsedDays: elapsedDays,
    daysUntilClose: daysUntilClose,
  };
})((globalThis.WT = globalThis.WT || {}));
