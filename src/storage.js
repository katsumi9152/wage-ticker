/**
 * storage.js — localStorage への保存と、清算期間のロールオーバー(SPEC 12 / 7.3)
 *
 * 個人データはサーバーへ一切送信せず、この端末のブラウザ内だけに保存する。
 * ロールオーバーの純粋ロジック(rollForward)は DOM にも localStorage にも依存しない
 * ので、そのままテストできる。
 */
(function (WT) {
  'use strict';

  var T = WT.time;
  var P = WT.period;
  var A = WT.aggregate;
  var K = WT.STORAGE_KEYS;

  function readJSON(key, fallback) {
    try {
      var raw = globalThis.localStorage ? globalThis.localStorage.getItem(key) : null;
      if (raw === null || raw === undefined) return fallback;
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      if (globalThis.localStorage) globalThis.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function mergeSettings(saved) {
    var out = {};
    var d = WT.DEFAULT_SETTINGS;
    for (var k in d) {
      if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    }
    if (saved && typeof saved === 'object') {
      for (var s in saved) {
        if (Object.prototype.hasOwnProperty.call(saved, s)) out[s] = saved[s];
      }
    }
    // 破損データへの保険
    if (!Array.isArray(out.workdays) || !out.workdays.length) out.workdays = WT.DEFAULT_SETTINGS.workdays.slice();
    if (!out.schedule || typeof out.schedule !== 'object') out.schedule = { start: '09:00', end: '17:30' };
    return out;
  }

  function emptyState() {
    return {
      status: 'off',
      clockInAt: null,
      isLegalHoliday: false,
      lastClockOutAt: null,
      overtimeFlag: false,
      autoDayKey: null,
      periodStartKey: null,
      configured: false,
    };
  }

  // ------------------------------------------------------- ロールオーバー

  /**
   * 締め日をまたいでいたら、清算期間を先に進める(SPEC 7.3 / 12 / 14)。
   *
   * 詳細ログを破棄する前に、必ず残業時間サマリーを履歴へ追記する順序を守る。
   *
   * @returns {{changed:boolean, calendar:object, previousLog:Array, history:Array,
   *            periodStartKey:string, closedPeriods:Array<string>}}
   */
  function rollForward(o) {
    var settings = o.settings;
    var calendar = o.calendar || {};
    var history = (o.history || []).slice();
    var previousLog = o.previousLog || [];
    var now = o.now;
    var current = P.resolvePeriod(now, settings.closingDay);
    var closed = [];

    if (!o.periodStartKey) {
      return {
        changed: false,
        calendar: calendar,
        previousLog: previousLog,
        history: history,
        periodStartKey: current.startKey,
        closedPeriods: closed,
      };
    }

    var p = P.resolvePeriod(T.parseDateKey(o.periodStartKey), settings.closingDay);
    var guard = 0;
    while (p.startKey !== current.startKey && guard++ < 36) {
      // 1) 確定させる(未入力日の自動加算も含めて確定 / SPEC 6.2)
      var agg = A.aggregatePeriod({
        period: p,
        settings: settings,
        calendar: calendar,
        activeSession: null,
        now: T.addDays(p.end, 1),
        finalize: true,
      });
      // 2) 残業時間サマリーを履歴へ追記(詳細ログ破棄より先に行う / SPEC 14)
      history.push(A.toHistoryRecord(p.label, agg.totals));
      if (history.length > WT.OVERTIME_HISTORY_MAX) {
        history = history.slice(history.length - WT.OVERTIME_HISTORY_MAX);
      }
      // 3) 直前の期間の日別ログだけを「先月」として残す
      previousLog = agg.days;
      closed.push(p.label);
      p = P.nextPeriod(p, settings.closingDay);
    }

    if (!closed.length) {
      return {
        changed: false,
        calendar: calendar,
        previousLog: previousLog,
        history: history,
        periodStartKey: current.startKey,
        closedPeriods: closed,
      };
    }

    // 4) カレンダーは「先月」の開始日以降だけ残す(SPEC 7.3)
    var keepFrom = P.previousPeriod(current, settings.closingDay).startKey;
    var pruned = {};
    for (var key in calendar) {
      if (Object.prototype.hasOwnProperty.call(calendar, key) && key >= keepFrom) {
        pruned[key] = calendar[key];
      }
    }

    return {
      changed: true,
      calendar: pruned,
      previousLog: previousLog,
      history: history,
      periodStartKey: current.startKey,
      closedPeriods: closed,
    };
  }

  // ---------------------------------------------------------------- Store

  var Store = {
    settings: null,
    state: null,
    calendar: null,
    history: null,
    previousLog: null,
    available: true,

    load: function () {
      try {
        this.available = !!globalThis.localStorage;
        if (this.available) {
          globalThis.localStorage.setItem('__wt_probe', '1');
          globalThis.localStorage.removeItem('__wt_probe');
        }
      } catch (e) {
        this.available = false;
      }
      var savedSettings = readJSON(K.settings, null);
      this.settings = mergeSettings(savedSettings);
      this.state = Object.assign(emptyState(), readJSON(K.state, {}));
      if (savedSettings && this.state.configured !== true) this.state.configured = true;
      this.calendar = readJSON(K.calendar, {});
      this.history = readJSON(K.overtimeHistory, []);
      this.previousLog = readJSON(K.previousLog, []);
      return this;
    },

    saveSettings: function () {
      writeJSON(K.settings, this.settings);
    },
    saveState: function () {
      writeJSON(K.state, this.state);
    },
    saveCalendar: function () {
      writeJSON(K.calendar, this.calendar);
    },
    saveHistory: function () {
      writeJSON(K.overtimeHistory, this.history);
    },
    savePreviousLog: function () {
      writeJSON(K.previousLog, this.previousLog);
    },
    /** 進行中の清算期間の日別ログ(SPEC 12 の wageCurrentPeriodLog)を書き出す */
    saveCurrentLog: function (days) {
      writeJSON(K.currentLog, days);
    },
    saveAll: function () {
      this.saveSettings();
      this.saveState();
      this.saveCalendar();
      this.saveHistory();
      this.savePreviousLog();
    },

    /** 締め日をまたいでいれば清算期間を進める */
    rollover: function (now) {
      var result = rollForward({
        settings: this.settings,
        calendar: this.calendar,
        history: this.history,
        previousLog: this.previousLog,
        periodStartKey: this.state.periodStartKey,
        now: now,
      });
      this.calendar = result.calendar;
      this.history = result.history;
      this.previousLog = result.previousLog;
      if (this.state.periodStartKey !== result.periodStartKey) {
        this.state.periodStartKey = result.periodStartKey;
        this.saveState();
      }
      if (result.changed) {
        this.saveCalendar();
        this.saveHistory();
        this.savePreviousLog();
        this.saveCurrentLog([]);
      }
      return result;
    },

    reset: function () {
      try {
        for (var name in K) {
          if (Object.prototype.hasOwnProperty.call(K, name)) globalThis.localStorage.removeItem(K[name]);
        }
      } catch (e) {
        /* noop */
      }
    },

    // ------------------------------------------------------------- 打刻

    /** 出勤(SPEC 5.1) */
    clockIn: function (nowMs) {
      var now = new Date(nowMs);
      this.state.status = 'working';
      this.state.clockInAt = nowMs;
      this.state.isLegalHoliday = A.judgeLegalHoliday(now, this.settings, this.calendar);
      this.state.overtimeFlag = false;
      this.saveState();
    },

    /** 退勤 */
    clockOut: function (nowMs) {
      if (this.state.status !== 'working' || !this.state.clockInAt) return;
      this.commitSession(this.state.clockInAt, nowMs, this.state.isLegalHoliday);
      this.state.status = 'off';
      this.state.clockInAt = null;
      this.state.lastClockOutAt = nowMs;
      this.state.overtimeFlag = false;
      this.saveState();
    },

    /** 打刻区間をカレンダーへ確定保存する(日をまたぐ場合は継続日へ印を付ける) */
    commitSession: function (startMs, endMs, isLegalHoliday) {
      if (!(endMs > startMs)) return;
      var startKey = T.dateKey(new Date(startMs));
      var existing = this.calendar[startKey] || {};
      var entry = {
        type: existing.type === 'company_holiday' ? 'company_holiday' : 'work',
        holidayKind: existing.holidayKind,
        clockIn: startMs,
        clockOut: endMs,
        isLegalHoliday: !!isLegalHoliday,
      };
      this.calendar[startKey] = entry;

      var endKey = T.dateKey(new Date(endMs));
      var d = T.addDays(T.parseDateKey(startKey), 1);
      var guard = 0;
      while (T.dateKey(d) <= endKey && guard++ < 5) {
        var k = T.dateKey(d);
        if (!this.calendar[k] || !this.calendar[k].clockIn) {
          this.calendar[k] = { type: 'work', coveredBy: startKey };
        }
        d = T.addDays(d, 1);
      }
      this.saveCalendar();
    },

    /** カレンダーから1日ぶんの指定を書き換える(有給・会社休日・打刻の追記/修正) */
    setDay: function (dateKeyStr, entry) {
      if (!entry) {
        delete this.calendar[dateKeyStr];
      } else {
        this.calendar[dateKeyStr] = entry;
      }
      this.saveCalendar();
    },
  };

  // ------------------------------------------------- 自動モードの状態解決

  /**
   * 自動モード(SPEC 5.3)の状態を解決する。
   * 手動モードの calcEarnings をそのまま流用できるよう、返すのは
   * 「進行中セッション {startMs, isLegalHoliday}」だけに揃える。
   *
   * @returns {{active:?object, finalized:boolean}}
   */
  function resolveAutoMode(store, nowMs) {
    var settings = store.settings;
    var state = store.state;
    if (!settings.autoMode) return { active: null, finalized: false };

    var now = new Date(nowMs);
    var todayKey = T.dateKey(now);

    // 日付が変わったら残業フラグをリセットする
    if (state.autoDayKey !== todayKey) {
      state.autoDayKey = todayKey;
      state.overtimeFlag = false;
      store.saveState();
    }

    var entry = store.calendar[todayKey];
    if (entry && (entry.clockOut || entry.type === 'paid_leave' || (entry.type === 'company_holiday' && !entry.clockIn))) {
      return { active: null, finalized: !!entry.clockOut };
    }
    if (!A.isScheduledWorkDay(now, settings, store.calendar)) {
      return { active: null, finalized: false };
    }

    var startMin = T.parseTimeToMinutes(settings.schedule && settings.schedule.start);
    var endMin = T.parseTimeToMinutes(settings.schedule && settings.schedule.end);
    if (startMin === null || endMin === null) return { active: null, finalized: false };

    var startMs = T.timeOnDate(now, startMin);
    var endMs = T.timeOnDate(now, endMin);
    if (endMs <= startMs) endMs += T.MS_PER_DAY;

    if (nowMs < startMs) return { active: null, finalized: false };

    if (nowMs >= endMs && !state.overtimeFlag) {
      // 「残業開始」が押されないまま退勤予定時刻を迎えたので自動確定(SPEC 5.3 / 14)
      store.commitSession(startMs, endMs, A.judgeLegalHoliday(now, settings, store.calendar));
      state.status = 'off';
      state.clockInAt = null;
      state.lastClockOutAt = endMs;
      store.saveState();
      return { active: null, finalized: true };
    }

    return {
      active: { startMs: startMs, isLegalHoliday: A.judgeLegalHoliday(now, settings, store.calendar), scheduledEndMs: endMs },
      finalized: false,
    };
  }

  WT.storage = {
    readJSON: readJSON,
    writeJSON: writeJSON,
    mergeSettings: mergeSettings,
    emptyState: emptyState,
    rollForward: rollForward,
    resolveAutoMode: resolveAutoMode,
    Store: Store,
  };
})((globalThis.WT = globalThis.WT || {}));
