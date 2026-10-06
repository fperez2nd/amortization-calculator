"use strict";

const round2 = x => Math.round((x + Number.EPSILON) * 100) / 100;

function monthlyPayment(principal, annualRate, months) {
  const r = annualRate / 100 / 12;
  if (months <= 0) return 0;
  if (r === 0) return round2(principal / months);
  return round2(principal * r / (1 - Math.pow(1 + r, -months)));
}

function amortize(opts) {
  const {principal: principal, rate: rate, months: months} = opts;
  const r = rate / 100 / 12;
  const payment = opts.payment > 0 ? round2(opts.payment) : monthlyPayment(principal, rate, months);
  const extraMonthly = opts.extraMonthly || 0;
  const lumps = opts.lumps || {};
  const recast = opts.recast || "none";
  const pmiMonthly = !(opts.homeValue > 0) ? 0 : opts.pmiMonthly > 0 ? round2(opts.pmiMonthly) : opts.pmiRate > 0 ? round2(principal * opts.pmiRate / 100 / 12) : 0;
  const pmiLimit = opts.homeValue * .78;
  const rows = [];
  const recasts = [];
  let pmt = payment;
  let balance = principal;
  let totalInterest = 0;
  let totalPmi = 0;
  for (let i = 0; balance > .005 && i < months * 2; i++) {
    const interest = round2(balance * r);
    let scheduled = i === months - 1 ? balance : Math.min(pmt - interest, balance);
    if (scheduled < 0) scheduled = 0;
    let extra = Math.min(extraMonthly + (lumps[i] || 0), round2(balance - scheduled));
    if (extra < 0) extra = 0;
    const principalPaid = round2(scheduled + extra);
    balance = round2(balance - principalPaid);
    const pmiBasis = i === 0 ? principal : opts.pmiCutoff ? opts.pmiCutoff[i - 1] ?? 0 : rows[i - 1].balance;
    const pmi = pmiMonthly && pmiBasis > pmiLimit ? pmiMonthly : 0;
    totalInterest += interest;
    totalPmi += pmi;
    const row = {
      n: i + 1,
      payment: pmt,
      interest: interest,
      principal: round2(scheduled),
      extra: round2(extra),
      balance: Math.max(balance, 0),
      pmi: pmi,
      cumInterest: round2(totalInterest)
    };
    rows.push(row);
    const remaining = months - (i + 1);
    const trigger = recast === "all" ? extra > 0 : recast === "lumps" ? (lumps[i] || 0) > 0 && extra > 0 : false;
    if (trigger && balance > .005 && remaining > 0) {
      pmt = monthlyPayment(balance, rate, remaining);
      row.recastTo = pmt;
      recasts.push({
        n: i + 1,
        payment: pmt
      });
    }
  }
  return {
    payment: payment,
    finalPayment: pmt,
    rows: rows,
    recasts: recasts,
    recastFees: round2(recasts.length * (opts.recastFee || 0)),
    months: rows.length,
    totalInterest: round2(totalInterest),
    totalPmi: round2(totalPmi)
  };
}

function prepaidInterest(principal, rate, closing, basis) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(closing || "");
  if (!m || !(principal > 0)) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const last = new Date(y, mo, 0).getDate();
  if (mo < 1 || mo > 12 || d < 1 || d > last) return null;
  const days = last - d + 1;
  const perDiem = round2(principal * rate / 100 / basis);
  return {
    days: days,
    perDiem: perDiem,
    total: round2(perDiem * days),
    y: y,
    m: mo - 1,
    d: d,
    last: last
  };
}

const MAX_MONTHS = 1200;

function compute(input) {
  const base = {
    principal: input.principal,
    rate: input.rate,
    months: Math.round(input.years * 12),
    homeValue: input.homeValue,
    pmiRate: input.pmi
  };
  if (input.mode === "progress") {
    if (!(input.originalAmount > 0)) return {
      error: "Enter the original loan amount. The P&I payment is calculated from it, the original term and the rate."
    };
    if (input.principal > input.originalAmount) return {
      error: "The current balance is higher than the original loan amount. Check both."
    };
    input = {
      ...input,
      payment: monthlyPayment(input.originalAmount, input.rate, base.months)
    };
    if (input.payment <= round2(input.principal * input.rate / 1200)) {
      return {
        error: "That P&I payment does not cover a month of interest on this balance. Check the balance and rate."
      };
    }
    const probe = amortize({
      ...base,
      months: MAX_MONTHS,
      payment: input.payment
    });
    if (probe.rows[probe.rows.length - 1].balance > 0) return {
      error: "At that payment the loan would take over 100 years to pay off."
    };
    const k = probe.months, lastRow = probe.rows[k - 1];
    const months = k > 1 && lastRow.principal + lastRow.interest < input.payment * .01 ? k - 1 : k;
    Object.assign(base, {
      months: months,
      payment: input.payment,
      pmiRate: 0,
      pmiMonthly: input.pmiMonthly
    });
  }
  const baseline = amortize(base);
  const cutoff = baseline.rows.map(r => r.balance);
  const actual = amortize({
    ...base,
    extraMonthly: input.extraMonthly,
    lumps: input.lumps,
    recast: input.recast,
    recastFee: input.recastFee,
    pmiCutoff: cutoff
  });
  const escrow = round2(input.tax / 12 + input.insurance / 12 + input.hoa);
  const totalPaid = round2(input.principal + actual.totalInterest + actual.totalPmi + actual.recastFees + escrow * actual.months);
  return {
    baseline: baseline,
    actual: actual,
    escrow: escrow,
    totalPaid: totalPaid
  };
}

if (typeof module !== "undefined") module.exports = {
  monthlyPayment: monthlyPayment,
  amortize: amortize,
  compute: compute,
  round2: round2,
  prepaidInterest: prepaidInterest
};

