"use strict";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DATA_FILE = DEMO ? "data/demo.csv" : "data/scores.csv";
const JOURNAL_PAGE = 15;

const state = {
  config: null,
  entries: [],
  period: null, // 1..4 or "year"
  open: new Set(),
  journalClass: "all",
  journalLimit: JOURNAL_PAGE,
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.setAttribute("style", v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const fmtDate = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return isNaN(d) ? iso : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
};

const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

// ---------- CSV ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function normClass(s) {
  return s
    .toLowerCase()
    .replace(/класс/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

function buildCriterionLookup(criteria) {
  const map = new Map();
  for (const c of criteria) {
    map.set(c.id.toLowerCase(), c.id);
    map.set(c.name.toLowerCase(), c.id);
    map.set(c.name.toLowerCase().replace(/ё/g, "е"), c.id);
  }
  return map;
}

function toEntries(rows, config) {
  const lookup = buildCriterionLookup(config.criteria);
  const warnings = [];
  const entries = [];
  // the header row is optional: skip the first row only if it does not start with a date
  const hasHeader = rows.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test((rows[0][0] || "").trim());
  const aliases = config.aliases || {};
  rows.slice(hasHeader ? 1 : 0).forEach((r, i) => {
    const line = i + (hasHeader ? 2 : 1);
    const [date = "", quarter = "", cls = "", crit = "", pts = "", reason = ""] = r.map((c) => c.trim());
    const q = Number(quarter);
    const classId = aliases[normClass(cls)] || normClass(cls);
    const critId = lookup.get(crit.toLowerCase()) || lookup.get(crit.toLowerCase().replace(/ё/g, "е"));
    const points = Number(pts.replace(",", ".").replace("−", "-"));
    if (![1, 2, 3, 4].includes(q)) return warnings.push(`строка ${line}: четверть «${quarter}»`);
    if (!config.classes[classId]) return warnings.push(`строка ${line}: класс «${cls}»`);
    if (!critId) return warnings.push(`строка ${line}: критерий «${crit}»`);
    if (!Number.isFinite(points)) return warnings.push(`строка ${line}: баллы «${pts}»`);
    entries.push({ date, quarter: q, cls: classId, crit: critId, points, reason, line });
  });
  return { entries, warnings };
}

// ---------- scoring ----------
function quarterActive(q) {
  const qc = state.config.quarters.find((x) => x.id === q);
  return todayISO() >= qc.start || state.entries.some((e) => e.quarter === q);
}

function quarterScores(q, cls) {
  const by = {};
  for (const c of state.config.criteria) {
    const raw = state.entries.filter((e) => e.quarter === q && e.cls === cls && e.crit === c.id).reduce((s, e) => s + e.points, 0);
    const base = quarterActive(q) ? c.base || 0 : 0;
    by[c.id] = Math.max(0, Math.min(c.max, base + raw));
  }
  const total = Object.values(by).reduce((s, v) => s + v, 0);
  return { by, total };
}

function rankList(items, cmp) {
  const sorted = [...items].sort(cmp);
  let rank = 0;
  sorted.forEach((it, i) => {
    if (i === 0 || cmp(sorted[i - 1], it) !== 0) rank = i + 1;
    it.rank = rank;
  });
  return sorted;
}

const activityPts = (by) => (by.events || 0) + (by.good || 0);

function leagueRanking(league, period) {
  if (period !== "year") {
    const items = league.classes.map((cls) => ({ cls, ...quarterScores(period, cls) }));
    return rankList(items, (a, b) => b.total - a.total || activityPts(b.by) - activityPts(a.by));
  }
  // year: sum quarters, tie-break by quarter wins, then activity
  const wins = Object.fromEntries(league.classes.map((c) => [c, 0]));
  const sums = Object.fromEntries(league.classes.map((c) => [c, { by: {}, total: 0 }]));
  for (const q of [1, 2, 3, 4]) {
    if (!quarterActive(q)) continue;
    const r = leagueRanking(league, q);
    for (const it of r) {
      if (it.rank === 1 && it.total > 0 && r.some((o) => o.total !== it.total)) wins[it.cls]++;
      const s = sums[it.cls];
      s.total += it.total;
      for (const [k, v] of Object.entries(it.by)) s.by[k] = (s.by[k] || 0) + v;
    }
  }
  const items = league.classes.map((cls) => ({ cls, by: sums[cls].by, total: sums[cls].total, wins: wins[cls] }));
  return rankList(items, (a, b) => b.total - a.total || b.wins - a.wins || activityPts(b.by) - activityPts(a.by));
}

// ---------- rendering ----------
function cupIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("class", "leader-cup");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    '<circle cx="24" cy="24" r="24" fill="#f5b301"/>' +
    '<path d="M16 13h16v7a8 8 0 0 1-16 0z" fill="#fff"/>' +
    '<path d="M16 15h-4a4 4 0 0 0 5 6M32 15h4a4 4 0 0 1-5 6" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>' +
    '<rect x="22" y="27" width="4" height="5" fill="#fff"/><rect x="17" y="32" width="14" height="4" rx="1.5" fill="#fff"/>';
  return svg;
}

function periodLabel(p) {
  return p === "year" ? "год" : `${p} четверть`;
}

function renderPeriods() {
  const box = $("#period-switch");
  box.replaceChildren();
  const opts = [...state.config.quarters.map((q) => ({ id: q.id, label: q.name, short: `${q.id} четв.` })), { id: "year", label: "Итог года", short: "Год" }];
  for (const o of opts) {
    box.append(
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(state.period === o.id),
          onclick: () => {
            state.period = o.id;
            state.journalLimit = JOURNAL_PAGE;
            render();
          },
        },
        el("span", { class: "long" }, o.label),
        el("span", { class: "short", "aria-hidden": "true" }, o.short),
      ),
    );
  }
  const note = $("#period-note");
  if (state.period === "year") {
    note.textContent = "Сумма баллов за все четверти, максимум 400. При равенстве выше класс, который чаще был лидером четверти.";
  } else {
    const q = state.config.quarters.find((x) => x.id === state.period);
    note.textContent = quarterActive(q.id)
      ? `${fmtDate(q.start)} — ${fmtDate(q.end)} · максимум 100 баллов`
      : `Четверть начнётся ${fmtDate(q.start)}`;
  }
}

