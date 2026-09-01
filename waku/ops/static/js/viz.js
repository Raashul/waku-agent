// waku-viz — render a model-authored visualization block, the dashboard half
// of waku/viz.py. renderMarkdown() in util.js spots a ```waku-viz fence,
// JSON.parses it, and hands the object here. Malformed blocks never reach this
// file — util.js falls back to a plain code block.
//
// Inline SVG only, same as graph.js / diagram.js: no chart library, no build
// step. Colours are the dashboard's own CSS variables (via style="" so var()
// resolves), so light and dark themes just work. Every string that comes from
// the spec is run through esc() — the model's output is not fully ours.

const VIZ_COLORS = ["var(--accent)", "var(--good)", "var(--bad)", "var(--ink2)"];

// One number, formatted for a human: thousands separators, at most 2 decimals,
// and the spec's unit as a $ prefix or a % / free-text suffix.
function vizFmt(n, unit){
  if (typeof n !== "number" || !isFinite(n)) return esc(String(n));
  const abs = Math.abs(n);
  let body;
  if (abs >= 1e6)      body = (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + "M";
  else if (abs >= 1e4) body = Math.round(n).toLocaleString("en-US");
  else                 body = (Math.round(n * 100) / 100).toString();
  if (unit === "$") return (n < 0 ? "-$" : "$") + body.replace(/^-/, "");
  if (unit === "%") return body + "%";
  return unit ? body + " " + unit : body;
}

function vizFigure(spec, inner){
  const title = spec.title ? `<figcaption class="viz-title">${esc(spec.title)}</figcaption>` : "";
  const cap = spec.caption ? `<div class="viz-caption">${esc(spec.caption)}</div>` : "";
  return `<figure class="viz">${title}<div class="viz-body">${inner}</div>${cap}</figure>`;
}

// Fold the deviations a live model actually produces into the canonical shape:
// `type` for `kind`, and a series `data` of [label, value] pairs instead of a
// top-level `x` plus per-series `points`. Mirrors _normalize in waku/viz.py.
function vizNormalize(spec){
  spec = Object.assign({}, spec);
  if (spec.kind == null && typeof spec.type === "string") spec.kind = spec.type;

  const series = spec.series;
  if (Array.isArray(series) && series.some(s => s && Array.isArray(s.data))){
    let x = Array.isArray(spec.x) ? spec.x : [];
    spec.series = series.map(s => {
      const pairs = s && Array.isArray(s.data)
        ? s.data.filter(p => Array.isArray(p) && p.length === 2) : null;
      if (!pairs) return s;
      if (!x.length) x = pairs.map(p => String(p[0]));
      return { name: s.name, points: pairs.map(p => Number(p[1])) };
    });
    spec.x = x;
  }
  return spec;
}

function renderViz(spec){
  try {
    spec = vizNormalize(spec);
    if (spec.kind === "line" || spec.kind === "bar") return vizFigure(spec, vizChart(spec));
    if (spec.kind === "table") return vizFigure(spec, vizTable(spec));
    if (spec.kind === "stat")  return vizFigure(spec, vizStat(spec));
  } catch (e){
    return `<div class="viz viz-err">couldn't render this ${esc(spec && spec.kind || "chart")}</div>`;
  }
  return "";
}

// ---- line & bar share an axis frame; only the marks differ.
function vizChart(spec){
  const series = spec.series || [];
  const unit = spec.unit || "";
  const n = Math.max(1, ...series.map(s => s.points.length));
  const labels = spec.x && spec.x.length ? spec.x : [];

  const W = 680, H = 260, ml = 54, mr = 14, mb = 30;
  const mt = series.length > 1 ? 34 : 16;
  const plotW = W - ml - mr, plotH = H - mt - mb;

  const all = series.flatMap(s => s.points);
  if (!all.every(v => typeof v === "number" && isFinite(v))) throw new Error("non-numeric point");
  let lo = all.length ? Math.min(...all) : 0;
  let hi = all.length ? Math.max(...all) : 1;
  if (spec.kind === "bar"){ lo = Math.min(0, lo); hi = Math.max(0, hi); }
  if (lo === hi){ lo -= 1; hi += 1; }
  else if (spec.kind === "line"){ const pad = (hi - lo) * 0.06; lo -= pad; hi += pad; }

  const px = i => ml + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const py = v => mt + plotH - ((v - lo) / (hi - lo)) * plotH;

  // horizontal gridlines + y labels
  let grid = "";
  for (let g = 0; g <= 4; g++){
    const v = lo + (g / 4) * (hi - lo);
    const y = py(v).toFixed(1);
    grid += `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" style="stroke:var(--line2)" stroke-width="1"/>`;
    grid += `<text x="${ml - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" class="viz-axis">${esc(vizFmt(v, unit))}</text>`;
  }

  // x labels — at most 6, evenly sampled
  let xlabels = "";
  if (labels.length){
    const step = Math.max(1, Math.ceil(labels.length / 6));
    for (let i = 0; i < labels.length; i += step){
      xlabels += `<text x="${px(i).toFixed(1)}" y="${H - mb + 16}" text-anchor="middle" class="viz-axis">${esc(labels[i])}</text>`;
    }
  }

  let marks = "";
  series.forEach((s, si) => {
    const color = VIZ_COLORS[si % VIZ_COLORS.length];
    if (spec.kind === "line"){
      const pts = s.points.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
      marks += `<polyline points="${pts}" fill="none" style="stroke:${color}" stroke-width="2" stroke-linejoin="round"/>`;
      if (s.points.length <= 24){
        s.points.forEach((v, i) => {
          marks += `<circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="2.5" style="fill:${color}">`
                 + `<title>${esc(s.name)}: ${esc(vizFmt(v, unit))}${labels[i] ? " (" + esc(labels[i]) + ")" : ""}</title></circle>`;
        });
      }
    } else {
      const groupW = plotW / n;
      const barW = Math.max(2, (groupW * 0.7) / series.length);
      const base = py(0);
      s.points.forEach((v, i) => {
        const x = ml + i * groupW + groupW / 2 - (series.length * barW) / 2 + si * barW;
        const y = py(v);
        marks += `<rect x="${x.toFixed(1)}" y="${Math.min(y, base).toFixed(1)}" width="${barW.toFixed(1)}" `
               + `height="${Math.abs(base - y).toFixed(1)}" style="fill:${color}" rx="1">`
               + `<title>${esc(s.name)}: ${esc(vizFmt(v, unit))}${labels[i] ? " (" + esc(labels[i]) + ")" : ""}</title></rect>`;
      });
    }
  });

  let legend = "";
  if (series.length > 1){
    let lx = ml;
    series.forEach((s, si) => {
      const color = VIZ_COLORS[si % VIZ_COLORS.length];
      legend += `<rect x="${lx}" y="14" width="10" height="10" rx="2" style="fill:${color}"/>`
              + `<text x="${lx + 15}" y="23" class="viz-axis">${esc(s.name)}</text>`;
      lx += 22 + s.name.length * 7;
    });
  }

  return `<div class="viz-scroll"><svg viewBox="0 0 ${W} ${H}" class="viz-chart" preserveAspectRatio="xMidYMid meet" role="img">`
       + grid + xlabels + legend + marks + `</svg></div>`;
}

// ---- table: like a markdown table, but numeric columns get right-aligned,
// formatted, and a faint proportional bar behind the value.
function vizTable(spec){
  const cols = spec.columns, rows = spec.rows;
  const numeric = cols.map((_, c) =>
    rows.some(r => typeof r[c] === "number") &&
    rows.every(r => r[c] == null || typeof r[c] === "number"));
  const colMax = cols.map((_, c) =>
    numeric[c] ? Math.max(1e-9, ...rows.map(r => Math.abs(r[c] || 0))) : 0);

  const head = cols.map((h, c) =>
    `<th class="${numeric[c] ? "viz-num" : ""}">${esc(h)}</th>`).join("");
  const body = rows.map(r => "<tr>" + cols.map((_, c) => {
    const v = r[c];
    if (numeric[c] && typeof v === "number"){
      const pct = (Math.abs(v) / colMax[c] * 100).toFixed(1);
      return `<td class="viz-num"><span class="viz-bar" style="width:${pct}%"></span>`
           + `<span class="viz-bar-v">${esc(vizFmt(v))}</span></td>`;
    }
    return `<td>${esc(v == null ? "" : String(v))}</td>`;
  }).join("") + "</tr>").join("");

  return `<div class="viz-scroll"><table class="viz-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---- stat: one big number with an optional coloured delta.
function vizStat(spec){
  const label = spec.label ? `<div class="viz-stat-label">${esc(spec.label)}</div>` : "";
  const trend = spec.trend ? ` viz-trend-${esc(spec.trend)}` : "";
  const delta = spec.delta ? `<div class="viz-stat-delta${trend}">${esc(spec.delta)}</div>` : "";
  return `<div class="viz-stat">${label}<div class="viz-stat-value">${esc(String(spec.value))}</div>${delta}</div>`;
}
