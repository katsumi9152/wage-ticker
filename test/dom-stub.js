/**
 * dom-stub.js — コマンドラインで src/app.js を動かすための最小限の DOM 代役。
 *
 * ブラウザを開かずに「起動 → 出勤 → 描画 → 退勤」まで通せるようにするためのもので、
 * test/run.ps1 からのみ読み込まれる(ブラウザ版 test/index.html では使わない)。
 * 本物のレイアウトは再現しない。あくまで「処理が最後まで通るか」「表示用の文字列と
 * クラスが期待どおりか」を確かめるための土台。
 */

/* 桁区切りは環境依存なので、テストでは素の数値表現に固定する */
Number.prototype.toLocaleString = function () { return String(Math.round(Number(this))); };

/* --- DOM の代役 --------------------------------------------------------- */

var ELS = {};
var MODALS = [];

function stubClassList() {
  var set = {};
  return {
    _set: set,
    add: function (n) { set[n] = true; },
    remove: function (n) { delete set[n]; },
    contains: function (n) { return !!set[n]; },
    toggle: function (n, force) {
      var on = arguments.length > 1 ? !!force : !set[n];
      if (on) { set[n] = true; } else { delete set[n]; }
      return on;
    }
  };
}

function stubEl(id) {
  return {
    id: id, hidden: false, disabled: false, open: false, value: '', textContent: '',
    innerHTML: '', checked: false, type: 'text', placeholder: '', style: {},
    _h: {}, classList: stubClassList(),
    addEventListener: function (t, f) { if (!this._h[t]) { this._h[t] = []; } this._h[t][this._h[t].length] = f; },
    fire: function (t, ev) {
      var e = ev || {};
      if (!e.preventDefault) { e.preventDefault = function () {}; }
      if (!e.target) { e.target = this; }
      var hs = this._h[t] || [];
      for (var i = 0; i < hs.length; i++) { hs[i].call(this, e); }
    },
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; },
    showModal: function () { MODALS[MODALS.length] = this.id; },
    close: function () {},
    getAttribute: function () { return null; },
    setAttribute: function () {},
    scrollIntoView: function () {},
    appendChild: function () {},
    focus: function () {}
  };
}

function el(id) {
  if (!ELS[id]) { ELS[id] = stubEl(id); }
  return ELS[id];
}

var DOC_HANDLERS = {};

var document = {
  readyState: 'complete',
  hidden: false,
  getElementById: el,
  querySelector: function (sel) { return el(sel); },
  querySelectorAll: function (sel) {
    // 覗き見防止(SPEC 11)の一括ぼかしを検証できるよう、金額系だけ実体を返す
    if (String(sel).indexOf('.amount') >= 0) {
      return [el('liveAmount'), el('todayAmount'), el('monthAmount')];
    }
    return [];
  },
  addEventListener: function (t, f) {
    if (!DOC_HANDLERS[t]) { DOC_HANDLERS[t] = []; }
    DOC_HANDLERS[t][DOC_HANDLERS[t].length] = f;
  }
};

function fireDoc(type) {
  var hs = DOC_HANDLERS[type] || [];
  for (var i = 0; i < hs.length; i++) { hs[i](); }
}

var window = { addEventListener: function () {} };
var location = { reload: function () {} };

var localStorage = (function () {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    clear: function () { m = {}; }
  };
})();

function setTimeout() { return 0; }
function clearTimeout() {}
function setInterval() { return 0; }

var RAF_CB = null;
function requestAnimationFrame(f) { RAF_CB = f; return 0; }
/** 1フレームぶんだけ描画する */
function frame() { if (RAF_CB) { RAF_CB(); } }
