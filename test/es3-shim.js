/**
 * es3-shim.js — テスト実行用の補完(test/run.ps1 からのみ読み込む)。
 *
 * Windows Script Host の JavaScript エンジンは ES3 相当で、ES5 の配列メソッドや
 * JSON を持たない。アプリ本体を書き換えずにコマンドラインで動かすために、
 * 足りないものだけをここで補う。ブラウザではこのファイルは読み込まれない。
 */

if (!Array.isArray) { Array.isArray = function (o) { return o instanceof Array; }; }
if (!Array.prototype.map) { Array.prototype.map = function (f) { var r = []; for (var i = 0; i < this.length; i++) { r[i] = f(this[i], i, this); } return r; }; }
if (!Array.prototype.filter) { Array.prototype.filter = function (f) { var r = []; for (var i = 0; i < this.length; i++) { if (f(this[i], i, this)) { r[r.length] = this[i]; } } return r; }; }
if (!Array.prototype.indexOf) { Array.prototype.indexOf = function (x) { for (var i = 0; i < this.length; i++) { if (this[i] === x) { return i; } } return -1; }; }
if (!Array.prototype.forEach) { Array.prototype.forEach = function (f) { for (var i = 0; i < this.length; i++) { f(this[i], i, this); } }; }
if (!String.prototype.trim) { String.prototype.trim = function () { return this.replace(/^\s+|\s+$/g, ''); }; }
if (!Date.now) { Date.now = function () { return new Date().getTime(); }; }
if (!Object.assign) {
  Object.assign = function (t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      for (var k in s) { if (Object.prototype.hasOwnProperty.call(s, k)) { t[k] = s[k]; } }
    }
    return t;
  };
}

function __jsonQuote(s) {
  var r = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"') { r += '\\"'; }
    else if (c === '\\') { r += '\\\\'; }
    else if (code < 32) { r += '\\u' + ('0000' + code.toString(16)).slice(-4); }
    else { r += c; }
  }
  return r + '"';
}

if (typeof JSON === 'undefined') {
  var JSON = {
    stringify: function (v) {
      var t = typeof v;
      if (v === null) { return 'null'; }
      if (t === 'number') { return isFinite(v) ? String(v) : 'null'; }
      if (t === 'boolean') { return String(v); }
      if (t === 'string') { return __jsonQuote(v); }
      if (t === 'undefined' || t === 'function') { return undefined; }
      if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) {
          var s = JSON.stringify(v[i]);
          a[a.length] = (s === undefined ? 'null' : s);
        }
        return '[' + a.join(',') + ']';
      }
      var out = [];
      for (var k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k)) {
          var sv = JSON.stringify(v[k]);
          if (sv !== undefined) { out[out.length] = __jsonQuote(k) + ':' + sv; }
        }
      }
      return '{' + out.join(',') + '}';
    },
    // テスト専用。自分で stringify したデータしか渡さない前提の簡易実装。
    parse: function (text) { return eval('(' + text + ')'); }
  };
}
