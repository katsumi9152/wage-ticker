/**
 * holidays.js — 日本の国民の祝日を計算する純粋関数(DOM 非依存)。
 *
 * 「国民の祝日に関する法律」(1948年公布、以後の改正を反映)に基づく。
 * 対象は 2000〜2099 年。この範囲外でも例外は投げず、素朴な計算結果を返す
 * (アプリの現実的な利用期間から外れるため、精度は保証しない)。
 *
 * 含めているルール:
 *   - 固定日の祝日(元日・建国記念の日・天皇誕生日・憲法記念日・みどりの日・
 *     こどもの日・山の日・文化の日・勤労感謝の日)
 *   - 何曜日の第何回で決まる祝日(成人の日・海の日・敬老の日・スポーツの日)
 *   - 春分の日・秋分の日(天文計算の近似式。1980〜2099年で有効とされる式)
 *   - 振替休日(祝日が日曜なら、その次の平日で祝日でない日が休日になる)
 *   - 国民の休日(前後を祝日に挟まれた、それ自体は祝日でない平日)
 *   - 2019年(改元)は天皇誕生日なし、2020・2021年(東京オリンピック特例)の
 *     海の日・山の日・スポーツの日の移動、をそれぞれ反映
 *
 * 昭和の日/みどりの日の入れ替わり(2007年施行)は、2007年以降の名称で表示する。
 * それより前の年も日付自体は祝日として扱うため、賃金計算への影響はない。
 */
