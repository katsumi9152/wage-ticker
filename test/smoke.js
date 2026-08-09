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

  test('テーマ: 既定は端末の設定に追従し、ボタンで切り替わる', function () {
    var root = document.documentElement;
    eq(root.getAttribute('data-theme'), null, '既定で色を固定してはいけない');
    el('themeToggle').fire('click');
    eq(root.getAttribute('data-theme'), 'dark', '1回目でダークになる');
    el('themeToggle').fire('click');
    eq(root.getAttribute('data-theme'), 'light', '2回目でライトに戻る');
    eq(localStorage.getItem('wageTheme'), 'light', '選んだテーマが保存される');
  });

  test('時計ゲージ: 文字盤・予定・休憩・針が描かれる', function () {
    frame();
    eq((el('clockTicks').innerHTML.match(/<line/g) || []).length, 24, '24時間ぶんの目盛りが無い');
    ok(el('clockPlanned').getAttribute('d').indexOf('M') === 0, '予定の勤務帯が描かれていない');
    ok(el('clockBreak').getAttribute('d').indexOf('M') === 0, '休憩帯が描かれていない');
    ok(el('clockHand').getAttribute('x2') !== null, '現在時刻の針が無い');
    ok(el('clockValue').textContent.indexOf(':') > 0, '中央に実働時間が出ていない');
    ok(el('clockCap').textContent.indexOf('予定') === 0, '予定の時刻が添えられていない');
    ok(el('clockCap').textContent.indexOf('休憩') > 0);
  });

  test('今月バー: 青が基本給ライン、赤が先月の合計', function () {
    frame();
    ok(String(el('monthBarFill').style.height).indexOf('%') > 0, '今月バーが伸びていない');
    ok(el('monthBarMarks').innerHTML.indexOf('is-base') >= 0, '基本給ラインが無い');
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

  test('手動: 出勤を押すと勤務中になる', function () {
    S.settings.monthlyBaseSalary = 300000;
    S.state.configured = true;
    refresh();
    el('clockInBtn').fire('click');
    frame();
    eq(S.state.status, 'working');
    eq(el('statusText').textContent, '勤務中');
    ok(el('clockInBtn').disabled === true, '出勤ボタンは押せない状態になる');
    ok(el('clockOutBtn').disabled === false, '退勤ボタンが押せる状態になる');
  });

  test('手動: メイン数値・今日・今月が描画される', function () {
    frame();
    ok(/^[0-9,]+$/.test(el('liveInt').textContent), 'メイン金額が数字になっていない: ' + el('liveInt').textContent);
    ok(/^\.\d\d$/.test(el('liveDec').textContent), '小数部が描画されていない: ' + el('liveDec').textContent);
    ok(el('todayAmount').textContent.indexOf('¥') === 0, '今日の金額が円表示になっていない');
    ok(el('monthAmount').textContent.indexOf('¥') === 0, '今月の金額が円表示になっていない');
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
      '未入力', '基礎時給単価', '36協定', '清算期間'];
    for (var i = 0; i < needed.length; i++) {
      ok(html.indexOf(needed[i]) >= 0, '内訳に「' + needed[i] + '」が出ていない');
    }
  });

  test('手動: 退勤するとカレンダーに打刻が保存される', function () {
    el('clockOutBtn').fire('click');
    frame();
    eq(S.state.status, 'off');
    eq(punchCount(), 1, '打刻が保存されていない');
    ok(S.state.lastClockOutAt > 0, '前回退勤時刻が記録されていない');
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

  test('カレンダー: 当月ぶんのセルが描画される', function () {
    el('openCalendar').fire('click');
    var cells = el('calGrid').innerHTML.match(/cal-cell/g) || [];
    ok(cells.length >= 28, 'カレンダーのセルが足りない: ' + cells.length);
    ok(el('calTitle').textContent.indexOf('年') > 0, '年月の見出しが出ていない');
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
    ok(el('clockInBtn').hidden === true, '自動モードでは出勤ボタンを消す');
    ok(el('clockOutBtn').hidden === true, '自動モードでは退勤ボタンを消す');
    ok(el('overtimeBtn').hidden === false, '残業ボタンが出ていない');
    eq(el('overtimeBtn').textContent, '残業開始');
  });

  test('SPEC 5.3: 残業開始 → 残業終了で確定する', function () {
    el('overtimeBtn').fire('click');
    frame();
    eq(S.state.overtimeFlag, true, '残業フラグが立っていない');
    eq(el('overtimeBtn').textContent, '残業終了');
    el('overtimeBtn').fire('click');
    frame();
    eq(S.state.overtimeFlag, false);
    eq(punchCount(), 1, '残業終了で打刻が確定していない');
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
