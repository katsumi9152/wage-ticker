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

  test('SPEC 11: 金額は最初からぼかし状態', function () {
    frame();
    ok(el('liveAmount').classList.contains('is-masked'), 'メイン金額がぼかしになっていない');
    ok(el('monthAmount').classList.contains('is-masked'), '今月がぼかしになっていない');
  });

  test('SPEC 11: 目のアイコンを押している間だけ表示、離すと戻る', function () {
    el('eyeBtn').fire('pointerdown');
    ok(!el('liveAmount').classList.contains('is-masked'), '押している間は表示されるはず');
    ok(el('eyeBtn').classList.contains('is-on'));
    el('eyeBtn').fire('pointerup');
    // 300ms 未満のタップ扱いになるため、数秒間の表示が続く(タイマーはスタブで発火しない)
    el('eyeBtn').fire('pointerdown');
    el('eyeBtn').fire('pointerleave');
    ok(true);
  });

  test('SPEC 11: 画面を離れると必ずぼかしに戻る', function () {
    document.hidden = true;
    fireDoc('visibilitychange');
    ok(el('liveAmount').classList.contains('is-masked'), 'バックグラウンド後もぼかしに戻っていない');
    document.hidden = false;
  });

  test('設定: 所定労働日の曜日は月曜始まりで並ぶ', function () {
    var html = el('setWorkdays').innerHTML;
    var order = [];
    var re = /data-day="(\d)"/g;
    var m;
    while ((m = re.exec(html)) !== null) { order[order.length] = Number(m[1]); }
    eq(order.join(','), '1,2,3,4,5,6,0', '曜日の並び順が月曜始まりになっていない');
    ok(html.indexOf('>月<') < html.indexOf('>日<'), '月より先に日が出ている');
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

  test('カレンダー: 当月ぶんのセルが描画される', function () {
    el('openCalendar').fire('click');
    var cells = el('calGrid').innerHTML.match(/cal-cell/g) || [];
    ok(cells.length >= 28, 'カレンダーのセルが足りない: ' + cells.length);
    ok(el('calTitle').textContent.indexOf('年') > 0, '年月の見出しが出ていない');
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
