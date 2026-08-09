/**
 * time.js — 日付・時刻のユーティリティ(純粋関数のみ / DOM 非依存)
 *
 * すべてローカルタイム基準。日本にはサマータイムがないため、
 * 「その日の 00:00」「その日の HH:MM」は素直に Date のローカル API で扱う。
 */
(function (WT) {
  'use strict';

  var MS_PER_MINUTE = 60000;
  var MS_PER_DAY = 86400000;

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** Date -> "YYYY-MM-DD"(ローカル) */
  function dateKey(d) {
    var x = d instanceof Date ? d : new Date(d);
    return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
  }

  /** "YYYY-MM-DD" -> その日の 00:00 の Date */
  function parseDateKey(key) {
    var p = String(key).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function startOfDay(d) {
    var x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addDays(d, n) {
    var x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  /** 日数差(暦日ベース) */
  function diffDays(a, b) {
    return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / MS_PER_DAY);
  }

  function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }

  /** "HH:MM" -> 0:00 からの分数。不正値は null。 */
  function parseTimeToMinutes(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return null;
    var h = Number(m[1]);
    var mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  /** 分数 -> "H:MM"(表示用) */
  function formatMinutes(minutes) {
    var total = Math.max(0, Math.floor(minutes));
    var h = Math.floor(total / 60);
    var m = total % 60;
    return h + ':' + pad2(m);
  }

  /** 分数 -> "H時間MM分" */
  function formatMinutesJa(minutes) {
    var total = Math.max(0, Math.round(minutes));
    var h = Math.floor(total / 60);
    var m = total % 60;
    return h + '時間' + pad2(m) + '分';
  }

  /** その日(dateOrMs の属する日)の HH:MM のエポックミリ秒 */
  function timeOnDate(dateOrMs, minutesOfDay) {
    var x = startOfDay(dateOrMs);
    return x.getTime() + minutesOfDay * MS_PER_MINUTE;
  }

  /** 22:00〜翌5:00 に該当するか(SPEC 5.5) */
  function isNightMs(ms) {
    var h = new Date(ms).getHours();
    return h >= WT.NIGHT_START_HOUR || h < WT.NIGHT_END_HOUR;
  }

  /** ms の直後に来る深夜帯の境界(5:00 または 22:00) */
  function nextNightBoundary(ms) {
    var d = new Date(ms);
    var h = d.getHours();
    if (h < WT.NIGHT_END_HOUR) return timeOnDate(ms, WT.NIGHT_END_HOUR * 60);
    if (h < WT.NIGHT_START_HOUR) return timeOnDate(ms, WT.NIGHT_START_HOUR * 60);
    return timeOnDate(addDays(d, 1), WT.NIGHT_END_HOUR * 60);
  }

  /**
   * 区間 [startMs, endMs) を深夜/非深夜の連続区間に分割する。
   * 返り値は時系列順の [{ startMs, endMs, isNight }]。
   */
  function splitByNight(startMs, endMs) {
    var out = [];
    if (!(endMs > startMs)) return out;
    var cur = startMs;
    var guard = 0;
    while (cur < endMs && guard++ < 5000) {
      var next = Math.min(endMs, nextNightBoundary(cur));
      out.push({ startMs: cur, endMs: next, isNight: isNightMs(cur) });
      cur = next;
    }
    return out;
  }

  /** 区間リストから windows(=休憩帯)を差し引く。順序は保たれる。 */
  function subtractWindows(segments, windows) {
    var result = segments.slice();
    for (var w = 0; w < windows.length; w++) {
      var win = windows[w];
      var next = [];
      for (var i = 0; i < result.length; i++) {
        var s = result[i];
        if (win.endMs <= s.startMs || win.startMs >= s.endMs) {
          next.push(s);
          continue;
        }
        if (s.startMs < win.startMs) {
          next.push({ startMs: s.startMs, endMs: win.startMs, isNight: s.isNight });
        }
        if (win.endMs < s.endMs) {
          next.push({ startMs: win.endMs, endMs: s.endMs, isNight: s.isNight });
        }
      }
      result = next;
    }
    return result;
  }

  /**
   * [startMs, endMs) に掛かる各日の休憩帯を列挙する。
   * end <= start の休憩帯(例 23:00-01:00)は日をまたぐものとして扱う。
   */
  function breakWindowsIn(startMs, endMs, breakWindow) {
    var startMin = parseTimeToMinutes(breakWindow && breakWindow.start);
    var endMin = parseTimeToMinutes(breakWindow && breakWindow.end);
    if (startMin === null || endMin === null || startMin === endMin) return [];
    var lengthMin = endMin > startMin ? endMin - startMin : 24 * 60 - startMin + endMin;
    var windows = [];
    var day = startOfDay(addDays(new Date(startMs), -1));
    var last = startOfDay(new Date(endMs));
    var guard = 0;
    while (day.getTime() <= last.getTime() && guard++ < 400) {
      var s = timeOnDate(day, startMin);
      windows.push({ startMs: s, endMs: s + lengthMin * MS_PER_MINUTE });
      day = addDays(day, 1);
    }
    return windows;
  }

  /** 区間リストの合計分数 */
  function totalMinutes(segments) {
    var sum = 0;
    for (var i = 0; i < segments.length; i++) {
      sum += (segments[i].endMs - segments[i].startMs) / MS_PER_MINUTE;
    }
    return sum;
  }

  /** 先頭から minutes 分だけ削り取る(一律控除を「出勤直後に休憩した」とみなす) */
  function trimFromStart(segments, minutes) {
    var remain = minutes;
    var out = [];
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      var len = (s.endMs - s.startMs) / MS_PER_MINUTE;
      if (remain <= 0) {
        out.push(s);
      } else if (remain >= len) {
        remain -= len;
      } else {
        out.push({ startMs: s.startMs + remain * MS_PER_MINUTE, endMs: s.endMs, isNight: s.isNight });
        remain = 0;
      }
    }
    return out;
  }

  WT.time = {
    MS_PER_MINUTE: MS_PER_MINUTE,
    MS_PER_DAY: MS_PER_DAY,
    pad2: pad2,
    dateKey: dateKey,
    parseDateKey: parseDateKey,
    startOfDay: startOfDay,
    addDays: addDays,
    diffDays: diffDays,
    daysInMonth: daysInMonth,
    parseTimeToMinutes: parseTimeToMinutes,
    formatMinutes: formatMinutes,
    formatMinutesJa: formatMinutesJa,
    timeOnDate: timeOnDate,
    isNightMs: isNightMs,
    nextNightBoundary: nextNightBoundary,
    splitByNight: splitByNight,
    subtractWindows: subtractWindows,
    breakWindowsIn: breakWindowsIn,
    totalMinutes: totalMinutes,
    trimFromStart: trimFromStart,
  };
})((globalThis.WT = globalThis.WT || {}));