(function (WT) {
  'use strict';

  var T = WT.time;

  function nthWeekdayOfMonth(year, monthIndex, weekday, n) {
    var first = new Date(year, monthIndex, 1);
    var offset = (weekday - first.getDay() + 7) % 7;
    var day = 1 + offset + (n - 1) * 7;
    return new Date(year, monthIndex, day);
  }

  /** 春分日(3月の日にち)。1980〜2099年で有効とされる近似式。 */
  function vernalEquinoxDay(year) {
    return Math.floor(20.8431 + 0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4);
  }

  /** 秋分日(9月の日にち)。同上。 */
  function autumnalEquinoxDay(year) {
    return Math.floor(23.2488 + 0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4);
  }

  /** その年の祝日を、振替休日・国民の休日を適用する前の「基本の祝日」として列挙する。 */
  function baseHolidays(year) {
    var list = [];
    function add(date, name) { list.push({ date: T.startOfDay(date), name: name }); }

    add(new Date(year, 0, 1), '元日');

    if (year >= 2000) {
      add(nthWeekdayOfMonth(year, 0, 1, 2), '成人の日');
    } else {
      add(new Date(year, 0, 15), '成人の日');
    }

    add(new Date(year, 1, 11), '建国記念の日');

    // 天皇誕生日: 2019年(改元)は無し。2020年以降は2/23、それ以前は12/23。
    if (year === 2019) {
      // 該当日なし
    } else if (year >= 2020) {
      add(new Date(year, 1, 23), '天皇誕生日');
    } else if (year >= 1990) {
      add(new Date(year, 11, 23), '天皇誕生日');
    }

    add(new Date(year, 2, vernalEquinoxDay(year)), '春分の日');

    if (year >= 2007) {
      add(new Date(year, 3, 29), '昭和の日');
    } else {
      add(new Date(year, 3, 29), 'みどりの日');
    }

    add(new Date(year, 4, 3), '憲法記念日');
    if (year >= 2007) {
      add(new Date(year, 4, 4), 'みどりの日');
    }
    add(new Date(year, 4, 5), 'こどもの日');

    // 海の日: 東京オリンピック特例(2020/2021)を除き7月第3月曜(2003年以降)
    if (year === 2020) {
      add(new Date(2020, 6, 23), '海の日');
    } else if (year === 2021) {
      add(new Date(2021, 6, 22), '海の日');
    } else if (year >= 2003) {
      add(nthWeekdayOfMonth(year, 6, 1, 3), '海の日');
    } else if (year >= 1996) {
      add(new Date(year, 6, 20), '海の日');
    }

    // 山の日: 2016年から。2020/2021はオリンピック特例。
    if (year === 2020) {
      add(new Date(2020, 7, 10), '山の日');
    } else if (year === 2021) {
      add(new Date(2021, 7, 8), '山の日');
    } else if (year >= 2016) {
      add(new Date(year, 7, 11), '山の日');
    }

    if (year >= 2003) {
      add(nthWeekdayOfMonth(year, 8, 1, 3), '敬老の日');
    } else if (year >= 1966) {
      add(new Date(year, 8, 15), '敬老の日');
    }

    add(new Date(year, 8, autumnalEquinoxDay(year)), '秋分の日');

    // スポーツの日(2020年に体育の日から改称)。2020/2021はオリンピック特例で7月。
    if (year === 2020) {
      add(new Date(2020, 6, 24), 'スポーツの日');
    } else if (year === 2021) {
      add(new Date(2021, 6, 23), 'スポーツの日');
    } else if (year >= 2000) {
      add(nthWeekdayOfMonth(year, 9, 1, 2), year >= 2020 ? 'スポーツの日' : '体育の日');
    } else if (year >= 1966) {
      add(new Date(year, 9, 10), '体育の日');
    }

    add(new Date(year, 10, 3), '文化の日');
    add(new Date(year, 10, 23), '勤労感謝の日');

    list.sort(function (a, b) { return a.date.getTime() - b.date.getTime(); });
    return list;
  }

  /**
   * 国民の休日(前後を祝日に挟まれた、それ自体は祝日でない平日)を追加する。
   * 例年9月に敬老の日と秋分の日が中1日空くケースなどで発生する。
   */
  function addCitizensHolidays(base) {
    var byKey = {};
    for (var i = 0; i < base.length; i++) byKey[T.dateKey(base[i].date)] = true;

    var extra = [];
    for (var j = 0; j < base.length; j++) {
      var candidate = T.addDays(base[j].date, 1);
      var candidateKey = T.dateKey(candidate);
      if (byKey[candidateKey]) continue; // 既に祝日
      if (candidate.getDay() === 0) continue; // 日曜は対象外(振替休日側で扱う)
      var nextKey = T.dateKey(T.addDays(candidate, 1));
      if (byKey[nextKey]) {
        extra.push({ date: candidate, name: '国民の休日' });
        byKey[candidateKey] = true;
      }
    }
    return base.concat(extra);
  }

  /**
   * 振替休日を追加する(2007年改正後のルール: 日曜の祝日から、祝日でない
   * 直近の平日まで飛ばして休日にする)。
   */
  function addSubstituteHolidays(list) {
    var sorted = list.slice().sort(function (a, b) { return a.date.getTime() - b.date.getTime(); });
    var byKey = {};
    for (var i = 0; i < sorted.length; i++) byKey[T.dateKey(sorted[i].date)] = true;

    var extra = [];
    for (var j = 0; j < sorted.length; j++) {
      if (sorted[j].date.getDay() !== 0) continue;
      var candidate = T.addDays(sorted[j].date, 1);
      var guard = 0;
      while (byKey[T.dateKey(candidate)] && guard++ < 10) {
        candidate = T.addDays(candidate, 1);
      }
      var key = T.dateKey(candidate);
      if (!byKey[key]) {
        extra.push({ date: candidate, name: '振替休日' });
        byKey[key] = true;
      }
    }
    return sorted.concat(extra);
  }

  var CACHE = {};

  /** その年の祝日一覧(振替休日・国民の休日を反映済み)。dateKey で引けるようにする。 */
  function nationalHolidaysOfYear(year) {
    if (CACHE[year]) return CACHE[year];
    var withCitizens = addCitizensHolidays(baseHolidays(year));
    var full = addSubstituteHolidays(withCitizens);
    full.sort(function (a, b) { return a.date.getTime() - b.date.getTime(); });

    var byKey = {};
    for (var i = 0; i < full.length; i++) {
      var key = T.dateKey(full[i].date);
      // 同じ日に複数名前が付く場合は、実質の祝日名(振替休日・国民の休日でない方)を優先する
      if (!byKey[key] || byKey[key].name === '振替休日' || byKey[key].name === '国民の休日') {
        byKey[key] = { date: full[i].date, name: full[i].name };
      }
    }
    CACHE[year] = { list: full, byKey: byKey };
    return CACHE[year];
  }

  /** date が国民の祝日なら { name } を、そうでなければ null を返す。 */
  function isNationalHoliday(date) {
    var year = date.getFullYear();
    var key = T.dateKey(date);
    var entry = nationalHolidaysOfYear(year).byKey[key];
    if (entry) return { name: entry.name };
    // 年をまたぐ振替休日は発生しない仕様だが、12月末/1月頭は前後の年も見ておく
    if (date.getMonth() === 0) {
      var prevEntry = nationalHolidaysOfYear(year - 1).byKey[key];
      if (prevEntry) return { name: prevEntry.name };
    }
    if (date.getMonth() === 11) {
      var nextEntry = nationalHolidaysOfYear(year + 1).byKey[key];
      if (nextEntry) return { name: nextEntry.name };
    }
    return null;
  }

  WT.holidays = {
    nthWeekdayOfMonth: nthWeekdayOfMonth,
    vernalEquinoxDay: vernalEquinoxDay,
    autumnalEquinoxDay: autumnalEquinoxDay,
    baseHolidays: baseHolidays,
    nationalHolidaysOfYear: nationalHolidaysOfYear,
    isNationalHoliday: isNationalHoliday,
  };
})((globalThis.WT = globalThis.WT || {}));