function renderLeagues() {
  const box = $("#leagues");
  box.replaceChildren();
  const crit = state.config.criteria;
  const maxTotal = state.period === "year" ? 400 : 100;
  const active = state.period === "year" ? [1, 2, 3, 4].some(quarterActive) : quarterActive(state.period);

  for (const league of state.config.leagues) {
    const ranking = leagueRanking(league, state.period);
    const section = el(
      "article",
      { class: "league", "aria-labelledby": `lg-${league.id}` },
      el("div", { class: "league-head" }, el("h2", { id: `lg-${league.id}` }, league.name), el("span", { class: "league-sub" }, league.subtitle)),
    );

    if (!active) {
      section.append(el("p", { class: "empty" }, "Рейтинг появится, когда начнётся четверть."));
      box.append(section);
      continue;
    }

    const top = ranking.filter((r) => r.rank === 1);
    if (top.length === 1 && top[0].total > 0 && ranking.some((r) => r.total !== top[0].total)) {
      const label = state.period === "year" ? "Лидер года" : `Лидер ${state.period} четверти`;
      section.append(
        el("div", { class: "leader" }, cupIcon(), el("div", {}, el("span", { class: "leader-label" }, label), el("span", { class: "leader-name" }, state.config.classes[top[0].cls]))),
      );
    }

    const allEqual = ranking.every((r) => r.total === ranking[0].total);
    if (allEqual) {
      section.append(
        el(
          "p",
          { class: "tie-note" },
          ranking[0].total === 0 || state.period === "year"
            ? "Пока все классы на равных — баллы ещё не начислены."
            : `Пока все классы на равных: у каждого стартовые ${ranking[0].total} ${plural(ranking[0].total, "балл", "балла", "баллов")} за дисциплину.`,
        ),
      );
    }

    const list = el("ol", { class: "rows" });
    for (const it of ranking) {
      const key = `${league.id}:${it.cls}`;
      const open = state.open.has(key);
      const detailId = `d-${league.id}-${it.cls}`;
      const bar = el("span", { class: "bar", "aria-hidden": "true" });
      for (const c of crit) {
        const v = it.by[c.id] || 0;
        if (v > 0) bar.append(el("span", { style: `width:${(v / maxTotal) * 100}%;background:${c.color}`, title: `${c.name}: ${v}` }));
      }
      const btn = el(
        "button",
        {
          type: "button",
          class: "row-btn",
          "aria-expanded": String(open),
          "aria-controls": detailId,
          onclick: () => {
            open ? state.open.delete(key) : state.open.add(key);
            renderLeagues();
          },
        },
        allEqual
          ? el("span", { class: "rank", "aria-label": "место не определено" }, "–")
          : el("span", { class: `rank rank-${it.rank}`, "aria-label": `${it.rank} место` }, it.rank),
        el("span", { class: "cls-name" }, state.config.classes[it.cls]),
        el("span", { class: "total" }, it.total, " ", el("small", {}, `/ ${maxTotal}`)),
        bar,
      );
      const li = el("li", { class: "row" }, btn);
      if (open) li.append(renderDetail(it, detailId, maxTotal));
      list.append(li);
    }
    section.append(list);
    box.append(section);
  }
}

function renderDetail(it, id, maxTotal) {
  const mult = maxTotal / 100;
  const list = el("ul", { class: "detail-list" });
  for (const c of state.config.criteria) {
    const v = it.by[c.id] || 0;
    const max = c.max * mult;
    list.append(
      el(
        "li",
        { class: "detail-item" },
        el("span", {}, el("span", { class: "dot", style: `background:${c.color};margin-right:8px` }), c.name),
        el("span", {}, el("b", {}, v), ` / ${max}`),
        el("span", { class: "mini", "aria-hidden": "true" }, el("span", { style: `width:${(v / max) * 100}%;background:${c.color}` })),
      ),
    );
  }
  const extra = state.period === "year" && it.wins ? el("p", { class: "detail-empty" }, `Лидер четверти: ${it.wins} ${plural(it.wins, "раз", "раза", "раз")}`) : null;
  return el("div", { class: "detail", id }, list, extra);
}