if (typeof document !== "undefined") {
  const $ = id => document.getElementById(id);
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  });
  const fmt = x => money.format(x);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
  const fields = [ "mode", "originalAmount", "principal", "interestPaid", "rate", "years", "start", "closingDate", "dayBasis", "extraMonthly", "recast", "recastFee", "homeValue", "tax", "insurance", "pmi", "pmiMonthly", "hoa" ];
  const MORTGAGE_FIELDS = [ "homeValue", "tax", "insurance", "pmi", "pmiMonthly", "hoa" ];
  const MAX_SCENARIOS = 4;
  const RECAST_LABEL = {
    none: "No recast",
    lumps: "After one-time payments",
    all: "After every extra payment"
  };
  const MONTHS = [ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" ];
  let view = "month";
  const MAX_SERIES = 600;
  let scenarios = [];
  let active = 0;
  let results = [];
  const today = new Date;
  const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const defaultStart = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
  function parseMonth(s) {
    const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(s || "");
    return m ? {
      y: +m[1],
      m: +m[2] - 1
    } : null;
  }
  const asDate = v => /^\d{4}-\d{2}$/.test(v || "") ? `${v}-01` : v || "";
  function dateFor(start, i) {
    const t = start.y * 12 + start.m + i;
    return {
      y: Math.floor(t / 12),
      m: t % 12
    };
  }
  const label = d => `${MONTHS[d.m]} ${d.y}`;
  function parseAmount(v) {
    const t = String(v ?? "").replace(/[\s$,%]/g, "");
    if (t === "") return null;
    return /^(\d+\.?\d*|\.\d+)$/.test(t) ? parseFloat(t) : NaN;
  }
  const LENIENT = [ ...document.querySelectorAll('input[inputmode="decimal"]:not([readonly])') ].map(el => el.id).filter(Boolean);
  const MONEY = [ "originalAmount", "principal", "interestPaid", "extraMonthly", "recastFee", "homeValue", "tax", "insurance", "pmiMonthly", "hoa" ];
  const isMoney = el => MONEY.includes(el.id) || el.classList.contains("lumpAmt");
  function formatMoney(v) {
    const x = parseAmount(v);
    if (x === null) return "0.00";
    if (Number.isNaN(x)) return String(v);
    return x.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
  const monthKey = d => d.y * 12 + d.m;
  const color = i => `var(--s${i + 1})`;
  function durationText(months) {
    const y = Math.floor(months / 12), m = months % 12;
    return [ y && `${y} yr`, m && `${m} mo` ].filter(Boolean).join(" ") || "0 mo";
  }
  function blankScenario() {
    const v = {};
    fields.forEach(f => {
      v[f] = $(f).defaultValue ?? "";
    });
    v.recast = "none";
    v.mode = "new";
    v.dayBasis = "365";
    v.start = defaultStart;
    return {
      name: "Original",
      v: v,
      lumps: []
    };
  }
  function formToScenario(s) {
    fields.forEach(f => {
      s.v[f] = $(f).value;
    });
    s.name = $("scenarioName").value.trim() || s.name;
    s.lumps = [ ...document.querySelectorAll(".lump") ].map(row => [ row.querySelector(".lumpDate").value, row.querySelector(".lumpAmt").value, row.querySelector(".lumpCount").value, row.dataset.kind ]);
  }
  function scenarioToForm(s) {
    fields.forEach(f => {
      $(f).value = MONEY.includes(f) ? formatMoney(s.v[f]) : f === "start" ? asDate(s.v[f]) : s.v[f] ?? "";
    });
    $("scenarioName").value = s.name;
    $("lumps").innerHTML = "";
    $("series").innerHTML = "";
    const rows = [ ...s.lumps.filter(l => kindOf(l) === "one"), ...s.lumps.filter(l => kindOf(l) === "series") ];
    rows.forEach(l => addLump(l[0], l[1], l[2], kindOf(l)));
    $("mortgage").open = MORTGAGE_FIELDS.some(f => parseAmount(s.v[f]) > 0);
    $("recastBox").open = !!s.v.recast && s.v.recast !== "none";
    syncRecastFee();
    syncMode();
  }
  function inputFrom(s) {
    const num = f => {
      const x = parseAmount(s.v[f]);
      return Number.isFinite(x) ? x : 0;
    };
    const start = parseMonth(s.v.start) || {
      y: today.getFullYear(),
      m: today.getMonth()
    };
    const lumps = {};
    const lumpIdx = s.lumps.map(([d, a, c]) => {
      const dm = parseMonth(d), amt = parseAmount(a);
      if (amt === null || amt === 0) return {
        skip: "empty"
      };
      if (Number.isNaN(amt)) return {
        skip: "amount"
      };
      if (!dm) return {
        skip: "date"
      };
      const count = countOf(c);
      if (!count) return {
        skip: "count"
      };
      const idx = monthKey(dm) - monthKey(start);
      if (idx + count - 1 < 0) return {
        skip: "before",
        date: dm,
        count: count
      };
      const idxs = [];
      for (let k = 0; k < count; k++) {
        if (idx + k < 0) continue;
        lumps[idx + k] = (lumps[idx + k] || 0) + amt;
        idxs.push(idx + k);
      }
      return {
        idx: idx,
        count: count,
        idxs: idxs,
        before: count - idxs.length
      };
    });
    return {
      lumpIdx: lumpIdx,
      mode: s.v.mode === "progress" ? "progress" : "new",
      pmiMonthly: num("pmiMonthly"),
      originalAmount: num("originalAmount"),
      interestPaid: num("interestPaid"),
      closingDate: s.v.closingDate || "",
      dayBasis: s.v.dayBasis === "360" ? 360 : 365,
      principal: num("principal"),
      rate: num("rate"),
      years: Math.max(num("years"), 1 / 12),
      start: start,
      extraMonthly: num("extraMonthly"),
      lumps: lumps,
      recast: RECAST_LABEL[s.v.recast] ? s.v.recast : "none",
      recastFee: num("recastFee"),
      homeValue: num("homeValue"),
      tax: num("tax"),
      insurance: num("insurance"),
      pmi: num("pmi"),
      hoa: num("hoa")
    };
  }
  function countOf(c) {
    const t = String(c ?? "").trim();
    if (t === "") return 1;
    return /^\d+$/.test(t) && +t >= 1 && +t <= MAX_SERIES ? +t : 0;
  }
  const kindOf = l => l[3] === "series" || l[3] === "one" ? l[3] : countOf(l[2]) > 1 ? "series" : "one";
  function addLump(date = "", amt = "", count = "", kind = "one") {
    const node = $("lumpRow").content.firstElementChild.cloneNode(true);
    const series = kind === "series";
    node.dataset.kind = series ? "series" : "one";
    node.querySelector(".lumpDate").value = asDate(date) || $("start").value;
    node.querySelector(".lumpAmt").value = formatMoney(amt);
    node.querySelector(".lumpCount").value = String(count || (series ? "" : "1"));
    if (!series) node.classList.add("no-count");
    if (series) node.querySelector(".dateLabel").textContent = "Start";
    node.querySelector(".remove").onclick = () => {
      node.remove();
      update();
    };
    (series ? $("series") : $("lumps")).appendChild(node);
  }
  function syncRecastFee() {
    $("feeWrap").hidden = $("recast").value === "none";
  }
  function syncMode() {
    const mode = $("mode").value === "progress" ? "progress" : "new";
    document.querySelectorAll("[data-show]").forEach(el => {
      el.hidden = el.dataset.show !== mode;
    });
  }
  const usable = r => r && !r.error;
  function update() {
    formToScenario(scenarios[active]);
    syncRecastFee();
    syncMode();
    results = scenarios.map(s => {
      const input = inputFrom(s);
      return input.principal > 0 ? {
        input: input,
        ...compute(input)
      } : null;
    });
    drawTabs();
    const res = results[active];
    $("error").hidden = !(res && res.error);
    $("error").textContent = res && res.error ? res.error : "";
    $("prompt").hidden = !!res;
    $("prompt").textContent = res ? "" : `Enter ${$("mode").value === "progress" ? "your current principal balance" : "a loan amount"} to see results.`;
    $("schedulePanel").hidden = !usable(res);
    $("chartPanel").hidden = !results.some(usable);
    if (results.filter(usable).length < 2) $("pickerPanel").hidden = true;
    $("payment").value = usable(res) ? fmt(res.actual.payment) : "";
    if (usable(res)) drawTable(res);
    drawSummary();
    drawLumpNotes(res);
    drawPrepaidNote(res);
    LENIENT.forEach(f => $(f).classList.toggle("bad", Number.isNaN(parseAmount($(f).value))));
    document.querySelectorAll(".lumpAmt").forEach(el => el.classList.toggle("bad", Number.isNaN(parseAmount(el.value))));
    if (results.some(usable)) drawChart();
    drawCompare();
    saveHash();
  }
  function drawTabs() {
    const tabs = scenarios.map((s, i) => `<button type="button" class="tab${i === active ? " on" : ""}" data-i="${i}" role="tab" aria-selected="${i === active}">` + `<i style="background:${color(i)}"></i>${esc(s.name)}</button>`).join("");
    const add = scenarios.length < MAX_SCENARIOS ? '<button type="button" class="tab add" id="addScenario" title="Copies the current scenario so you can change one thing">+ Add scenario</button>' : "";
    $("tabs").innerHTML = tabs + add;
    $("tabs").querySelectorAll(".tab[data-i]").forEach(b => b.onclick = () => switchTo(+b.dataset.i));
    if ($("addScenario")) $("addScenario").onclick = addScenario;
    $("removeScenario").hidden = scenarios.length < 2;
    document.querySelectorAll(".scenario-name").forEach(el => {
      el.textContent = scenarios[active].name;
    });
  }
  const todayKey = today.getFullYear() * 12 + today.getMonth();
  const keyLabel = k => label({
    y: Math.floor(k / 12),
    m: k % 12
  });
  const payoffKeyOf = r => monthKey(r.input.start) + r.actual.months - 1;
  function interestFrom(r, fromKey) {
    const s = monthKey(r.input.start);
    return round2(r.actual.rows.reduce((t, row, k) => t + (s + k >= fromKey ? row.interest : 0), 0));
  }
  function prepaidOf(r) {
    if (r.input.mode !== "new") return null;
    return prepaidInterest(r.input.principal, r.input.rate, r.input.closingDate, r.input.dayBasis);
  }
  function paidSoFar(r) {
    const s = monthKey(r.input.start);
    let interest = 0, payments = 0;
    r.actual.rows.forEach((row, k) => {
      if (s + k <= todayKey) {
        interest += row.interest;
        payments++;
      }
    });
    const balance = payments ? r.actual.rows[payments - 1].balance : r.input.principal;
    const baselinePaid = Math.min(Math.max(todayKey - s + 1, 0), r.baseline.months);
    const pre = prepaidOf(r);
    const prepaid = pre && pre.y * 12 + pre.m <= todayKey ? pre.total : 0;
    return {
      interest: round2(interest),
      payments: payments,
      balance: balance,
      baselinePaid: baselinePaid,
      prepaid: prepaid
    };
  }
  function vsOriginal(i) {
    const o = results[0], r = results[i];
    if (i === 0 || !usable(o) || !usable(r)) return null;
    const from = monthKey(r.input.start);
    return {
      name: scenarios[0].name,
      from: from,
      saved: round2(interestFrom(o, from) - r.actual.totalInterest),
      sooner: payoffKeyOf(o) - payoffKeyOf(r)
    };
  }
  function drawSummary() {
    const ok = usable(results[active]);
    $("cards").hidden = !ok;
    if (ok) drawCards(results[active], active);
  }
  function drawCards(res, i) {
    const {input: input, actual: actual, escrow: escrow, totalPaid: totalPaid} = res;
    const firstPmi = actual.rows[0]?.pmi || 0;
    const monthlyAll = actual.payment + input.extraMonthly + escrow + firstPmi;
    $("outPayment").textContent = fmt(monthlyAll);
    const parts = [ `P&I ${fmt(actual.payment)}` ];
    if (input.extraMonthly) parts.push(`extra ${fmt(input.extraMonthly)}`);
    if (escrow) parts.push(`tax/ins/HOA ${fmt(escrow)}`);
    if (firstPmi) parts.push(`PMI ${fmt(firstPmi)}`);
    let detail = esc(parts.join(" + "));
    if (actual.recasts.length) {
      const lastRc = actual.recasts[actual.recasts.length - 1];
      detail += `<br><span class="save">P&amp;I drops to ${fmt(actual.finalPayment)}</span> from ${label(dateFor(input.start, lastRc.n))}` + (actual.recasts.length > 1 ? ` (${actual.recasts.length} recasts)` : " (recast)");
    }
    $("outPaymentDetail").innerHTML = detail;
    $("outInterest").textContent = fmt(totalInterestOf(res));
    $("outPayoff").textContent = label(dateFor(input.start, actual.months - 1));
    $("outTotal").textContent = fmt(wholeLoanPaid(res));
    const incl = [];
    if (escrow) incl.push("taxes, insurance, HOA");
    if (actual.totalPmi) incl.push("PMI");
    if (actual.recastFees) incl.push(`${fmt(actual.recastFees)} recast fees`);
    if (input.mode === "progress") {
      const from = keyLabel(monthKey(input.start));
      let d = `Whole loan: ${fmt(input.originalAmount)} principal + ${fmt(input.interestPaid + actual.totalInterest)} interest`;
      if (!(input.interestPaid > 0)) d += ` (interest paid before ${from} not entered)`;
      if (incl.length) d += `, plus ${incl.join(", ")} from ${from}`;
      $("outTotalDetail").textContent = d;
    } else {
      $("outTotalDetail").textContent = incl.length ? `incl. ${incl.join(", ")}` : "principal + interest";
    }
    const vs = vsOriginal(i);
    if (vs) {
      const name = esc(vs.name), from = keyLabel(vs.from);
      $("outInterestDetail").innerHTML = vs.saved >= .005 ? `<span class="save">${fmt(vs.saved)} saved</span> vs ${name}, counting from ${from}` : vs.saved <= -.005 ? `${fmt(-vs.saved)} more than ${name}, counting from ${from}` : `Same as ${name}, counting from ${from}`;
      $("outPayoffDetail").innerHTML = (vs.sooner > 0 ? `<span class="save">${durationText(vs.sooner)} sooner</span> than ${name}` : vs.sooner < 0 ? `${durationText(-vs.sooner)} later than ${name}` : `Same as ${name}`) + ` &middot; ${durationText(actual.months)} from ${keyLabel(monthKey(input.start))}`;
    } else {
      const p = paidSoFar(res);
      if (p.payments > 0 && p.payments < actual.months) {
        $("outInterestDetail").textContent = `${fmt(p.interest + p.prepaid)} paid through ${keyLabel(todayKey)} on schedule, ${fmt(actual.totalInterest - p.interest)} to go`;
        $("outPayoffDetail").textContent = `${durationText(actual.months)} loan, ${durationText(actual.months - p.payments)} left`;
      } else {
        $("outInterestDetail").textContent = `${(actual.totalInterest / input.principal * 100).toFixed(0)}% of the ${input.mode === "progress" ? "current balance" : "loan amount"}`;
        $("outPayoffDetail").textContent = durationText(actual.months);
      }
    }
    if (input.mode === "progress" && input.interestPaid > 0) {
      $("outInterestDetail").insertAdjacentHTML("beforeend", `<br>${fmt(input.interestPaid)} paid so far + ${fmt(actual.totalInterest)} still to pay`);
    }
    const pre = prepaidOf(res);
    if (pre) $("outInterestDetail").insertAdjacentHTML("beforeend", `<br>incl. ${fmt(pre.total)} prepaid at closing`);
    const paid = paidOff(input);
    if (paid) $("outPayoffDetail").insertAdjacentHTML("beforeend", `<br>${paid.pct}% of the original ${fmt(input.originalAmount)} paid off`);
  }
  function totalInterestOf(r) {
    if (r.input.mode === "progress") return round2(r.input.interestPaid + r.actual.totalInterest);
    return round2(r.actual.totalInterest + (prepaidOf(r)?.total || 0));
  }
  function wholeLoanPaid(r) {
    if (r.input.mode !== "progress") return round2(r.totalPaid + (prepaidOf(r)?.total || 0));
    return round2(r.totalPaid + Math.max(r.input.originalAmount - r.input.principal, 0) + r.input.interestPaid);
  }
  function paidOff(input) {
    if (input.mode !== "progress" || !(input.originalAmount > input.principal)) return null;
    const amt = input.originalAmount - input.principal;
    return {
      amt: amt,
      pct: (amt / input.originalAmount * 100).toFixed(1)
    };
  }
  function drawPrepaidNote(res) {
    const box = $("prepaidBox");
    box.hidden = true;
    if ($("mode").value === "progress" || !$("closingDate").value || !usable(res)) return;
    const pre = prepaidOf(res);
    box.hidden = false;
    if (!pre) {
      box.innerHTML = '<p class="lumpNote bad">Not counted: pick a valid closing date.</p>';
      return;
    }
    const span = `${MONTHS[pre.m]} ${pre.d}${pre.d === pre.last ? "" : `–${pre.last}`}, ${pre.y}`;
    const opt = basis => {
      const p = prepaidInterest(res.input.principal, res.input.rate, res.input.closingDate, basis);
      return `<label><input type="radio" name="prepaidBasis" value="${basis}"${res.input.dayBasis === basis ? " checked" : ""}>` + `<strong>${fmt(p.total)}</strong><span class="dim">${fmt(p.perDiem)}/day, ${basis}-day year</span></label>`;
    };
    box.innerHTML = `<div class="prepaid-head">Prepaid interest <span class="dim">(${pre.days} day${pre.days === 1 ? "" : "s"}, ${span})</span></div>` + opt(365) + opt(360);
  }
  $("prepaidBox").addEventListener("input", e => {
    if (e.target.name === "prepaidBasis") $("dayBasis").value = e.target.value;
  });
  function drawLumpNotes(res) {
    const rows = [ ...document.querySelectorAll(".lump") ];
    rows.forEach((row, k) => {
      const note = row.querySelector(".lumpNote");
      let text = "", bad = false;
      if (usable(res)) {
        const st = res.input.lumpIdx[k] || {
          skip: "empty"
        };
        const startLabel = label(res.input.start);
        const which = res.input.mode === "progress" ? "next payment due" : "first payment";
        if (st.skip === "date") {
          text = "Not counted: pick a month for this payment.";
          bad = true;
        } else if (st.skip === "count") {
          text = `Not counted: enter how many payments, from 1 to ${MAX_SERIES}.`;
          bad = true;
        } else if (st.skip === "amount") {
          text = "Not counted: can't read that amount. Use digits, like 12000.50.";
          bad = true;
        } else if (st.skip === "before") {
          text = st.count > 1 ? `Not counted: all ${st.count} payments fall before the ${which} (${startLabel}).` : `Not counted: ${label(st.date)} is before the ${which} (${startLabel}).`;
          bad = true;
        } else if (st.idx !== undefined) {
          const paidOffBy = label(dateFor(res.input.start, res.actual.months - 1));
          const applied = st.idxs.filter(i => res.actual.rows[i]);
          const after = st.idxs.length - applied.length;
          if (!applied.length) {
            text = `Not counted: the loan is already paid off by then (${paidOffBy}).`;
            bad = true;
          } else if (st.count === 1) text = `Applied with payment #${applied[0] + 1} (${label(dateFor(res.input.start, applied[0]))}).`; else {
            const a = applied[0], b = applied[applied.length - 1];
            const range = a === b ? `payment #${a + 1} (${label(dateFor(res.input.start, a))})` : `payments #${a + 1}–${b + 1} (${label(dateFor(res.input.start, a))} – ${label(dateFor(res.input.start, b))})`;
            const missed = [ st.before && `${st.before} before the ${which}`, after && `${after} after payoff in ${paidOffBy}` ].filter(Boolean);
            text = applied.length === st.count ? `Applied with ${range}.` : `Applied ${applied.length} of ${st.count}: ${range}. Not counted: ${missed.join(", ")}.`;
          }
        }
      }
      note.textContent = text;
      note.hidden = !text;
      note.classList.toggle("bad", bad);
    });
  }
  function niceMax(v) {
    const raw = v / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    return [ 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10 ].map(f => f * mag).find(t => t >= raw) * 4;
  }
  function compact(v) {
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M";
    if (v >= 1e3) return "$" + Math.round(v / 1e3) + "k";
    return "$" + Math.round(v);
  }
  function drawSeriesFilter(live) {
    const box = $("seriesFilter");
    $("pickerPanel").hidden = live.length < 2;
    if (live.length < 2) return;
    const allOn = live.every(r => !scenarios[r.i].hide);
    box.innerHTML = `<button type="button" class="link" id="toggleAll">${allOn ? "Deselect all" : "Select all"}</button>` + live.map(r => `<label><input type="checkbox" data-i="${r.i}"${scenarios[r.i].hide ? "" : " checked"}>` + `<i class="sw" style="background:${color(r.i)}"></i>${esc(scenarios[r.i].name)}</label>`).join("");
    const changed = () => {
      drawChart();
      drawCompare();
      saveHash();
    };
    box.querySelectorAll("input").forEach(cb => cb.onchange = () => {
      scenarios[+cb.dataset.i].hide = !cb.checked;
      changed();
    });
    $("toggleAll").onclick = () => {
      live.forEach(r => {
        scenarios[r.i].hide = allOn;
      });
      changed();
    };
  }
  function drawChart() {
    const live = results.map((r, i) => usable(r) && {
      ...r,
      i: i
    }).filter(Boolean);
    drawSeriesFilter(live);
    const picked = live.length > 1 ? live.filter(r => !scenarios[r.i].hide) : live;
    if (!picked.length) {
      $("chart").innerHTML = '<p class="empty">Pick at least one scenario to chart.</p>';
      $("legend").innerHTML = "";
      return;
    }
    const compare = picked.length > 1;
    const W = 820, H = 300, L = 64, R = compare ? 96 : 12, T = 12, B = 30;
    const series = compare ? picked : [ picked.find(r => r.i === active) || picked[0] ];
    const origin = Math.min(...series.map(r => monthKey(r.input.start)));
    const off = r => monthKey(r.input.start) - origin;
    const n = Math.max(...series.map(r => off(r) + r.baseline.months));
    const yMax = niceMax(Math.max(...series.map(r => compare ? r.input.principal : Math.max(r.input.principal, r.baseline.totalInterest))));
    const x = i => L + i / n * (W - L - R);
    const y = v => T + (1 - v / yMax) * (H - T - B);
    const path = (r, rows, key) => `M${x(off(r)).toFixed(1)},${y(key === "balance" ? r.input.principal : 0).toFixed(1)}` + rows.map((row, k) => `L${x(off(r) + k + 1).toFixed(1)},${y(row[key]).toFixed(1)}`).join("");
    const originDate = {
      y: Math.floor(origin / 12),
      m: origin % 12
    };
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${compare ? "Loan balance by scenario over time" : "Loan balance and cumulative interest over time"}">`;
    for (let k = 0; k <= 4; k++) {
      const v = yMax / 4 * k;
      svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
    }
    const step = n > 240 ? 60 : n > 120 ? 24 : 12;
    for (let i = 0; i <= n; i += step) {
      svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${dateFor(originDate, i).y}</text>`;
    }
    if (compare) {
      const order = [ ...series.filter(r => r.i !== active), series.find(r => r.i === active) ].filter(Boolean);
      for (const r of order) {
        svg += `<path d="${path(r, r.actual.rows, "balance")}" fill="none" style="stroke:var(--surface)" stroke-width="5"/>`;
        svg += `<path d="${path(r, r.actual.rows, "balance")}" fill="none" style="stroke:${color(r.i)}" stroke-width="${r.i === active ? 2.5 : 2}"/>`;
      }
      const placed = [];
      [ ...series ].sort((a, b) => off(a) + a.actual.months - (off(b) + b.actual.months)).forEach(r => {
        const px = x(off(r) + r.actual.months);
        let py = y(0) - 8;
        while (placed.some(p => Math.abs(p.x - px) < 90 && Math.abs(p.y - py) < 14)) py -= 14;
        placed.push({
          x: px,
          y: py
        });
        svg += `<circle cx="${px}" cy="${y(0)}" r="4" style="fill:${color(r.i)};stroke:var(--surface)" stroke-width="2"/>`;
        svg += `<text class="dl" x="${px + 6}" y="${py}">${esc(scenarios[r.i].name)}</text>`;
      });
    } else {
      const r = series[0];
      const hasExtras = r.actual.months < r.baseline.months || r.actual.totalInterest < r.baseline.totalInterest - .005;
      if (hasExtras) {
        svg += `<path d="${path(r, r.baseline.rows, "balance")}" fill="none" style="stroke:var(--s1)" stroke-width="1.5" stroke-dasharray="5 4" opacity=".6"/>`;
        svg += `<path d="${path(r, r.baseline.rows, "cumInterest")}" fill="none" style="stroke:var(--s2)" stroke-width="1.5" stroke-dasharray="5 4" opacity=".6"/>`;
      }
      svg += `<path d="${path(r, r.actual.rows, "cumInterest")}" fill="none" style="stroke:var(--s2)" stroke-width="2.25"/>`;
      svg += `<path d="${path(r, r.actual.rows, "balance")}" fill="none" style="stroke:var(--s1)" stroke-width="2.25"/>`;
    }
    svg += `<line id="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" style="stroke:var(--muted)" stroke-width="1" visibility="hidden"/>`;
    svg += `<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="hover"/></svg>`;
    const chart = $("chart");
    chart.innerHTML = svg + '<div class="tip" hidden></div>';
    if (compare) {
      $("legend").innerHTML = series.map(r => `<span><i style="background:${color(r.i)}"></i>${esc(scenarios[r.i].name)}</span>`).join("");
    } else {
      const r = series[0];
      const hasExtras = r.actual.months < r.baseline.months || r.actual.totalInterest < r.baseline.totalInterest - .005;
      $("legend").innerHTML = '<span><i style="background:var(--s1)"></i>Balance</span><span><i style="background:var(--s2)"></i>Interest paid</span>' + (hasExtras ? '<span><i class="dash"></i>Dashed: without extra payments</span>' : "");
    }
    const svgEl = chart.querySelector("svg"), tip = chart.querySelector(".tip"), cur = chart.querySelector("#cursor");
    const at = (r, rows, k, key, fallback) => k < 0 ? null : rows[k] ? rows[k][key] : fallback;
    chart.querySelector("#hover").onmousemove = e => {
      const box = svgEl.getBoundingClientRect();
      const px = (e.clientX - box.left) / box.width * W;
      const i = Math.max(1, Math.min(n, Math.round((px - L) / (W - L - R) * n)));
      cur.setAttribute("x1", x(i));
      cur.setAttribute("x2", x(i));
      cur.setAttribute("visibility", "visible");
      let html = `<strong>${label(dateFor(originDate, i - 1))}</strong>`;
      if (compare) {
        for (const r of series) {
          const bal = at(r, r.actual.rows, i - 1 - off(r), "balance", 0);
          html += `<br><i class="sw" style="background:${color(r.i)}"></i>${esc(scenarios[r.i].name)}: ${bal === null ? "not started" : fmt(bal)}`;
        }
      } else {
        const r = series[0], k = i - 1 - off(r);
        const hasExtras = r.actual.months < r.baseline.months || r.actual.totalInterest < r.baseline.totalInterest - .005;
        const a = r.actual.rows[k], b = r.baseline.rows[k];
        html += `<br>Balance ${fmt(a ? a.balance : 0)}` + (hasExtras && b ? ` <span class="dim">(${fmt(b.balance)})</span>` : "") + `<br>Interest paid ${fmt(a ? a.cumInterest : r.actual.totalInterest)}` + (hasExtras && b ? ` <span class="dim">(${fmt(b.cumInterest)})</span>` : "");
        if (a && a.recastTo) html += `<br><span class="save">Recast: P&amp;I now ${fmt(a.recastTo)}</span>`;
      }
      tip.innerHTML = html;
      tip.hidden = false;
      const left = x(i) / W * box.width;
      tip.style.left = Math.max(4, Math.min(left + 12, box.width - tip.offsetWidth - 4)) + "px";
      tip.style.top = "8px";
    };
    chart.querySelector("#hover").onmouseleave = () => {
      tip.hidden = true;
      cur.setAttribute("visibility", "hidden");
    };
  }
  function drawCompare() {
    const usableCount = results.filter(usable).length;
    const live = results.map((r, i) => usable(r) && !scenarios[i].hide && {
      ...r,
      i: i
    }).filter(Boolean);
    $("comparePanel").hidden = usableCount < 2;
    $("compareEmpty").hidden = live.length >= 2;
    $("compareWrap").hidden = live.length < 2;
    if (live.length < 2) return;
    const anyRecast = live.some(r => r.input.recast !== "none");
    const anyProgress = live.some(r => r.input.mode === "progress");
    const lumpTotal = r => Object.values(r.input.lumps).reduce((s, a) => s + a, 0);
    const monthlyAll = r => r.actual.payment + r.input.extraMonthly + r.escrow + (r.actual.rows[0]?.pmi || 0);
    const anyPaid = live.some(r => paidSoFar(r).payments > 0);
    const fair = !anyPaid;
    const interestPaidOf = r => r.input.mode === "progress" ? r.input.interestPaid : round2(paidSoFar(r).interest + paidSoFar(r).prepaid);
    const stillToPay = r => round2(r.actual.totalInterest - paidSoFar(r).interest);
    const showPaid = anyPaid || live.some(r => interestPaidOf(r) > 0);
    const stillToPayAll = r => round2(stillToPay(r) + ((prepaidOf(r)?.total || 0) - (r.input.mode === "new" ? paidSoFar(r).prepaid : 0)));
    const name0 = scenarios[0].name;
    const rows = [ [ "First payment", r => label(r.input.start) + (r.input.mode === "progress" ? "" : " (new loan)"), v => v ], [ "Original loan amount", r => r.input.mode === "progress" ? r.input.originalAmount || null : r.input.principal, v => v === null ? "-" : fmt(v) ], ...anyProgress ? [ [ "Current balance", r => r.input.mode === "progress" ? r.input.principal : paidSoFar(r).balance, fmt ], [ "Paid off so far", r => {
      if (r.input.mode === "progress") return paidOff(r.input);
      const amt = r.input.principal - paidSoFar(r).balance;
      return amt > 0 ? {
        amt: amt,
        pct: (amt / r.input.principal * 100).toFixed(1)
      } : null;
    }, v => v ? `${fmt(v.amt)} (${v.pct}%)` : "-" ] ] : [], [ "Interest rate", r => r.input.rate, v => `${v}%` ], [ anyProgress ? "Remaining term (no extra payments)" : "Term", r => r.baseline.months - (anyProgress ? paidSoFar(r).baselinePaid : 0), durationText ], ...anyProgress ? [ [ "Term (remaining)", r => r.actual.months - paidSoFar(r).payments, durationText, true ] ] : [], [ "Extra each month", r => r.input.extraMonthly, fmt ], [ "Extra payments by date", lumpTotal, fmt ], ...anyRecast ? [ [ "Recast", r => RECAST_LABEL[r.input.recast], v => v ] ] : [], null, [ "Monthly payment", monthlyAll, fmt, true ], ...anyRecast ? [ [ "P&I after recasts", r => r.actual.finalPayment, fmt, true ] ] : [], ...showPaid ? [ [ "Interest paid so far", interestPaidOf, v => v ? fmt(v) : "-" ], [ "Interest still to pay", stillToPayAll, fmt, true ] ] : [], [ "Total interest", totalInterestOf, fmt, live.every(r => r.input.mode !== "progress" || r.input.interestPaid > 0) ], [ "Payoff", payoffKeyOf, keyLabel, true ], [ "Time to payoff", r => r.actual.months, durationText, fair ], [ "Total paid", wholeLoanPaid, fmt, fair ], [ `Interest saved vs ${name0}`, r => vsOriginal(r.i)?.saved ?? null, v => v === null ? "-" : v <= -.005 ? `-${fmt(-v)}` : fmt(v), "high" ], [ `Payoff vs ${name0}`, r => vsOriginal(r.i)?.sooner ?? null, v => v === null ? "-" : v > 0 ? `${durationText(v)} sooner` : v < 0 ? `${durationText(-v)} later` : "Same", "high" ] ];
    let html = "<thead><tr><th></th>" + live.map(r => `<th><i class="sw" style="background:${color(r.i)}"></i>${esc(scenarios[r.i].name)}</th>`).join("") + "</tr></thead><tbody>";
    for (const row of rows) {
      if (!row) {
        html += `<tr class="sep"><td colspan="${live.length + 1}"></td></tr>`;
        continue;
      }
      const [name, val, show, dir] = row;
      const vals = live.map(val);
      const nums = vals.filter(v => typeof v === "number");
      const best = !dir || new Set(nums).size < 2 ? null : dir === "high" ? Math.max(...nums) : Math.min(...nums);
      html += `<tr><th scope="row">${esc(name)}</th>` + vals.map(v => `<td${best !== null && v === best ? ' class="best"' : ""}>${esc(show(v))}</td>`).join("") + "</tr>";
    }
    $("compare").innerHTML = html + "</tbody>";
  }
  function scheduleData({input: input, actual: actual, escrow: escrow}) {
    const showPmi = actual.totalPmi > 0, showEsc = escrow > 0, showPmt = actual.recasts.length > 0, showLtv = input.homeValue > 0;
    const head = [ "Payment #", "Date", ...showPmt ? [ "P&I payment" ] : [], "Principal", "Interest", "Interest to date", "Extra", "Total to loan", ...showPmi ? [ "PMI" ] : [], ...showEsc ? [ "Tax/Ins/HOA" ] : [], "Balance", ...showLtv ? [ "LTV %" ] : [] ];
    const ltv = bal => round2(bal / input.homeValue * 100);
    const rows = actual.rows.map((r, i) => [ r.n, label(dateFor(input.start, i)), ...showPmt ? [ r.payment ] : [], r.principal, r.interest, r.cumInterest, r.extra, round2(r.principal + r.interest + r.extra), ...showPmi ? [ r.pmi ] : [], ...showEsc ? [ escrow ] : [], r.balance, ...showLtv ? [ ltv(r.balance) ] : [] ]);
    return {
      head: head,
      rows: rows,
      showPmi: showPmi,
      showEsc: showEsc,
      showPmt: showPmt,
      showLtv: showLtv,
      ltv: ltv
    };
  }
  function drawTable(res) {
    const {input: input, actual: actual, escrow: escrow} = res;
    const {head: head, rows: rows, showPmi: showPmi, showEsc: showEsc, showPmt: showPmt, showLtv: showLtv, ltv: ltv} = scheduleData(res);
    const ltvCol = showLtv ? head.length - 1 : -1;
    const cell = (v, k) => k === ltvCol ? `${v.toFixed(1)}%` : fmt(v);
    const thead = $("table").tHead, tbody = $("table").tBodies[0];
    let html = "";
    if (view === "month") {
      const extraCol = head.indexOf("Extra");
      thead.innerHTML = "<tr>" + head.map(h => `<th>${h}</th>`).join("") + "</tr>";
      rows.forEach((r, i) => {
        const src = actual.rows[i];
        const lump = input.lumps[i] ? ' class="lumpmark"' : "";
        html += `<tr${src.recastTo ? ' class="recast" title="Recast: next payment ' + fmt(src.recastTo) + '"' : ""}><td>${r[0]}</td><td>${r[1]}</td>` + r.slice(2).map((v, k) => `<td${k + 2 === extraCol ? lump : ""}>${cell(v, k + 2)}</td>`).join("") + "</tr>";
      });
    } else {
      const yh = [ "Year", ...showPmt ? [ "P&I payment" ] : [], "Principal", "Interest", "Interest to date", "Extra", "Total to loan", ...showPmi ? [ "PMI" ] : [], ...showEsc ? [ "Tax/Ins/HOA" ] : [], "End balance", ...showLtv ? [ "LTV %" ] : [] ];
      thead.innerHTML = "<tr>" + yh.map(h => `<th>${h}</th>`).join("") + "</tr>";
      const years = new Map;
      actual.rows.forEach((r, i) => {
        const yr = dateFor(input.start, i).y;
        const a = years.get(yr) || {
          p: 0,
          i: 0,
          e: 0,
          pmi: 0,
          esc: 0,
          bal: 0,
          pmt: r.payment
        };
        a.p += r.principal;
        a.i += r.interest;
        a.e += r.extra;
        a.pmi += r.pmi;
        a.esc += escrow;
        a.bal = r.balance;
        a.cum = r.cumInterest;
        years.set(yr, a);
      });
      for (const [yr, a] of years) {
        html += `<tr><td>${yr}</td>` + (showPmt ? `<td>${fmt(a.pmt)}</td>` : "") + `<td>${fmt(a.p)}</td><td>${fmt(a.i)}</td><td>${fmt(a.cum)}</td><td>${fmt(a.e)}</td><td>${fmt(a.p + a.i + a.e)}</td>` + (showPmi ? `<td>${fmt(a.pmi)}</td>` : "") + (showEsc ? `<td>${fmt(a.esc)}</td>` : "") + `<td>${fmt(a.bal)}</td>` + (showLtv ? `<td>${ltv(a.bal).toFixed(1)}%</td>` : "") + "</tr>";
      }
    }
    tbody.innerHTML = html;
  }
  $("csv").onclick = () => {
    const res = results[active];
    if (!usable(res)) return;
    const {head: head, rows: rows} = scheduleData(res);
    const q = s => `"${String(s).replace(/"/g, '""')}"`;
    const csv = [ head.map(q).join(","), ...rows.map(r => [ r[0], q(r[1]), ...r.slice(2).map(v => v.toFixed(2)) ].join(",")) ].join("\n");
    const slug = scenarios[active].name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scenario";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([ csv ], {
      type: "text/csv"
    }));
    a.download = `amortization-${slug}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  function showOnly(i) {
    scenarios.forEach((s, j) => {
      s.hide = j !== i;
    });
  }
  function switchTo(i) {
    formToScenario(scenarios[active]);
    active = i;
    showOnly(i);
    scenarioToForm(scenarios[active]);
    update();
  }
  function addScenario() {
    if (scenarios.length >= MAX_SCENARIOS) return;
    formToScenario(scenarios[active]);
    const copy = JSON.parse(JSON.stringify(scenarios[active]));
    const used = new Set(scenarios.map(s => s.name));
    copy.hide = false;
    copy.name = [ "A", "B", "C", "D", "E" ].map(l => `Scenario ${l}`).find(n => !used.has(n)) || `${copy.name} copy`;
    scenarios.push(copy);
    active = scenarios.length - 1;
    showOnly(active);
    scenarioToForm(copy);
    update();
    $("scenarioName").select();
  }
  $("removeScenario").onclick = () => {
    if (scenarios.length < 2) return;
    scenarios.splice(active, 1);
    active = Math.max(0, active - 1);
    scenarioToForm(scenarios[active]);
    update();
  };
  const b64e = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64d = s => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
  function saveHash() {
    const data = {
      a: active,
      s: scenarios.map(s => ({
        n: s.name,
        v: s.v,
        l: s.lumps.filter(([d, a]) => d && a),
        ...s.hide ? {
          h: 1
        } : {}
      }))
    };
    history.replaceState(null, "", "#s=" + b64e(JSON.stringify(data)));
  }
  function loadHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has("s")) {
      try {
        const data = JSON.parse(b64d(p.get("s")));
        const list = (data.s || []).slice(0, MAX_SCENARIOS).map(o => {
          const s = blankScenario();
          s.name = String(o.n || s.name).slice(0, 40);
          fields.forEach(f => {
            if (o.v && o.v[f] != null) s.v[f] = String(o.v[f]);
          });
          s.lumps = Array.isArray(o.l) ? o.l.map(([d, a, c, k]) => [ String(d), String(a), c == null ? "" : String(c), k === "series" || k === "one" ? k : "" ]) : [];
          s.hide = o.h === 1;
          return s;
        });
        if (list.length) {
          scenarios = list;
          active = Math.min(Math.max(+data.a || 0, 0), list.length - 1);
          return;
        }
      } catch {}
    }
    const s = blankScenario();
    fields.forEach(f => {
      if (p.has(f)) s.v[f] = p.get(f);
    });
    s.lumps = p.getAll("lump").map(x => x.split(":"));
    scenarios = [ s ];
    active = 0;
  }
  $("share").onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("share").textContent = "Copied";
    } catch {
      $("share").textContent = "Copy failed";
    }
    setTimeout(() => {
      $("share").textContent = "Copy link";
    }, 1500);
  };
  function setTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    try {
      if (t === "light" || t === "dark") localStorage.setItem("theme", t); else localStorage.removeItem("theme");
    } catch {}
    document.querySelectorAll("#themeToggle button").forEach(b => b.classList.toggle("on", b.dataset.theme === (t || "auto")));
  }
  document.querySelectorAll("#themeToggle button").forEach(b => b.onclick = () => setTheme(b.dataset.theme));
  setTheme(document.documentElement.dataset.theme || "auto");
  document.querySelectorAll(".seg:not(.theme) button").forEach(b => b.onclick = () => {
    document.querySelectorAll(".seg:not(.theme) button").forEach(o => o.classList.toggle("on", o === b));
    view = b.dataset.view;
    if (usable(results[active])) drawTable(results[active]);
  });
  $("addLump").onclick = () => {
    addLump("", "", "", "one");
    update();
  };
  $("addSeries").onclick = () => {
    addLump("", "", "", "series");
    update();
  };
  $("mode").addEventListener("input", () => {
    const orig = parseAmount($("originalAmount").value), amt = parseAmount($("principal").value);
    if ($("mode").value === "progress") {
      if (!(orig > 0) && amt > 0) $("originalAmount").value = formatMoney(amt);
      $("principal").value = formatMoney("");
    } else if (orig > 0) {
      $("principal").value = formatMoney(orig);
    }
  });
  $("form").addEventListener("input", update);
  $("form").addEventListener("focusin", e => {
    if (isMoney(e.target)) e.target.select();
  });
  $("form").addEventListener("change", e => {
    if (!isMoney(e.target)) return;
    const formatted = formatMoney(e.target.value);
    if (formatted !== e.target.value) {
      e.target.value = formatted;
      update();
    }
  });
  $("form").addEventListener("submit", e => e.preventDefault());
  loadHash();
  scenarioToForm(scenarios[active]);
  update();
}