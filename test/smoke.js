/**
 * smoke.js — 画面まわり(src/app.js)の通し確認。
 *
 * test/dom-stub.js の DOM 代役の上で、実際のアプリを起動したまま
 * 「出勤 → 描画 → 内訳 → 退勤」「自動モードの4分岐」「覗き見防止」を順に触っていく。
 * 1つのアプリ状態を共有して順番に進めるシナリオ形式なので、上から順に実行される。
 *
 * 実行は test/run.ps1 から(ブラウザでは読み込まない)。
 */
(function (WT) {
  'use strict';

  var cases = [];
  function test(name, fn) { cases.push({ name: name, fn: fn }); }
  function fail(msg) { throw new Error(msg); }
  function ok(cond, msg) { if (!cond) { fail(msg || '条件を満たしていません'); } }
  function eq(a, b, msg) { if (a !== b) { fail((msg || '') + ' — 期待値 ' + b + ' / 実際 ' + a); } }
  function near(a, b, tol, msg) {
    if (isNaN(a) || Math.abs(a - b) > tol) { fail((msg || '') + ' — 期待値 ' + b + ' ± ' + tol + ' / 実際 ' + a); }
  }

  var S = WT.storage.Store;

  function punchCount() {
    var n = 0;
    for (var k in S.calendar) {
      if (Object.prototype.hasOwnProperty.call(S.calendar, k) && S.calendar[k].clockOut) { n++; }
    }
    return n;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 設定を書き換えたあと、アプリに再計算させる(通常は1秒ごとに走る処理) */
  function refresh() {
    S.saveSettings();
    S.saveState();
    fireDoc('visibilitychange');
    frame();
  }

  // ------------------------------------------------- 起動と覗き見防止

  test('起動: 未設定なら設定画面が開く', function () {
    ok(MODALS.length > 0, '設定画面が開かれていない');
    eq(MODALS[0], 'settingsDialog');
  });

  test('テーマ: 選ぶまでは常にライトで始まり、ボタンで切り替わる', function () {
    var root = document.documentElement;
    eq(root.getAttribute('data-theme'), 'light', '選ぶまでは端末の設定に関わらずライトのはず');
    el('themeToggle').fire('click');
    eq(root.getAttribute('data-theme'), 'dark', '1回目でダークになる');
    eq(localStorage.getItem('wageTheme'), 'dark', '選んだテーマが保存される');
    el('themeToggle').fire('click');
    eq(root.getAttribute('data-theme'), 'light', '2回目でライトに戻る');
    eq(localStorage.getItem('wageTheme'), 'light');
  });

  test('先月との比較は、通常と残業を色分けした横棒で出す', function () {
    frame();
    ok(String(el('cmpNowNormal').style.width).indexOf('%') > 0, '今月の通常時間の棒が無い');
    ok(String(el('cmpNowOt').style.width).indexOf('%') > 0, '今月の残業時間の棒が無い');
    ok(String(el('cmpPrevNormal').style.width).indexOf('%') > 0, '先月の棒が無い');
    ok(el('cmpNowTotal').textContent.indexOf(':') > 0, '今月の合計時間が出ていない');
    ok(el('cmpNowTotal').textContent.indexOf('¥') < 0, 'このグラフに金額は出さない');
  });

  test('設定: 今週 / 今月はそれぞれ隠せる', function () {
    S.settings.showWeek = false;
    refresh();
    ok(el('weekCard').hidden === true, '今週を隠せていない');
    ok(el('monthCard').hidden === false, '今月まで消えている');
    ok(el('statsSection').classList.contains('is-single'), '片方だけのときは横幅いっぱいにする');

    S.settings.showMonth = false;
    refresh();
    ok(el('statsSection').hidden === true, '両方オフなら枠ごと隠す');

    S.settings.showWeek = true;
    S.settings.showMonth = true;
    refresh();
    ok(el('weekCard').hidden === false);
    ok(el('monthCard').hidden === false);
    ok(el('statsSection').hidden === false);
  });

  test('残業メーター: 45時間・60時間の目印つきで出る', function () {
    S.settings.monthlyBaseSalary = 300000;
    S.settings.fixedOvertimeHours = 0;
    refresh();
    eq(el('otNow').textContent, '0:00', '今月の残業時間が出ていない');
    ok(String(el('otFill').style.width).indexOf('%') > 0, 'メーターが描かれていない');
    eq(el('otMark45').style.left, '75.0%', '45時間の目印は60時間目盛りの75%の位置');
    eq(el('otMark60').style.left, '100.0%');
    ok(el('otMarkLabels').innerHTML.indexOf('45h') >= 0, '目盛りのラベルが無い');
    ok(el('otMarkFixed').hidden === true, '固定残業なしなら目印を出さない');
  });

  test('残業メーター: 固定残業を設定すると目印が増える', function () {
    S.settings.fixedOvertimeHours = 30;
    S.settings.fixedOvertimeAllowance = 60000;
    refresh();
    ok(el('otMarkFixed').hidden === false, '固定残業の目印が出ていない');
    eq(el('otMarkFixed').style.left, '50.0%', '30時間は60時間目盛りの半分');
    ok(el('otMarkLabels').innerHTML.indexOf('固定30h') >= 0);
    S.settings.fixedOvertimeHours = 0;
    S.settings.fixedOvertimeAllowance = 0;
    refresh();
  });

  test('金額はぼかさずそのまま表示される', function () {
    frame();
    ok(!el('liveAmount').classList.contains('is-masked'), 'メイン金額がぼけている');
    ok(!el('monthAmount').classList.contains('is-masked'), '今月がぼけている');
    document.hidden = true;
    fireDoc('visibilitychange');
    document.hidden = false;
    fireDoc('visibilitychange');
    ok(!el('liveAmount').classList.contains('is-masked'), '画面を戻したらぼけた');
  });

  test('設定: 所定労働日の曜日は日曜始まりで並ぶ', function () {
    var html = el('setWorkdays').innerHTML;
    var order = [];
    var re = /data-day="(\d)"/g;
    var m;
    while ((m = re.exec(html)) !== null) { order[order.length] = Number(m[1]); }
    eq(order.join(','), '0,1,2,3,4,5,6', '曜日の並び順が日曜始まりになっていない');
    ok(html.indexOf('>日<') < html.indexOf('>月<'), '日より先に月が出ている');
  });

  // ------------------------------------------------------ 手動モード

  /** 確認ダイアログの「はい」を押す */
  function confirmYes() { el('confirmYes').fire('click'); }

  test('打刻: 出勤は確認してから記録される', function () {
    S.settings.monthlyBaseSalary = 300000;
    S.state.configured = true;
    refresh();

    el('clockInBtn').fire('click');
    eq(S.state.status, 'off', '確認する前に打刻してはいけない');
    eq(el('confirmText').textContent, '出勤しますか?');

    confirmYes();
    frame();
    eq(S.state.status, 'working');
    eq(el('statusText').textContent, '勤務中');
    ok(el('clockInBtn').disabled === true, '出勤したら出勤ボタンは押せない');
    ok(el('clockOutBtn').disabled === false, '退勤ボタンが押せる状態になる');
  });

  test('打刻: 確認をキャンセルすると何も起きない', function () {
    el('breakBtn').fire('click');
    eq(el('confirmText').textContent, '休憩を開始しますか?');
    el('confirmNo').fire('click');
    ok(!S.isOnManualBreak(), 'キャンセルしたのに休憩が始まっている');
  });

  test('打刻: 休憩は何度でも記録でき、そのあいだカウンターが止まる', function () {
    el('breakBtn').fire('click');
    confirmYes();
    frame();
    ok(S.isOnManualBreak(), '休憩が始まっていない');
    eq(el('statusText').textContent, '休憩中');
    ok(el('statusBadge').classList.contains('is-break'), '休憩中の色になっていない');
    ok(!el('statusBadge').classList.contains('is-working'), '勤務中の色が残っている');
    eq(el('breakBtn').textContent, '休憩終了');

    var stopped = el('liveInt').textContent;
    frame();
    eq(el('liveInt').textContent, stopped, '休憩中なのに金額が増えている');

    el('breakBtn').fire('click');
    confirmYes();
    frame();
    ok(!S.isOnManualBreak(), '休憩が終わっていない');
    eq(el('breakBtn').textContent, '休憩開始');

    // 2回目の休憩も記録できる
    el('breakBtn').fire('click');
    confirmYes();
    el('breakBtn').fire('click');
    confirmYes();
    eq(S.state.breaks.length, 2, '休憩は何度でも記録できる');
  });

  test('休憩: 昼休憩の時間帯に入ると「昼休憩中」の表示になる', function () {
    var now = Date.now();
    var hh = pad2(new Date(now).getHours());
    S.settings.breakWindow = { start: hh + ':00', end: hh + ':59' }; // 今の時刻を含む1時間
    refresh();
    ok(!S.isOnManualBreak(), '前提が崩れている(手動休憩が続いたまま)');
    eq(el('statusText').textContent, '昼休憩中', '昼休憩中の表示になっていない');
    ok(el('breakBtn').disabled === true, '昼休憩の最中は手動の休憩ボタンを押せないはず');

    // 手動休憩ともたまたま重なっていれば、押した操作(手動休憩)を優先する
    S.startBreak(now);
    refresh();
    eq(el('statusText').textContent, '休憩中', '昼休憩と重なると手動休憩の表示が消える');
    S.endBreak(now);
    S.state.breaks.pop(); // このテスト用に足した休憩は記録に残さない
    S.saveState();

    S.settings.breakWindow = { start: '12:00', end: '13:00' };
    refresh();
  });

  test('手動: メイン数値・今週・今月が描画される', function () {
    frame();
    ok(/^[0-9,]+$/.test(el('liveInt').textContent), 'メイン金額が数字になっていない: ' + el('liveInt').textContent);
    ok(/^\.\d\d$/.test(el('liveDec').textContent), '小数部が描画されていない: ' + el('liveDec').textContent);
    ok(el('weekAmount').textContent.indexOf('¥') === 0, '今週の金額が円表示になっていない');
    ok(el('monthAmount').textContent.indexOf('¥') === 0, '今月の金額が円表示になっていない');
    // 実働は「労働時間 / 所定労働時間」で出す
    ok(/^\d+:\d\d \/ \d+:\d\d$/.test(el('monthSub').textContent),
      '今月が 労働時間 / 所定労働時間 になっていない: ' + el('monthSub').textContent);
    ok(/^\d+:\d\d \/ \d+:\d\d$/.test(el('weekSub').textContent),
      '今週が 労働時間 / 所定労働時間 になっていない: ' + el('weekSub').textContent);
    ok(el('liveMeta').textContent.indexOf('出勤') >= 0, '出勤時刻が表示されていない');
  });

  test('SPEC 6.2: 未入力日が今月の集計に自動加算されている', function () {
    var yen = Number(el('monthAmount').textContent.replace(/[^\d]/g, ''));
    ok(yen > 0, '今月の金額が 0 のまま(未入力日の自動加算が効いていない)');
    ok(el('monthSub').textContent.indexOf(':') > 0, '今月の実働時間が表示されていない');
  });

  test('補助情報: 内訳を開くと各区分が並ぶ', function () {
    el('detailsPanel').open = true;
    el('detailsPanel').fire('toggle');
    var html = el('detailsBody').innerHTML;
    var needed = ['所定内', '法定内残業', '法定時間外', '深夜割増', '法定休日',
      '未入力', '基礎時給単価', '残業時間の目安', '清算期間'];
    ok(html.indexOf('回') < 0 || html.indexOf('月45時間超の回数') < 0, '年間の回数は出さない');
    for (var i = 0; i < needed.length; i++) {
      ok(html.indexOf(needed[i]) >= 0, '内訳に「' + needed[i] + '」が出ていない');
    }
  });

  test('打刻: 退勤するとカレンダーに休憩ごと保存される', function () {
    el('clockOutBtn').fire('click');
    eq(S.state.status, 'working', '確認する前に退勤してはいけない');
    confirmYes();
    frame();
    eq(S.state.status, 'off');
    eq(punchCount(), 1, '打刻が保存されていない');
    ok(S.state.lastClockOutAt > 0, '前回退勤時刻が記録されていない');
    var todayKey = WT.time.dateKey(new Date());
    ok((S.calendar[todayKey].breaks || []).length === 2, '休憩が記録に残っていない');
    ok(el('clockInBtn').disabled === false, '退勤したら出勤できる');
    ok(el('breakBtn').disabled === true, '出勤していないときは休憩を押せない');
  });

  test('設定: 基本給以外はプルダウンから選ぶ', function () {
    function optionCount(id) { return (el(id).innerHTML.match(/<option/g) || []).length; }
    ok(optionCount('setAnnualHolidays') > 10, '年間休日数の選択肢が無い');
    ok(optionCount('setBreakStart') === 96, '休憩開始が15分刻みで並んでいない');
    ok(optionCount('setBreakEnd') === 96, '休憩終了が15分刻みで並んでいない');
    ok(optionCount('setScheduleStart') === 96, '出勤時間が15分刻みで並んでいない');
    ok(optionCount('setScheduleEnd') === 96, '退勤時間が15分刻みで並んでいない');
    ok(el('setSalary').type === 'password', '基本給は入力欄のまま(マスク付き)であるべき');
  });

  test('設定: 休憩の開始を選ぶと終了は1時間後が入る', function () {
    el('openSettings').fire('click');
    el('setBreakStart').value = '11:00';
    el('setBreakStart').fire('change');
    eq(el('setBreakEnd').value, '12:00', '1時間後になっていない');
    el('setBreakStart').value = '12:30';
    el('setBreakStart').fire('change');
    eq(el('setBreakEnd').value, '13:30');
    // 日付をまたぐ場合も一周する
    el('setBreakStart').value = '23:30';
    el('setBreakStart').fire('change');
    eq(el('setBreakEnd').value, '00:30');
  });

  test('設定: 所定労働時間は勤務時間と休憩から自動計算される', function () {
    el('openSettings').fire('click');
    el('setScheduleStart').value = '09:00';
    el('setScheduleEnd').value = '17:30';
    el('setBreakStart').value = '12:00';
    el('setBreakStart').fire('change'); // 終了は13:00 に、表示も更新される
    eq(el('setDailyHours').textContent, '7時間30分', '自動計算の表示が合っていない');

    el('setScheduleEnd').value = '18:00';
    el('setScheduleEnd').fire('change');
    eq(el('setDailyHours').textContent, '8時間');

    el('setBreakStart').value = '12:00';
    el('setBreakEnd').value = '12:45';
    el('setBreakEnd').fire('change');
    eq(el('setDailyHours').textContent, '8時間15分', '45分休憩が反映されない');
  });

  test('設定: 休憩時間帯は必ず登録される(古い「登録しない」設定も既定に寄せる)', function () {
    var merged = WT.storage.mergeSettings({ breakWindow: null });
    ok(!!merged.breakWindow, '休憩時間帯が空のまま');
    eq(merged.breakWindow.start, '12:00');
    eq(merged.breakWindow.end, '13:00');
  });

  test('設定: 保存すると所定労働時間が計算に反映される', function () {
    // 曜日ボタンは innerHTML 文字列なので、保存経路を通すために最小限の代役を置く
    el('setWorkdays').querySelectorAll = function () {
      return [1, 2, 3, 4, 5].map(function (d) {
        return {
          getAttribute: function () { return String(d); },
          classList: { toggle: function () {}, contains: function () { return true; } }
        };
      });
    };
    el('openSettings').fire('click');
    el('setSalary').value = '300000';
    el('setScheduleStart').value = '09:00';
    el('setScheduleEnd').value = '18:00';
    el('setBreakStart').value = '12:00';
    el('setBreakEnd').value = '13:00';
    el('saveSettingsBtn').fire('click');
    eq(S.settings.dailyScheduledHours, 8, '保存された所定労働時間が違う');
    eq(S.settings.schedule.start, '09:00');
    eq(S.settings.schedule.end, '18:00');

    // 既定に戻す
    S.settings.schedule = { start: '09:00', end: '17:30' };
    S.settings.dailyScheduledHours = 7.5;
    refresh();
  });

  test('設定: 法定休日の曜日も日曜始まりで並ぶ', function () {
    var html = el('setLegalWeekday').innerHTML;
    var order = [];
    var re = /value="(\d)"/g;
    var m;
    while ((m = re.exec(html)) !== null) { order[order.length] = Number(m[1]); }
    eq(order.join(','), '0,1,2,3,4,5,6', '選択肢の並びが日曜始まりになっていない');
  });

  test('打刻: 同じ日に2回目の出勤は「再開」になり、記録は1日1組のまま', function () {
    var todayKey = WT.time.dateKey(new Date());
    var firstIn = S.calendar[todayKey].clockIn;
    var firstOut = S.calendar[todayKey].clockOut;
    var breaksBefore = (S.calendar[todayKey].breaks || []).length;

    el('clockInBtn').fire('click');
    eq(el('confirmText').textContent, '勤務を再開しますか?(退勤からいままでは休憩になります)');
    confirmYes();
    frame();

    eq(S.state.status, 'working');
    eq(S.state.clockInAt, firstIn, '出勤時刻は最初のままであるべき');
    eq(S.state.breaks.length, breaksBefore + 1, '退勤〜再開が休憩になっていない');
    eq(S.state.breaks[breaksBefore].start, firstOut, '休憩の開始が前回の退勤時刻になっていない');

    el('clockOutBtn').fire('click');
    confirmYes();
    frame();
    eq(punchCount(), 1, '1日に複数の記録を作ってはいけない');
    eq(S.calendar[todayKey].clockIn, firstIn, '出勤時刻が書き換わっている');
  });

  test('カレンダー: 当月ぶんのセルが描画される', function () {
    el('openCalendar').fire('click');
    var cells = el('calGrid').innerHTML.match(/cal-cell/g) || [];
    ok(cells.length >= 28, 'カレンダーのセルが足りない: ' + cells.length);
    ok(el('calTitle').textContent.indexOf('年') > 0, '年月の見出しが出ていない');
  });

  test('カレンダー: 半休の日は専用の印になり、今月の集計にも反映される', function () {
    S.calendar = {};
    var now = new Date();
    var key = WT.time.dateKey(new Date(now.getFullYear(), now.getMonth(), 1));
    S.setDay(key, { type: 'half_day', halfKind: 'pm' });
    refresh();

    el('openCalendar').fire('click'); // 毎回「今月」に戻るので、月初(1日)は必ず表示範囲内
    var cellHtml = el('calGrid').innerHTML;
    var start = cellHtml.indexOf('data-date="' + key + '"');
    ok(start >= 0, '対象の日のセルが描画されていない');
    var end = cellHtml.indexOf('</button>', start);
    var thisCell = cellHtml.slice(start, end >= 0 ? end : undefined);
    ok(thisCell.indexOf('mk half') >= 0, '半休の印(half)が付いていない: ' + thisCell);

    var yen = Number(el('monthAmount').textContent.replace(/[^\d]/g, ''));
    ok(yen > 0, '半休の日が今月の金額に反映されていない');
    S.calendar = {};
  });

  test('カレンダー: 祝日は専用の印になり、タップすると名前が出る', function () {
    S.calendar = {};
    S.settings.observeNationalHolidays = true;
    refresh();

    // 表示できる5ヶ月(先月〜+3ヶ月)の範囲から、法定休日の曜日と重ならない
    // 祝日を1つ探す(法定休日の曜日と重なると印が「法定休日」優先になるため)
    var now = new Date();
    var found = null;
    for (var offset = -1; offset <= 3 && !found; offset++) {
      var probe = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      var h = WT.holidays.nationalHolidaysOfYear(probe.getFullYear());
      for (var i = 0; i < h.list.length; i++) {
        var d = h.list[i].date;
        if (d.getFullYear() === probe.getFullYear() && d.getMonth() === probe.getMonth() &&
            d.getDay() !== Number(S.settings.legalHolidayWeekday)) {
          found = { date: d, monthOffset: offset, name: h.list[i].name };
          break;
        }
      }
    }
    ok(!!found, 'テスト対象の祝日が表示範囲内に見つからない(通常は起こらないはず)');

    // openCalendar は毎回「今月」に戻るので、そこから必要な回数だけ月を送る
    el('openCalendar').fire('click');
    var steps = found.monthOffset;
    while (steps > 0) { el('calNext').fire('click'); steps--; }
    while (steps < 0) { el('calPrev').fire('click'); steps++; }

    var key = WT.time.dateKey(found.date);
    var cellHtml = el('calGrid').innerHTML;
    var start = cellHtml.indexOf('data-date="' + key + '"');
    ok(start >= 0, '対象の日のセルが描画されていない');
    var end = cellHtml.indexOf('</button>', start);
    var thisCell = cellHtml.slice(start, end >= 0 ? end : undefined);
    ok(thisCell.indexOf('mk holiday') >= 0, '祝日の印(holiday)が付いていない: ' + thisCell);

    // 実際にそのセルをタップした体で、日編集ダイアログを開く
    el('calGrid').fire('click', {
      target: {
        closest: function (sel) {
          if (sel !== 'button[data-date]') return null;
          return { getAttribute: function (attr) { return attr === 'data-date' ? key : null; } };
        },
      },
    });
    ok(el('dayNote').textContent.indexOf(found.name) >= 0,
      '日編集ダイアログに祝日名が出ていない: ' + el('dayNote').textContent);

    S.settings.observeNationalHolidays = false;
    refresh();
  });

  test('設定: 祝日の除外をオフにすると、その日を通常の平日として扱う', function () {
    S.calendar = {};
    S.settings.observeNationalHolidays = false;
    refresh();
    // 元日(1月1日、翌年)。既定の所定労働日(月〜金)なら、祝日でも出勤日のはず
    var jan1 = new Date(new Date().getFullYear() + 1, 0, 1);
    var isWeekday = jan1.getDay() !== 0 && jan1.getDay() !== 6;
    eq(WT.aggregate.isScheduledWorkDay(jan1, S.settings, S.calendar), isWeekday,
      'オフのときは祝日を無視して曜日だけで判定されるはず');
    S.settings.observeNationalHolidays = true;
    refresh();
  });

  test('カレンダー: 先月から3ヶ月先までしか動かせない', function () {
    var now = new Date();
    function label(offset) {
      var d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
    }

    el('openCalendar').fire('click');
    eq(el('calTitle').textContent, label(0), '開いたら今月から始まる');

    // 過去は1ヶ月まで
    el('calPrev').fire('click');
    eq(el('calTitle').textContent, label(-1));
    ok(el('calPrev').disabled === true, '先月より前へは進めないようにする');
    el('calPrev').fire('click');
    eq(el('calTitle').textContent, label(-1), '先月より前に行けてしまっている');

    // 未来は3ヶ月まで
    for (var i = 0; i < 6; i++) el('calNext').fire('click');
    eq(el('calTitle').textContent, label(3), '3ヶ月先で止まっていない');
    ok(el('calNext').disabled === true, '3ヶ月先より後へは進めないようにする');

    el('openCalendar').fire('click');
    eq(el('calTitle').textContent, label(0), '開き直したら今月に戻る');
  });

  test('カレンダー: 見出しと空きマスが日曜始まりで揃う', function () {
    var head = el('calHead').innerHTML;
    var labels = head.match(/>(.)</g) || [];
    var joined = [];
    for (var i = 0; i < labels.length; i++) { joined[joined.length] = labels[i].charAt(1); }
    eq(joined.join(''), '日月火水木金土', '見出しの曜日が日曜始まりでない');

    el('openCalendar').fire('click');
    var now = new Date();
    var first = new Date(now.getFullYear(), now.getMonth(), 1);
    var expectedLeading = first.getDay(); // 日曜始まりの空きマス数
    var grid = el('calGrid').innerHTML;
    var empties = (grid.match(/is-empty/g) || []).length;
    var cells = (grid.match(/cal-cell/g) || []).length;
    eq(empties, expectedLeading, '月初の空きマス数が月曜始まりと合っていない');
    eq(cells - empties, WT.time.daysInMonth(now.getFullYear(), now.getMonth()), '日数ぶんのマスが無い');
  });

  // ------------------------------------------------------ 自動モード

  test('SPEC 5.3: 勤務時間内はボタンなしでカウンターが動く', function () {
    S.calendar = {};
    S.settings.autoMode = true;
    S.settings.schedule = { start: '00:00', end: '23:59' };
    S.state.overtimeFlag = false;
    S.state.autoDayKey = null;
    refresh();
    eq(el('statusText').textContent, '自動計測中');
    ok(el('clockInBtn').hidden === false, '自動モードでも手動の打刻は使えるようにする');
    ok(el('clockOutBtn').hidden === false);
    ok(el('overtimeBtn').hidden === false, '残業ボタンが出ていない');
    eq(el('overtimeBtn').textContent, '残業開始');
  });

  test('SPEC 5.3: 残業開始 → 残業終了で確定する', function () {
    el('overtimeBtn').fire('click');
    confirmYes();
    frame();
    eq(S.state.overtimeFlag, true, '残業フラグが立っていない');
    eq(el('overtimeBtn').textContent, '残業終了');
    eq(el('statusText').textContent, '残業中', '残業中の表示に変わっていない');
    el('overtimeBtn').fire('click');
    confirmYes();
    frame();
    eq(S.state.overtimeFlag, false);
    eq(punchCount(), 1, '残業終了で打刻が確定していない');
  });

  test('手動の打刻は自動モードより優先される', function () {
    S.calendar = {};
    S.state.autoDayKey = null;
    S.state.overtimeFlag = false;
    refresh();

    // 昼休憩の時間帯の途中に押した場合の注意書きだけを先に確認し、他のアサーションに
    // 影響しないよう、確認後すぐに既定の時間帯へ戻す。
    var hh = pad2(new Date().getHours());
    S.settings.breakWindow = { start: hh + ':00', end: hh + ':59' }; // 今の時刻を含む1時間
    el('clockInBtn').fire('click');
    ok(el('confirmText').textContent.indexOf('半休登録') >= 0,
      '昼休憩の時間帯中の出勤で、半休登録を促す注意書きが出ていない');
    S.settings.breakWindow = { start: '12:00', end: '13:00' };
    confirmYes();
    frame();
    eq(S.state.status, 'working', '自動モードでも出勤できる');
    eq(el('statusText').textContent, '勤務中', '自動計測ではなく手動の勤務として扱う');
    ok(el('overtimeBtn').hidden === true, '手動で出勤したら残業ボタンは出さない');

    S.settings.breakWindow = { start: hh + ':00', end: hh + ':59' };
    el('clockOutBtn').fire('click');
    ok(el('confirmText').textContent.indexOf('半休登録') >= 0,
      '昼休憩の時間帯中の退勤で、半休登録を促す注意書きが出ていない');
    S.settings.breakWindow = { start: '12:00', end: '13:00' };
    confirmYes();
    frame();
    eq(S.state.status, 'off');
    S.calendar = {};
    S.state.autoDayKey = null;
    refresh();
  });

  test('SPEC 5.3: 残業開始を押さないまま退勤予定時刻を過ぎたら自動確定', function () {
    var now = new Date();
    S.calendar = {};
    S.state.overtimeFlag = false;
    S.state.autoDayKey = null;
    S.settings.schedule = { start: '00:00', end: pad2(now.getHours()) + ':' + pad2(now.getMinutes()) };
    refresh();
    eq(punchCount(), 1, '退勤予定時刻を過ぎても自動確定されていない');
    eq(el('statusText').textContent, '待機中');
  });

  test('自動モード: 自分で出勤を押せば、その時刻が出勤時刻になる', function () {
    S.calendar = {};
    S.state.autoDayKey = null;
    S.state.overtimeFlag = false;
    S.settings.autoMode = true;
    S.settings.schedule = { start: '00:00', end: '23:59' };
    refresh();

    var before = Date.now();
    el('clockInBtn').fire('click');
    ok(el('confirmText').textContent.indexOf('自動的には終わりません') >= 0,
      '自動モード中の手動出勤で、自動確定が外れる注意書きが出ていない');
    confirmYes();
    frame();
    ok(S.state.clockInAt >= before, '押した時刻ではなく予定時刻が使われている');
    eq(el('statusText').textContent, '勤務中');

    el('clockOutBtn').fire('click');
    confirmYes();
    frame();
  });

  test('自動モード: 自動退勤したあとに退勤を押すと、その時刻に更新される', function () {
    var now = new Date();
    S.calendar = {};
    S.state.overtimeFlag = false;
    S.state.autoDayKey = null;
    // 退勤予定時刻を過ぎた状態にして、自動確定させる
    S.settings.schedule = { start: '00:00', end: pad2(now.getHours()) + ':' + pad2(now.getMinutes()) };
    refresh();
    eq(punchCount(), 1, '自動確定されていない');

    var todayKey = WT.time.dateKey(now);
    var autoOut = S.calendar[todayKey].clockOut;
    var autoIn = S.calendar[todayKey].clockIn;

    ok(el('clockOutBtn').disabled === false, '確定後も退勤を押せるようにする');
    el('clockOutBtn').fire('click');
    eq(el('confirmText').textContent, '退勤時刻を、いまの時刻に更新しますか?');
    confirmYes();
    frame();

    eq(punchCount(), 1, '記録が増えてはいけない');
    eq(S.calendar[todayKey].clockIn, autoIn, '出勤時刻は変えない');
    ok(S.calendar[todayKey].clockOut > autoOut, '退勤時刻が更新されていない');
  });

  test('SPEC 5.3: 会社休日に指定した日は自動モードでも動かない', function () {
    S.calendar = {};
    S.setDay(WT.time.dateKey(new Date()), { type: 'company_holiday', holidayKind: 'scheduled' });
    S.settings.schedule = { start: '00:00', end: '23:59' };
    S.state.autoDayKey = null;
    refresh();
    eq(el('statusText').textContent, '待機中');
    ok(el('overtimeBtn').hidden === true, '会社休日に残業ボタンが出ている');
    eq(punchCount(), 0, '会社休日に打刻が作られている');
  });

  // ------------------------------------------------------------ 保存

  test('ブラウザを閉じても、出勤時刻から再計算される', function () {
    S.calendar = {};
    S.settings.autoMode = false;

    // 3時間前に出勤し、そのうち30分は休憩していた状態を作る
    var now = Date.now();
    // 昼休憩の時間帯を「いま」から確実に離す(今の12時間後)。既定の
    // 12:00-13:00のままだと、実行時刻によっては下の3時間のセッションと
    // 重なり、手動休憩30分とは別に自動控除が追加されてテストが
    // 実行時刻次第で落ちるため。
    var awayHour = pad2((new Date(now).getHours() + 12) % 24);
    S.settings.breakWindow = { start: awayHour + ':00', end: awayHour + ':01' };
    refresh();

    S.state.status = 'working';
    S.state.clockInAt = now - 3 * 60 * 60 * 1000;
    S.state.isLegalHoliday = false;
    S.state.breaks = [{ start: now - 60 * 60 * 1000, end: now - 30 * 60 * 1000 }];
    S.saveState();

    // ブラウザを閉じて開き直した = localStorage から読み直す
    S.settings = null;
    S.state = null;
    S.load();
    eq(S.state.status, 'working', '出勤状態が復元されていない');
    eq(S.state.breaks.length, 1, '休憩の記録が復元されていない');
    // load() は保存前の breakWindow をそのまま復元するはずだが、
    // 念のためここでも退避させておく
    S.settings.breakWindow = { start: awayHour + ':00', end: awayHour + ':01' };

    refresh();
    var live = WT.aggregate.computeLive(
      WT.aggregate.aggregatePeriod({
        period: WT.period.resolvePeriod(new Date(), S.settings.closingDay),
        settings: S.settings, calendar: S.calendar,
        activeSession: { startMs: S.state.clockInAt, isLegalHoliday: false, breaks: S.state.breaks },
        now: new Date()
      }),
      { startMs: S.state.clockInAt, isLegalHoliday: false, breaks: S.state.breaks },
      S.settings, now
    );
    near(live.workedMinutes, 150, 1.5, '3時間 − 休憩30分 になっていない');

    S.state.status = 'off';
    S.state.clockInAt = null;
    S.state.breaks = [];
    S.settings.breakWindow = { start: '12:00', end: '13:00' };
    S.saveState();
    refresh();
  });

  test('SPEC 12: 設定・状態が localStorage に保存されている', function () {
    S.settings.autoMode = false;
    refresh();
    ok(localStorage.getItem('wageSettings') !== null, 'wageSettings が無い');
    ok(localStorage.getItem('wageState') !== null, 'wageState が無い');
    ok(localStorage.getItem('wageCalendar') !== null, 'wageCalendar が無い');
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

  WT.smoke = { run: run, cases: cases };
})((globalThis.WT = globalThis.WT || {}));