function renderLegend() {
  const ul = $("#legend");
  ul.replaceChildren(...state.config.criteria.map((c) => el("li", {}, el("span", { class: "dot", style: `background:${c.color}` }), c.name)));
}

function renderJournalFilter() {
  const sel = $("#journal-class");
  sel.replaceChildren(el("option", { value: "all" }, "Все классы"), ...state.config.leagues.flatMap((l) => l.classes).map((id) => el("option", { value: id }, state.config.classes[id])));
  sel.value = state.journalClass;
  sel.onchange = () => {
    state.journalClass = sel.value;
    state.journalLimit = JOURNAL_PAGE;
    renderJournal();
  };
}

function renderJournal() {
  const box = $("#journal");
  const critById = Object.fromEntries(state.config.criteria.map((c) => [c.id, c]));
  const items = state.entries
    .filter((e) => (state.period === "year" || e.quarter === state.period) && (state.journalClass === "all" || e.cls === state.journalClass))
    .sort((a, b) => b.date.localeCompare(a.date) || b.line - a.line);

  if (!items.length) {
    box.replaceChildren(el("p", { class: "empty" }, `За ${periodLabel(state.period)} начислений пока нет.`));
    return;
  }
  const list = el("ul", { class: "journal" });
  for (const e of items.slice(0, state.journalLimit)) {
    const c = critById[e.crit];
    const sign = e.points > 0 ? "+" : e.points < 0 ? "−" : "";
    list.append(
      el(
        "li",
        { class: "j-item" },
        el("time", { class: "j-date", datetime: e.date }, fmtDate(e.date)),
        el(
          "div",
          { class: "j-main" },
          el("span", { class: "j-reason" }, e.reason || c.name),
          el("span", { class: "j-meta" }, el("span", {}, state.config.classes[e.cls]), el("span", { class: "chip" }, el("span", { class: "dot", style: `background:${c.color}` }), c.name)),
        ),
        el("span", { class: `j-pts ${e.points > 0 ? "pos" : e.points < 0 ? "neg" : ""}` }, `${sign}${Math.abs(e.points)}`),
      ),
    );
  }
  const nodes = [list];
  if (items.length > state.journalLimit) {
    nodes.push(
      el(
        "button",
        {
          type: "button",
          class: "more",
          onclick: () => {
            state.journalLimit += JOURNAL_PAGE;
            renderJournal();
          },
        },
        `Показать ещё (${items.length - state.journalLimit})`,
      ),
    );
  }
  box.replaceChildren(...nodes);
}

function renderCriteriaTable() {
  $("#criteria-body").replaceChildren(
    ...state.config.criteria.map((c) =>
      el(
        "tr",
        {},
        el("th", { scope: "row" }, el("span", { class: "dot", style: `background:${c.color};margin-right:8px` }), c.name),
        el("td", { class: "num" }, c.max),
        el("td", {}, c.rule),
      ),
    ),
  );
}

function renderFooter(warnings) {
  const last = state.entries.reduce((m, e) => (e.date > m ? e.date : m), "");
  $("#updated").textContent = last ? `Последнее начисление: ${fmtDate(last)} ${last.slice(0, 4)} г.` : "Баллы ещё не начислялись.";
  const w = $("#warnings");
  if (warnings.length) {
    w.hidden = false;
    w.textContent = `Не удалось прочитать ${warnings.length} ${plural(warnings.length, "строку", "строки", "строк")} в файле баллов: ${warnings.slice(0, 5).join("; ")}${warnings.length > 5 ? "…" : ""}`;
    console.warn("scores.csv:", warnings);
  }
}

function render() {
  renderPeriods();
  renderLeagues();
  renderJournal();
}

function defaultPeriod() {
  const t = todayISO();
  const qs = state.config.quarters;
  if (t > qs[qs.length - 1].end) return "year";
  const cur = qs.find((q) => t >= q.start && t <= q.end) || [...qs].reverse().find((q) => t >= q.start);
  return cur ? cur.id : qs[0].id;
}

async function init() {
  try {
    const [config, csv] = await Promise.all([
      fetch("data/config.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch(DATA_FILE, { cache: "no-cache" }).then((r) => r.text()),
    ]);
    state.config = config;
    const { entries, warnings } = toEntries(parseCSV(csv), config);
    state.entries = entries;

    $("#school-name").textContent = config.school;
    $("#year-label").textContent = config.year;
    $("#demo-banner").hidden = !DEMO;

    const p = params.get("q");
    state.period = p === "year" ? "year" : [1, 2, 3, 4].includes(Number(p)) ? Number(p) : defaultPeriod();

    renderLegend();
    renderCriteriaTable();
    renderJournalFilter();
    renderFooter(warnings);
    render();
  } catch (err) {
    console.error(err);
    $("#leagues").replaceChildren(el("p", { class: "empty" }, "Не удалось загрузить данные рейтинга. Обновите страницу."));
  }
}

init();
