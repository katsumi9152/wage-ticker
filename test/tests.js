/**
 * tests.js — 給与計算(純粋関数)のユニットテスト。
 * ブラウザで test/index.html を開くと実行される(Node なし・ビルド不要)。
 */
(function (WT) {
  'use strict';

  var T = WT.time;
  var P = WT.period;
  var W = WT.wage;
  var A = WT.aggregate;

  var cases = [];
  function test(name, fn) { cases.push({ name: name, fn: fn }); }

  function fail(msg) { throw new Error(msg); }
  function eq(actual, expected, msg) {
    if (actual !== expected) fail((msg || '') + ' — 期待値 ' + expected + ' / 実際 ' + actual);
  }
  function near(actual, expected, tol, msg) {
    if (Math.abs(actual - expected) > (tol === undefined ? 1e-6 : tol)) {
      fail((msg || '') + ' — 期待値 ' + expected + ' ± ' + tol + ' / 実際 ' + actual);
    }
  }
  function ok(cond, msg) { if (!cond) fail(msg || '条件を満たしていません'); }

  function at(y, m, d, hh, mm) {
    return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime();
  }
  function day(y, m, d) { return new Date(y, m - 1, d); }

  function baseSettings(over) {
    var s = {
      monthlyBaseSalary: 300000,
      dailyScheduledHours: 7.5,
      annualHolidays: 120,
      closingDay: 'last',
      legalHolidayWeekday: 0,
      workdays: [1, 2, 3, 4, 5],
      breakWindow: { start: '12:00', end: '13:00' },
      autoMode: false,
      schedule: { start: '09:00', end: '17:30' },
      // 既存のテストは祝日を考慮せずに書かれているため、ここでは既定オフにする。
      // 祝日との組み合わせは「祝日」のセクションで observeNationalHolidays: true を
      // 明示したテストで別途検証する。
      observeNationalHolidays: false,
    };
    for (var k in (over || {})) s[k] = over[k];
    return s;
  }

  // ------------------------------------------------------- 3.1 基礎単価

  test('3.1 月平均所定労働時間と基礎時給単価', function () {
    var r = W.deriveRates(baseSettings());
    eq(r.annualWorkDays, 245, '年間所定労働日数');
    near(r.monthlyAvgScheduledHours, 153.125, 1e-9, '月平均所定労働時間');
    near(r.baseHourlyRate, 300000 / 153.125, 1e-9, '基礎時給単価');
  });

  test('3.1 所定労働時間が違えば単価も変わる', function () {
    var r = W.deriveRates(baseSettings({ dailyScheduledHours: 8, annualHolidays: 125 }));
    eq(r.annualWorkDays, 240);
    near(r.monthlyAvgScheduledHours, 160, 1e-9);
    near(r.baseHourlyRate, 1875, 1e-9);
  });

  test('1日の所定労働時間は 勤務時間 − 休憩 で決まる', function () {
    var d = W.deriveDailyScheduledHours;
    near(d('09:00', '17:30', { start: '12:00', end: '13:00' }), 7.5, 1e-9, '既定の組み合わせ');
    near(d('09:00', '18:00', { start: '12:00', end: '13:00' }), 8, 1e-9);
    near(d('09:00', '18:00', null), 8, 1e-9, '休憩未登録なら一律60分を引く');
    near(d('08:30', '17:15', { start: '12:00', end: '12:45' }), 8, 1e-9, '45分休憩');
    near(d('13:00', '17:00', { start: '12:00', end: '13:00' }), 4, 1e-9, '勤務時間と重ならない休憩は引かない');
    near(d('22:00', '06:00', { start: '02:00', end: '03:00' }), 7, 1e-9, '日をまたぐ勤務');
    eq(d('', '17:30', null), null, '時刻が不正なら null');
  });

  // ------------------------------------------------- 清算期間(締め日)

  test('締め日=末日の清算期間', function () {
    var p = P.resolvePeriod(day(2026, 9, 10), 'last');
    eq(p.startKey, '2026-09-01');
    eq(p.endKey, '2026-09-30');
    eq(p.calendarDays, 30);
    eq(p.label, '2026-09');
  });

  test('締め日=20日の清算期間(締め日前後で切り替わる)', function () {
    var before = P.resolvePeriod(day(2026, 9, 10), 20);
    eq(before.startKey, '2026-08-21');
    eq(before.endKey, '2026-09-20');
    eq(before.calendarDays, 31);
    eq(before.label, '2026-09');

    var onClose = P.resolvePeriod(day(2026, 9, 20), 20);
    eq(onClose.endKey, '2026-09-20', '締め日当日はまだ当該期間');

    var after = P.resolvePeriod(day(2026, 9, 21), 20);
    eq(after.startKey, '2026-09-21');
    eq(after.endKey, '2026-10-20');
  });

  test('締め日=31日は短い月では月末に丸める', function () {
    var p = P.resolvePeriod(day(2026, 3, 15), 31);
    eq(p.startKey, '2026-03-01', '2月28日締めの翌日から');
    eq(p.endKey, '2026-03-31');

    var feb = P.resolvePeriod(day(2026, 2, 28), 31);
    eq(feb.startKey, '2026-02-01');
    eq(feb.endKey, '2026-02-28');
  });

  test('前後の清算期間と経過日数', function () {
    var p = P.resolvePeriod(day(2026, 9, 10), 20);
    var prev = P.previousPeriod(p, 20);
    eq(prev.startKey, '2026-07-21');
    eq(prev.endKey, '2026-08-20');
    eq(P.nextPeriod(p, 20).startKey, '2026-09-21');
    eq(P.elapsedDays(p, day(2026, 9, 10)), 21, '8/21起点で9/10は21日目');
    eq(P.daysUntilClose(p, day(2026, 9, 10)), 10);
  });

  // ------------------------------------------------------- 5.2 休憩控除

  test('5.2 休憩時間帯と重なれば自動控除される', function () {
    var r = W.sessionWork(at(2026, 9, 10, 9, 0), at(2026, 9, 10, 18, 0), { start: '12:00', end: '13:00' });
    near(r.rawMinutes, 540);
    near(r.deductedMinutes, 60);
    near(r.workedMinutes, 480);
  });

  test('5.2 休憩時間帯と重ならなければ控除されない(午後だけの半休出勤)', function () {
    var r = W.sessionWork(at(2026, 9, 10, 13, 0), at(2026, 9, 10, 20, 0), { start: '12:00', end: '13:00' });
    near(r.deductedMinutes, 0);
    near(r.workedMinutes, 420);
  });

  test('5.2 休憩の途中は控除が部分的に進む(カウンターが止まる)', function () {
    var r = W.sessionWork(at(2026, 9, 10, 9, 0), at(2026, 9, 10, 12, 30), { start: '12:00', end: '13:00' });
    near(r.deductedMinutes, 30);
    near(r.workedMinutes, 180, 1e-9, '12:00以降は実働が増えない');
    ok(W.isOnBreakAt(at(2026, 9, 10, 12, 30), at(2026, 9, 10, 9, 0), { start: '12:00', end: '13:00' }), '休憩中判定');
    ok(!W.isOnBreakAt(at(2026, 9, 10, 13, 30), at(2026, 9, 10, 9, 0), { start: '12:00', end: '13:00' }));
  });

  test('5.2 休憩時間帯が未登録なら一律60分を控除する(8時間で引き切る)', function () {
    var full = W.sessionWork(at(2026, 9, 10, 9, 0), at(2026, 9, 10, 18, 0), null);
    near(full.deductedMinutes, 60, 1e-9, '8時間以上働けば一律60分');
    near(full.workedMinutes, 480);

    var half = W.sessionWork(at(2026, 9, 10, 9, 0), at(2026, 9, 10, 13, 0), null);
    near(half.deductedMinutes, 30, 1e-9, '4時間時点では按分して30分');
    ok(half.workedMinutes > 0, '出勤直後でも実働がマイナスにならない');

    var justStarted = W.sessionWork(at(2026, 9, 10, 9, 0), at(2026, 9, 10, 9, 10), null);
    ok(justStarted.workedMinutes > 0, '出勤10分後でも金額は増え始めている');
  });

  // --------------------------------------------------------- 5.5 深夜帯

  test('5.5 深夜(22:00〜翌5:00)の重なりを分割できる', function () {
    var segs = T.splitByNight(at(2026, 9, 10, 20, 0), at(2026, 9, 11, 6, 0));
    var nightMinutes = 0, dayMinutes = 0;
    for (var i = 0; i < segs.length; i++) {
      var m = (segs[i].endMs - segs[i].startMs) / 60000;
      if (segs[i].isNight) nightMinutes += m; else dayMinutes += m;
    }
    near(nightMinutes, 420, 1e-9, '22:00〜5:00 の7時間');
    near(dayMinutes, 180, 1e-9, '20:00〜22:00 と 5:00〜6:00');
  });

  // ------------------------------------------------- 3.2/3.3 区分と割増

  test('3.2 所定内 → 法定内残業 → 法定時間外 の順に消化する', function () {
    var cursor = W.createCursor({ scheduledFrameMinutes: 600, legalFrameMinutes: 800 });
    var bd = W.allocateSegments(cursor, [{ minutes: 1000, isNight: false }], {
      isLegalHoliday: false, baseHourlyRate: 2000,
    });
    near(bd.scheduledInside.minutes, 600);
    near(bd.legalInsideOvertime.minutes, 200);
    near(bd.statutoryOvertime.minutes, 200);
    near(bd.scheduledInside.amount, (600 / 60) * 1.0 * 2000);
    near(bd.legalInsideOvertime.amount, (200 / 60) * 1.0 * 2000);
    near(bd.statutoryOvertime.amount, (200 / 60) * 1.25 * 2000);
    near(bd.extraAmount, bd.amount - bd.scheduledInside.amount);
  });

  test('3.3 月60時間を超えた法定時間外は1.50倍になる', function () {
    var cursor = W.createCursor({ scheduledFrameMinutes: 0, legalFrameMinutes: 0 });
    cursor.statutoryOvertimeMinutes = 59 * 60;
    var bd = W.allocateSegments(cursor, [{ minutes: 120, isNight: false }], {
      isLegalHoliday: false, baseHourlyRate: 2000,
    });
    near(bd.statutoryOvertime.minutes, 60, 1e-9, '60hに達するまでは1.25');
    near(bd.statutoryOvertimeOver60.minutes, 60, 1e-9, '超えた分は1.50');
    near(bd.amount, (60 / 60) * 1.25 * 2000 + (60 / 60) * 1.5 * 2000);
  });

  test('固定残業代: 決めた時間までは割増を上乗せせず、超えた分から1.25倍', function () {
    // 固定残業 20時間 / 40,000円、基礎時給 2,000円
    var frames = {
      scheduledFrameMinutes: 0,
      legalFrameMinutes: 0,
      fixedOvertimeMinutes: 20 * 60,
      fixedOvertimeAllowance: 40000,
    };

    // ① 10時間だけ働いた場合: 固定残業の枠内。40,000円の半分が積み上がる。
    var c1 = W.createCursor(frames);
    var bd1 = W.allocateSegments(c1, [{ minutes: 600, isNight: false }], {
      isLegalHoliday: false, baseHourlyRate: 2000,
    });
    near(bd1.fixedOvertime.minutes, 600);
    near(bd1.fixedOvertime.amount, 20000, 1e-6, '月額を時間で均して積む');
    near(bd1.statutoryOvertime.minutes, 0, 1e-9, '枠内で割増が発生している');
    near(bd1.amount, 20000, 1e-6);

    // ② 30時間働いた場合: 20時間ぶんの固定残業代 + 超過10時間の 1.25倍
    var c2 = W.createCursor(frames);
    var bd2 = W.allocateSegments(c2, [{ minutes: 1800, isNight: false }], {
      isLegalHoliday: false, baseHourlyRate: 2000,
    });
    near(bd2.fixedOvertime.minutes, 1200);
    near(bd2.fixedOvertime.amount, 40000, 1e-6, '固定残業代は満額まで');
    near(bd2.statutoryOvertime.minutes, 600, 1e-9, '超過分だけ割増の対象');
    near(bd2.statutoryOvertime.amount, 10 * 1.25 * 2000, 1e-6);
    near(bd2.amount, 40000 + 25000, 1e-6);
  });

  test('固定残業代: 月60時間のラインは固定残業ぶんも含めて数える', function () {
    var frames = {
      scheduledFrameMinutes: 0,
      legalFrameMinutes: 0,
      fixedOvertimeMinutes: 60 * 60, // 固定残業60時間
      fixedOvertimeAllowance: 120000,
    };
    var cursor = W.createCursor(frames);
    var bd = W.allocateSegments(cursor, [{ minutes: 70 * 60, isNight: false }], {
      isLegalHoliday: false, baseHourlyRate: 2000,
    });
    near(bd.fixedOvertime.minutes, 60 * 60);
    near(bd.statutoryOvertime.minutes, 0, 1e-9, '60時間を過ぎているので1.25は出ない');
    near(bd.statutoryOvertimeOver60.minutes, 10 * 60, 1e-9, '超過分は1.50倍');
    near(bd.statutoryOvertimeOver60.amount, 10 * 1.5 * 2000, 1e-6);
  });

  test('固定残業代が0なら、これまでどおり最初から割増がつく', function () {
    var cursor = W.createCursor({ scheduledFrameMinutes: 0, legalFrameMinutes: 0 });
    var bd = W.allocateSegments(cursor, [{ minutes: 600, isNight: false }], {
      isLegalHoliday: false, baseHourlyRate: 2000,
    });
    near(bd.fixedOvertime.minutes, 0);
    near(bd.statutoryOvertime.minutes, 600);
    near(bd.amount, 10 * 1.25 * 2000, 1e-6);
  });

  test('3.3 深夜は他の割増に +0.25 で加算される', function () {
    var cursor = W.createCursor({ scheduledFrameMinutes: 0, legalFrameMinutes: 0 });
    var bd = W.allocateSegments(cursor, [{ minutes: 60, isNight: true }], {
      isLegalHoliday: false, baseHourlyRate: 2000,
    });
    near(bd.statutoryOvertime.minutes, 60);
    near(bd.night.minutes, 60);
    near(bd.amount, 2000 * 1.25 + 2000 * 0.25, 1e-9, '時間外+深夜 = 1.50');
  });

  test('3.3 法定休日は1.35倍、深夜と重なれば1.60倍', function () {
    var cursor = W.createCursor({ scheduledFrameMinutes: 1000, legalFrameMinutes: 1200 });
    var bd = W.allocateSegments(cursor, [
      { minutes: 60, isNight: false },
      { minutes: 60, isNight: true },
    ], { isLegalHoliday: true, baseHourlyRate: 2000 });
    near(bd.legalHoliday.minutes, 120);
    near(bd.scheduledInside.minutes, 0, 1e-9, '所定内の枠は使わない');
    near(bd.amount, 2000 * 1.35 + 2000 * 1.6, 1e-9);
    near(cursor.frameMinutes, 0, 1e-9, '法定休日労働は時間外の総枠に算入しない');
    near(cursor.holidayMinutes, 120);
  });

  test('3.3 所定休日(法定超)の出勤は通常の枠組みで計算する', function () {
    var cursor = W.createCursor({ scheduledFrameMinutes: 60, legalFrameMinutes: 120 });
    var bd = W.allocateSegments(cursor, [{ minutes: 180, isNight: false }], {
      isLegalHoliday: false, baseHourlyRate: 2000,
    });
    near(bd.legalHoliday.minutes, 0, 1e-9, '35%増にはしない');
    near(bd.scheduledInside.minutes, 60);
    near(bd.legalInsideOvertime.minutes, 60);
    near(bd.statutoryOvertime.minutes, 60);
  });

  test('現在の限界単価(色味の切り替えに使う)', function () {
    var cursor = W.createCursor({ scheduledFrameMinutes: 600, legalFrameMinutes: 800 });
    var rates = { baseHourlyRate: 2000 };
    eq(W.marginalRate(cursor, rates, {}).kind, 'scheduledInside');
    cursor.frameMinutes = 700;
    eq(W.marginalRate(cursor, rates, {}).kind, 'legalInsideOvertime');
    cursor.frameMinutes = 900;
    eq(W.marginalRate(cursor, rates, {}).kind, 'statutoryOvertime');
    near(W.marginalRate(cursor, rates, { isNight: true }).rate, 1.5);
    eq(W.marginalRate(cursor, rates, { onBreak: true }).perMs, 0, '休憩中は増えない');
  });

  // ------------------------------------------------- 6章 有給・未入力日

  test('3.2 総枠は所定労働日数と暦日数から決まる', function () {
    var period = P.resolvePeriod(day(2026, 9, 10), 'last');
    var frames = A.computeFrames(period, baseSettings(), {});
    eq(frames.scheduledWorkDays, 22, '2026年9月の平日は22日');
    near(frames.scheduledFrameMinutes, 22 * 7.5 * 60);
    near(frames.legalFrameMinutes, (40 * 30 * 60) / 7);
  });

  // -------------------------------------------------------------- 祝日

  test('祝日: 既定(オン)では総枠の所定労働日数から祝日が除かれる', function () {
    // 2026年9月: 敬老の日(9/21・月)、国民の休日(9/22・火)、秋分の日(9/23・水)の
    // 3つの平日が祝日にあたるため、22日(平日数)から3日引いた19日になる
    var period = P.resolvePeriod(day(2026, 9, 10), 'last');
    var frames = A.computeFrames(period, baseSettings({ observeNationalHolidays: true }), {});
    eq(frames.scheduledWorkDays, 19, '祝日3日ぶんが所定労働日数から除かれていない');
    near(frames.scheduledFrameMinutes, 19 * 7.5 * 60);
  });

  test('祝日: オフにすると従来どおり曜日だけで判定する', function () {
    var period = P.resolvePeriod(day(2026, 9, 10), 'last');
    var frames = A.computeFrames(period, baseSettings({ observeNationalHolidays: false }), {});
    eq(frames.scheduledWorkDays, 22, 'オフなら祝日を考慮しない');
  });

  test('祝日: 未入力日として自動加算されない', function () {
    var settings = baseSettings({ observeNationalHolidays: true });
    var period = P.resolvePeriod(day(2026, 9, 25), 'last');
    var agg = A.aggregatePeriod({
      period: period, settings: settings, calendar: {}, activeSession: null, now: day(2026, 9, 25),
    });
    eq(agg.unfilledDates.indexOf('2026-09-21'), -1, '敬老の日(月)が未入力日として加算されている');
    eq(agg.unfilledDates.indexOf('2026-09-22'), -1, '国民の休日(火)が未入力日として加算されている');
    eq(agg.unfilledDates.indexOf('2026-09-23'), -1, '秋分の日(水)が未入力日として加算されている');
    // 9/24(木)は祝日ではない平日なので、通常どおり未入力日になる
    ok(agg.unfilledDates.indexOf('2026-09-24') >= 0, '祝日でない平日まで除外されてしまっている');
  });

  test('祝日: 実際に出勤すれば所定休日(法定超)出勤として通常どおり記録される', function () {
    var settings = baseSettings({ observeNationalHolidays: true });
    var calendar = {
      '2026-09-21': { type: 'work', clockIn: at(2026, 9, 21, 9, 0), clockOut: at(2026, 9, 21, 17, 30), isLegalHoliday: false },
    };
    var period = P.resolvePeriod(day(2026, 9, 25), 'last');
    var agg = A.aggregatePeriod({
      period: period, settings: settings, calendar: calendar, activeSession: null, now: day(2026, 9, 25),
    });
    var rec = null;
    for (var i = 0; i < agg.days.length; i++) { if (agg.days[i].date === '2026-09-21') rec = agg.days[i]; }
    ok(!!rec, '祝日に出勤した記録が無い');
    eq(rec.kind, 'work');
    ok(rec.breakdown.legalHoliday.minutes === 0, '祝日出勤は法定休日(35%増)の対象ではない');
    // 祝日は所定労働日数に数えないため、総枠計算に混ざらず通常の①②③の枠組みで計算される
    ok(rec.breakdown.amount > 0);
  });

  test('祝日: 会社休日の明示指定はいつでも祝日判定より優先する', function () {
    var settings = baseSettings({ observeNationalHolidays: true });
    // 元日(1/1)を「所定休日(法定超)」ではなく「法定休日」として明示指定した場合
    var calendar = { '2026-01-01': { type: 'company_holiday', holidayKind: 'legal' } };
    ok(!A.isScheduledWorkDay(day(2026, 1, 1), settings, calendar), '会社休日の指定後も所定労働日から除外されているはず');
    eq(A.judgeLegalHoliday(day(2026, 1, 1), settings, calendar), true, '明示指定が優先されるはず');
  });

  test('6.2 過ぎた所定労働日の未入力は所定内で自動加算する', function () {
    var settings = baseSettings();
    var period = P.resolvePeriod(day(2026, 9, 10), 'last');
    var agg = A.aggregatePeriod({ period: period, settings: settings, calendar: {}, activeSession: null, now: day(2026, 9, 10) });
    eq(agg.autoFilledDays, 7, '9/1〜9/9 の平日7日');
    near(agg.totals.workedMinutes, 7 * 450);
    near(agg.totals.autoFilledMinutes, 7 * 450);
    near(agg.totals.statutoryOvertime.minutes, 0, 1e-9, '未入力日に残業はつけない');
    eq(agg.unfilledDates.length, 7);
    eq(agg.unfilledDates[0], '2026-09-01');
    ok(agg.totals.amount > 0);
  });

  test('6.1 有給は所定労働時間ぶんを所定内として計上する', function () {
    var settings = baseSettings();
    var calendar = { '2026-09-03': { type: 'paid_leave' } };
    var period = P.resolvePeriod(day(2026, 9, 10), 'last');
    var agg = A.aggregatePeriod({ period: period, settings: settings, calendar: calendar, activeSession: null, now: day(2026, 9, 10) });
    eq(agg.autoFilledDays, 6, '有給の日は未入力に数えない');
    near(agg.totals.workedMinutes, 7 * 450, 1e-9, '合計時間は変わらない');
    near(agg.totals.autoFilledMinutes, 6 * 450);
    near(agg.totals.night.minutes, 0);
  });

  test('6.1 会社休日は所定労働日から外れ、未入力にもならない', function () {
    var settings = baseSettings();
    var calendar = { '2026-09-04': { type: 'company_holiday', holidayKind: 'scheduled' } };
    var period = P.resolvePeriod(day(2026, 9, 10), 'last');
    var frames = A.computeFrames(period, settings, calendar);
    eq(frames.scheduledWorkDays, 21);
    var agg = A.aggregatePeriod({ period: period, settings: settings, calendar: calendar, activeSession: null, now: day(2026, 9, 10) });
    eq(agg.autoFilledDays, 6);
    near(agg.totals.workedMinutes, 6 * 450);
  });

  test('6.1 法定休日の判定(曜日設定 / カレンダー指定の上書き)', function () {
    var settings = baseSettings();
    ok(A.judgeLegalHoliday(day(2026, 9, 6), settings, {}), '日曜は法定休日');
    ok(!A.judgeLegalHoliday(day(2026, 9, 5), settings, {}), '土曜は所定休日(法定超)');
    ok(!A.judgeLegalHoliday(day(2026, 9, 7), settings, {}), '平日は休日ではない');
    ok(A.judgeLegalHoliday(day(2026, 9, 5), settings, {
      '2026-09-05': { type: 'company_holiday', holidayKind: 'legal' },
    }), 'カレンダー指定で法定休日にできる');
  });

  test('徹夜勤務は出勤した日の労働として通算する', function () {
    // 労基法の解釈では、継続勤務が2暦日にわたる場合は始業日の労働として扱う
    var settings = baseSettings();
    var calendar = {
      '2026-09-03': {
        type: 'work',
        clockIn: at(2026, 9, 3, 21, 0),
        clockOut: at(2026, 9, 4, 6, 0),
        isLegalHoliday: false,
      },
      // 翌日は「継続日」の印。二重に数えないための目印。
      '2026-09-04': { type: 'work', coveredBy: '2026-09-03' },
    };
    var period = P.resolvePeriod(day(2026, 9, 10), 'last');
    var agg = A.aggregatePeriod({ period: period, settings: settings, calendar: calendar, activeSession: null, now: day(2026, 9, 10) });

    var overnight = null;
    for (var i = 0; i < agg.days.length; i++) {
      if (agg.days[i].date === '2026-09-03') overnight = agg.days[i];
    }
    ok(!!overnight, '出勤した日の記録になっていない');
    near(overnight.workedMinutes, 540, 1e-9, '21:00〜6:00 の9時間');
    near(overnight.breakdown.night.minutes, 420, 1e-9, '22:00〜5:00 の7時間が深夜割増');
    eq(agg.unfilledDates.indexOf('2026-09-04'), -1, '翌日を未入力として二重に数えてはいけない');
  });

  test('打刻ありの日は3〜5章のロジックで再計算される', function () {
    var settings = baseSettings();
    var calendar = {
      '2026-09-01': { type: 'work', clockIn: at(2026, 9, 1, 9, 0), clockOut: at(2026, 9, 1, 23, 0), isLegalHoliday: false },
    };
    var period = P.resolvePeriod(day(2026, 9, 10), 'last');
    var agg = A.aggregatePeriod({ period: period, settings: settings, calendar: calendar, activeSession: null, now: day(2026, 9, 10) });
    var d = agg.days[0];
    eq(d.kind, 'work');
    near(d.rawMinutes, 840);
    near(d.deductedMinutes, 60, 1e-9, '12:00〜13:00 を控除');
    near(d.workedMinutes, 780);
    near(d.breakdown.night.minutes, 60, 1e-9, '22:00〜23:00 は深夜割増');
  });

  test('進行中の勤務は確定分と二重計上されない', function () {
    var settings = baseSettings();
    var period = P.resolvePeriod(day(2026, 9, 10), 'last');
    var active = { startMs: at(2026, 9, 10, 9, 0), isLegalHoliday: false };
    var agg = A.aggregatePeriod({
      period: period, settings: settings, calendar: {}, activeSession: active, now: new Date(at(2026, 9, 10, 15, 0)),
    });
    near(agg.todayFinalized.workedMinutes, 0, 1e-9, '当日ぶんは確定側に入らない');
    var live = A.computeLive(agg, active, settings, at(2026, 9, 10, 15, 0));
    near(live.workedMinutes, 300, 1e-9, '6時間 − 休憩60分');
    ok(live.breakdown.amount > 0);
    eq(live.marginal.kind, 'scheduledInside');
  });

  test('進行中の勤務がある日は未入力の自動加算をしない', function () {
    var settings = baseSettings();
    var period = P.resolvePeriod(day(2026, 9, 10), 'last');
    // 前日22時に出勤して日をまたいで勤務中(9/9 は未入力扱いにしてはいけない)
    var active = { startMs: at(2026, 9, 9, 22, 0), isLegalHoliday: false };
    var agg = A.aggregatePeriod({
      period: period, settings: settings, calendar: {}, activeSession: active, now: new Date(at(2026, 9, 10, 3, 0)),
    });
    eq(agg.unfilledDates.indexOf('2026-09-09'), -1);
    eq(agg.autoFilledDays, 6);
  });

  // --------------------------------------------------------- 7.2 前月比

  test('7.2 前月比較は同じ経過日数どうしで行う', function () {
    function dayRec(dateKey, amount, minutes) {
      var bd = W.emptyBreakdown();
      bd.amount = amount;
      bd.workedMinutes = minutes;
      return { date: dateKey, breakdown: bd };
    }
    var prevPeriod = P.resolvePeriod(day(2026, 8, 10), 'last');
    var prevDays = [
      dayRec('2026-08-03', 10000, 450),
      dayRec('2026-08-04', 10000, 450),
      dayRec('2026-08-05', 10000, 450),
      dayRec('2026-08-20', 10000, 450),
    ];
    var current = W.emptyBreakdown();
    current.amount = 25000;
    current.workedMinutes = 900;

    var cmp = A.comparePrevious(current, prevDays, prevPeriod, 5);
    near(cmp.baseAmount, 30000, 1e-9, '先月の5日目までは3日ぶん');
    near(cmp.amountDiff, -5000);
    near(cmp.minutesDiff, 900 - 1350);
    eq(A.comparePrevious(current, [], prevPeriod, 5), null, 'データがなければ比較しない');
  });

  // ---------------------------------------------------- 7.4/8.1 36協定

  test('7.4 確定した期間から残業サマリーを作る', function () {
    var bd = W.emptyBreakdown();
    bd.legalInsideOvertime.minutes = 600;
    bd.statutoryOvertime.minutes = 1800;
    bd.statutoryOvertimeOver60.minutes = 600;
    bd.legalHoliday.minutes = 480;
    bd.workedMinutes = 12000;
    var rec = A.toHistoryRecord('2026-08', bd);
    eq(rec.label, '2026-08');
    near(rec.legalInsideOvertimeHours, 10);
    near(rec.statutoryOvertimeHours, 40);
    near(rec.legalHolidayHours, 8);
    near(rec.totalWorkedHours, 200);
  });

  test('7.4 履歴は12ヶ月を超えたら古いものから消える', function () {
    var settings = baseSettings();
    var history = [];
    for (var i = 0; i < 12; i++) history.push({ label: 'x' + i, statutoryOvertimeHours: 1, legalHolidayHours: 0, totalWorkedHours: 1 });
    var res = WT.storage.rollForward({
      settings: settings, calendar: {}, history: history, previousLog: [],
      periodStartKey: '2026-08-01', now: day(2026, 9, 10),
    });
    eq(res.history.length, 12);
    eq(res.history[0].label, 'x1', '最古が押し出される');
    eq(res.history[11].label, '2026-08', '確定した期間が末尾に入る');
  });

  // ------------------------------------------------- 残業メーターの見え方

  test('残業メーター: 目盛りは0〜60時間で固定し、超えたら100%で頭打ち', function () {
    var m1 = A.overtimeMeter(30 * 60, 0);
    near(m1.fillPercent, 50, 1e-9, '30時間は60時間目盛りの半分');
    ok(!m1.over45 && !m1.over60);

    var m2 = A.overtimeMeter(50 * 60, 0);
    near(m2.fillPercent, (50 / 60) * 100, 1e-9);
    ok(m2.over45, '45時間を超えたら over45');
    ok(!m2.over60);

    var m3 = A.overtimeMeter(90 * 60, 0);
    eq(m3.fillPercent, 100, '60時間を超えても塗りは100%で頭打ち');
    ok(m3.over45 && m3.over60, '60時間を超えたら over45 と over60 の両方が立つ');
  });

  test('残業メーター: 固定残業の目印位置は60時間目盛り基準', function () {
    var withFixed = A.overtimeMeter(10 * 60, 30 * 60);
    eq(withFixed.fixedPercent, 50, '固定残業30時間は60時間目盛りの半分の位置');

    var noFixed = A.overtimeMeter(10 * 60, 0);
    eq(noFixed.fixedPercent, null, '固定残業0なら目印を出さない(null)');
  });

  test('残業メーター: 45時間・60時間の目印位置は固定値', function () {
    var m = A.overtimeMeter(0, 0);
    near(m.mark45Percent, 75, 1e-9, '45時間は60時間目盛りの75%の位置');
    eq(m.mark60Percent, 100);
  });

  // ------------------------------------------------------ 8.2 気づき

  test('8.2 休憩未取得の目安', function () {
    eq(A.breakNotice(300, 0), null, '5時間なら表示しない');
    eq(A.breakNotice(400, 0).threshold, 6);
    eq(A.breakNotice(500, 0).threshold, 8);
    eq(A.breakNotice(500, 60), null, '控除があれば表示しない');
  });

  // -------------------------------------------- 7.3/12 ロールオーバー

  test('7.3 締め日をまたぐと履歴に追記してから詳細ログを整理する', function () {
    var settings = baseSettings();
    var calendar = {
      '2026-06-15': { type: 'work', clockIn: at(2026, 6, 15, 9, 0), clockOut: at(2026, 6, 15, 18, 0) },
      '2026-08-03': { type: 'work', clockIn: at(2026, 8, 3, 9, 0), clockOut: at(2026, 8, 3, 20, 0) },
    };
    var res = WT.storage.rollForward({
      settings: settings, calendar: calendar, history: [], previousLog: [],
      periodStartKey: '2026-08-01', now: day(2026, 9, 10),
    });
    ok(res.changed, '締め処理が走る');
    eq(res.closedPeriods.length, 1);
    eq(res.closedPeriods[0], '2026-08');
    eq(res.history.length, 1);
    eq(res.periodStartKey, '2026-09-01');
    ok(res.previousLog.length > 0, '先月の日別ログが残る');
    ok(res.history[0].totalWorkedHours > 0, '残業サマリーは詳細ログ破棄より先に作られる');
    ok(!res.calendar['2026-06-15'], '前々月以前の日別データは削除される');
    ok(!!res.calendar['2026-08-03'], '先月ぶんは残る');
  });

  test('7.3 同じ清算期間の間は何も起こらない', function () {
    var res = WT.storage.rollForward({
      settings: baseSettings(), calendar: {}, history: [], previousLog: [],
      periodStartKey: '2026-09-01', now: day(2026, 9, 10),
    });
    ok(!res.changed);
    eq(res.history.length, 0);
  });

  test('7.3 数ヶ月ぶりに開いても各月が履歴に残る', function () {
    var res = WT.storage.rollForward({
      settings: baseSettings(), calendar: {}, history: [], previousLog: [],
      periodStartKey: '2026-06-01', now: day(2026, 9, 10),
    });
    eq(res.closedPeriods.join(','), '2026-06,2026-07,2026-08');
    eq(res.history.length, 3);
  });

  // ------------------------------------------------------------ 実行

  function run() {
    var results = [];
    var passed = 0;
    for (var i = 0; i < cases.length; i++) {
      try {
        cases[i].fn();
        results.push({ name: cases[i].name, ok: true });
        passed++;
      } catch (e) {
        results.push({ name: cases[i].name, ok: false, message: e && e.message ? e.message : String(e) });
      }
    }
    return { results: results, passed: passed, total: cases.length };
  }

  WT.tests = { run: run, cases: cases };
})((globalThis.WT = globalThis.WT || {}));
