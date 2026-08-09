/**
 * holidays.js のテスト — 実際の祝日カレンダーと突き合わせて検証する。
 * ブラウザでは test/index.html から、コマンドラインでは test/run.ps1 から読み込む。
 */
(function (WT) {
  'use strict';

  var H = WT.holidays;
  var T = WT.time;

  var cases = [];
  function test(name, fn) { cases.push({ name: name, fn: fn }); }
  function fail(msg) { throw new Error(msg); }
  function eq(actual, expected, msg) {
    if (actual !== expected) fail((msg || '') + ' — 期待値 ' + expected + ' / 実際 ' + actual);
  }
  function ok(cond, msg) { if (!cond) fail(msg || '条件を満たしていません'); }
  function d(y, m, day) { return new Date(y, m - 1, day); }

  function nameOn(y, m, day) {
    var h = H.isNationalHoliday(d(y, m, day));
    return h ? h.name : null;
  }

  // ---------------------------------------------------- 固定日の祝日

  test('固定日の祝日(2026年)', function () {
    eq(nameOn(2026, 1, 1), '元日');
    eq(nameOn(2026, 2, 11), '建国記念の日');
    eq(nameOn(2026, 2, 23), '天皇誕生日');
    eq(nameOn(2026, 4, 29), '昭和の日');
    eq(nameOn(2026, 5, 3), '憲法記念日');
    eq(nameOn(2026, 5, 4), 'みどりの日');
    eq(nameOn(2026, 5, 5), 'こどもの日');
    eq(nameOn(2026, 8, 11), '山の日');
    eq(nameOn(2026, 11, 3), '文化の日');
    eq(nameOn(2026, 11, 23), '勤労感謝の日');
  });

  test('平日は祝日ではない', function () {
    eq(nameOn(2026, 1, 2), null);
    eq(nameOn(2026, 6, 15), null);
  });

  // -------------------------------------------------- 月曜移動の祝日

  test('成人の日(1月第2月曜)', function () {
    // 2026年1月は 1/1(木)始まり → 第2月曜は 1/12
    var h = d(2026, 1, 12);
    eq(h.getDay(), 1, 'テストの前提: 1/12は月曜のはず');
    eq(nameOn(2026, 1, 12), '成人の日');
  });

  test('海の日(7月第3月曜、2003年以降)', function () {
    // 2026年7月は 7/1(水)始まり → 第3月曜は 7/20
    eq(nameOn(2026, 7, 20), '海の日');
  });

  test('敬老の日(9月第3月曜、2003年以降)', function () {
    // 2026年9月は 9/1(火)始まり → 第3月曜は 9/21
    eq(nameOn(2026, 9, 21), '敬老の日');
  });

  test('スポーツの日(10月第2月曜、2000年以降 / 2020年に体育の日から改称)', function () {
    // 2026年10月は 10/1(木)始まり → 第2月曜は 10/12
    eq(nameOn(2026, 10, 12), 'スポーツの日');
    eq(nameOn(2019, 10, 14), '体育の日', '2020年より前は旧名称');
  });

  // -------------------------------------------------------- 春分・秋分

  test('春分の日・秋分の日(既知の実際の日付と一致する)', function () {
    // 国立天文台の暦要項などで確認できる実際の日付
    eq(nameOn(2024, 3, 20), '春分の日');
    eq(nameOn(2025, 3, 20), '春分の日');
    eq(nameOn(2026, 3, 20), '春分の日');
    eq(nameOn(2024, 9, 22), '秋分の日');
    eq(nameOn(2025, 9, 23), '秋分の日');
    eq(nameOn(2026, 9, 23), '秋分の日');
  });

  // -------------------------------------------------------- 振替休日

  test('振替休日: 祝日が日曜なら翌月曜が休日になる', function () {
    // 2026年11月3日(文化の日)は火曜なので発生しない年の対照として、
    // 実際に日曜と重なる既知の例: 2024年8月11日(山の日)は日曜 → 8/12(月)が振替休日
    var aug11 = d(2024, 8, 11);
    eq(aug11.getDay(), 0, 'テストの前提: 2024/8/11は日曜のはず');
    eq(nameOn(2024, 8, 11), '山の日');
    eq(nameOn(2024, 8, 12), '振替休日');
  });

  test('振替休日: 連続する祝日はその先まで飛ばす', function () {
    // 2026年のゴールデンウィーク: 5/3(憲法記念日)が日曜。
    // 5/4(みどりの日)・5/5(こどもの日)も祝日で埋まっているため、
    // 振替休日は最初の空き平日である 5/6(水)まで飛ばされる。
    var may3 = d(2026, 5, 3);
    eq(may3.getDay(), 0, 'テストの前提: 2026/5/3は日曜のはず');
    eq(nameOn(2026, 5, 3), '憲法記念日');
    eq(nameOn(2026, 5, 4), 'みどりの日');
    eq(nameOn(2026, 5, 5), 'こどもの日');
    eq(nameOn(2026, 5, 6), '振替休日', '5/4・5/5が埋まっているので5/6まで飛ばされるはず');
  });

  // -------------------------------------------------------- 国民の休日

  test('国民の休日: 敬老の日と秋分の日が中1日空くと、その日が休日になる', function () {
    // 2026年: 敬老の日 9/21(月)、秋分の日 9/23(水) → 間の 9/22(火)が国民の休日
    eq(nameOn(2026, 9, 21), '敬老の日');
    eq(nameOn(2026, 9, 22), '国民の休日');
    eq(nameOn(2026, 9, 23), '秋分の日');
  });

  // ------------------------------------------------------ 例外年

  test('2019年(改元)は天皇誕生日が無い', function () {
    eq(nameOn(2019, 2, 23), null, '2020年から始まるのでまだ祝日ではない');
    eq(nameOn(2018, 12, 23), '天皇誕生日', '2018年までは12/23');
    eq(nameOn(2019, 12, 23), null, '2019年は12/23も祝日ではない');
  });

  test('2020・2021年は東京オリンピック特例で海の日・山の日・スポーツの日が移動する', function () {
    eq(nameOn(2020, 7, 23), '海の日');
    eq(nameOn(2020, 7, 24), 'スポーツの日');
    eq(nameOn(2020, 8, 10), '山の日');
    eq(nameOn(2020, 7, 20), null, '通常の第3月曜は祝日でない');

    eq(nameOn(2021, 7, 22), '海の日');
    eq(nameOn(2021, 7, 23), 'スポーツの日');
    eq(nameOn(2021, 8, 8), '山の日');
  });

  // ------------------------------------------------------------ 年境界

  test('年境界をまたいでも前後の年の祝日が引ける', function () {
    ok(H.isNationalHoliday(d(2026, 1, 1)) !== null);
    ok(H.isNationalHoliday(d(2025, 12, 31)) === null);
  });

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

  WT.holidayTests = { run: run, cases: cases };
})((globalThis.WT = globalThis.WT || {}));
