/**
 * constants.js — 定数の一元管理(SPEC 14: 割増率の値は定数として1箇所にまとめる)
 *
 * 就業規則が法定を上回る場合は、ここの値だけを書き換えれば全体に反映される。
 */
(function (WT) {
  'use strict';

  /** 割増率(SPEC 3.3)。深夜は他の割増と「加算」される。 */
  WT.RATE = {
    /**
     * 所定内労働。法的には「基本給で支払い済み=追加支払いなし(0)」だが、
     * リアルタイム表示では基本給の日割り取り崩しとして 1.00 で積み上げる(SPEC 3.3 注記)。
     */
    SCHEDULED_INSIDE: 1.0,
    /** 法定内残業(所定超・法定内)。割増義務はないが基本給の対象外なので 1.00 で別途支払う。 */
    LEGAL_INSIDE_OVERTIME: 1.0,
    /** 法定時間外労働(月60hまで) */
    STATUTORY_OVERTIME: 1.25,
    /** 法定時間外労働(月60h超) */
    STATUTORY_OVERTIME_OVER60: 1.5,
    /** 深夜割増(22:00〜翌5:00)。他の割増に加算する。 */
    NIGHT_PREMIUM: 0.25,
    /** 法定休日労働(深夜と重なれば +0.25 で 1.60) */
    LEGAL_HOLIDAY: 1.35,
  };

  /** 深夜時間帯(SPEC 3.3 / 5.5) */
  WT.NIGHT_START_HOUR = 22;
  WT.NIGHT_END_HOUR = 5;

  /** 月60時間の割増率変更ライン(分) */
  WT.OVER60_THRESHOLD_MINUTES = 60 * 60;

  /** 法定労働時間の総枠の算出に使う週法定労働時間 */
  WT.WEEKLY_LEGAL_HOURS = 40;

  /** 年間所定労働日数の算出。うるう年も365固定(SPEC 3.1) */
  WT.DAYS_IN_YEAR = 365;

  /** 休憩時間帯が未登録のときに一律控除する分数(SPEC 5.2) */
  WT.DEFAULT_BREAK_MINUTES = 60;

  /**
   * 一律控除を「何分の実働をかけて消化しきるか」。
   * 一律60分を最初からまとめて引くとリアルタイム表示が朝いちばんマイナスになり、
   * 「開いた瞬間に増えている」という体験(SPEC 1.1)が壊れる。そのため所定的な
   * 1日(8時間)をかけて滑らかに引き切る方式を採る。8時間以上働けば控除は
   * ちょうど60分となり、SPEC 5.2 の一律60分と一致する。
   */
  WT.FLAT_BREAK_RAMP_MINUTES = 8 * 60;

  /** 36協定の目安(分)。SPEC 7.4 / 8.1 の参考表示にのみ使う。 */
  WT.AGREEMENT_36 = {
    MONTHLY_GUIDE_MINUTES: 45 * 60, // 原則上限 月45時間
    MONTHLY_HARD_MINUTES: 100 * 60, // 単月100時間未満
    MULTI_MONTH_AVG_MINUTES: 80 * 60, // 複数月(2〜6ヶ月)平均80時間以内
    ANNUAL_MINUTES: 360 * 60, // 年360時間
    ANNUAL_SPECIAL_MINUTES: 720 * 60, // 特別条項ありの年720時間
    OVER45_COUNT_LIMIT: 6, // 月45時間超は年6回まで
  };

  /** 休憩の法定付与ライン(SPEC 8.2 ①) */
  WT.BREAK_LAW = {
    OVER_6H_MINUTES: 6 * 60,
    OVER_8H_MINUTES: 8 * 60,
  };

  /** 残業時間サマリー履歴の保持件数(SPEC 7.3 / 7.4) */
  WT.OVERTIME_HISTORY_MAX = 12;

  /** localStorage のキー(SPEC 12) */
  WT.STORAGE_KEYS = {
    settings: 'wageSettings',
    state: 'wageState',
    calendar: 'wageCalendar',
    currentLog: 'wageCurrentPeriodLog',
    previousLog: 'wagePreviousPeriodLog',
    overtimeHistory: 'wageOvertimeHistory',
  };

  /** 初期設定のデフォルト値(SPEC 4 / 4.1) */
  WT.DEFAULT_SETTINGS = {
    /** 基本給(月額・円)。個人差が大きいためデフォルトなし。 */
    monthlyBaseSalary: null,
    /** 1日の所定労働時間(時間) */
    dailyScheduledHours: 7.5,
    /** 年間所定休日数(日) */
    annualHolidays: 120,
    /** 賃金締め日。1〜31 の数値、または 'last'(末日) */
    closingDay: 'last',
    /** 法定休日の曜日(0=日 〜 6=土) */
    legalHolidayWeekday: 0,
    /** 所定労働日の曜日。法定休日の曜日とその前日を休みとした週休二日制を既定とする。 */
    workdays: [1, 2, 3, 4, 5],
    /** 休憩時間帯。null なら一律 DEFAULT_BREAK_MINUTES を控除(SPEC 5.2) */
    breakWindow: { start: '12:00', end: '13:00' },
    /** 勤務間インターバルの目安(時間・SPEC 8.2 ②) */
    intervalGuideHours: 11,
    /**
     * 覗き見防止のぼかし(SPEC 11)。
     * 仕様上は常時オンだが、利用者の希望でオン/オフを選べるようにしている。
     * 既定はオン(安全側)。オフにすると金額がそのまま表示され、目のアイコンも消える。
     */
    privacyBlur: true,
    /** 自動モード(SPEC 5.3) */
    autoMode: false,
    /** 標準勤務スケジュール(自動モード時)。曜日は workdays を共用する。 */
    schedule: { start: '09:00', end: '17:30' },
  };

  /** 基本給のプレースホルダ(SPEC 4) */
  WT.BASE_SALARY_PLACEHOLDER = 300000;

  WT.WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

  /**
   * 曜日を並べる順(月曜始まり)。値そのものは Date.getDay() と同じ 0=日 のまま扱い、
   * 表示の順序だけをここで決める。
   */
  WT.WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
})((globalThis.WT = globalThis.WT || {}));
