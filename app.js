/* 사진대지 앱 — 업체·직원용. 서버 없이 폰 안에서만 돌아간다(사진은 어디에도 올라가지 않음). */
"use strict";
const APP_VERSION = "1.6.1";
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
const DEFAULT_RATIO = 5293179 / 3743624;

const DATA = {
  lines: [{ name: "1호선", vendor: "", stations: [] }, { name: "2호선", vendor: "", stations: [] }],
  parts: [], positions: [""],
};
const S = { jobs: [], tray: [], seq: 0, sel: null };
let tpl = null, tplInfo = null, out = null, deferredInstall = null;

/* ---------- 저장(IndexedDB): 앱을 닫았다 열어도 작업이 남게 ---------- */
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("sdj-app", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
let saveT = null;
function saveSoon() { clearTimeout(saveT); saveT = setTimeout(() => { idbSet("state", { jobs: S.jobs, tray: S.tray, seq: S.seq }).catch(() => {}); }, 400); }
const uid = () => ++S.seq;

function toast(msg, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }

/* ---------- 이름 만들기 ---------- */
const lineOf = (j) => DATA.lines.find((l) => l.name === j.line) || DATA.lines[0];
const stationOf = (j) => (j.station === "__custom" ? (j.stationCustom || "").trim() : j.station || "");
const placeOf = (j) => [stationOf(j), j.unit ? (j.kind || "") + j.unit : ""].filter(Boolean).join(" ");
const partOf = (j) => (j.part || "").trim();
function workOf(j) {
  const bits = [j.pos, partOf(j), partOf(j) && j.count ? j.count + "개" : ""].filter(Boolean);
  return bits.length ? bits.join(" ") + " 교체" : "";
}
const xjob = (j) => ({ date: j.date, place: placeOf(j), work: workOf(j), status: j.status || "" });
const jobOk = (j) => j.before.length + j.after.length > 0;
const ratioOf = (key) => (tplInfo ? tplInfo[key].ratio : DEFAULT_RATIO);

/* ---------- 사진 들여오기: 크기를 줄이고 똑바로 세워 저장 ---------- */
async function exifDate(file) {
  try {
    const buf = await file.slice(0, 262144).arrayBuffer(); const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return null;
    let o = 2;
    while (o < v.byteLength - 10) {
      const m = v.getUint16(o), len = v.getUint16(o + 2);
      if (m === 0xffe1 && v.getUint32(o + 4) === 0x45786966) {
        const t = o + 10, le = v.getUint16(t) === 0x4949;
        const g16 = (p) => v.getUint16(p, le), g32 = (p) => v.getUint32(p, le);
        const ifd = (off) => {
          const outv = {}, n = g16(t + off);
          for (let i = 0; i < n; i++) {
            const e = t + off + 2 + i * 12, tag = g16(e), type = g16(e + 2), cnt = g32(e + 4);
            if (tag === 0x8769) outv.exif = g32(e + 8);
            if ((tag === 0x9003 || tag === 0x0132) && type === 2) {
              const p = cnt > 4 ? t + g32(e + 8) : e + 8; let s = "";
              for (let k = 0; k < 19 && p + k < v.byteLength; k++) s += String.fromCharCode(v.getUint8(p + k));
              outv[tag] = s;
            }
          }
          return outv;
        };
        const i0 = ifd(g32(t + 4)); let d = i0.exif ? ifd(i0.exif)[0x9003] : null; d = d || i0[0x0132];
        const mm = d && d.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        return mm ? new Date(+mm[1], mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]) : null;
      }
      if ((m & 0xff00) !== 0xff00) break;
      o += 2 + len;
    }
  } catch (e) {}
  return null;
}
async function importFile(file) {
  const exif = await exifDate(file);
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (e) { throw new Error("읽을 수 없는 사진이에요(" + (file.name || "이름 없음") + "). HEIC는 jpg로 바꿔 주세요."); }
  const sc = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h); bmp.close();
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  return { id: uid(), blob, name: file.name || "사진.jpg", w, h, time: (exif || (file.lastModified ? new Date(file.lastModified) : new Date())).getTime(), rot: null, pan: { cx: 0.5, cy: 0.5, z: 1 } };
}
async function importMany(files) {
  const out2 = []; let bad = 0;
  for (const f of files) {
    if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp)$/i.test(f.name || "")) { bad++; continue; }
    try { out2.push(await importFile(f)); } catch (e) { bad++; toast(e.message); }
  }
  if (bad && !out2.length) toast("사진을 읽지 못했어요. jpg·png 사진을 골라 주세요.");
  return out2;
}

/* ---------- 칸에 맞춰 그리기(회전·위치·확대) ---------- */
const decoded = new Map();
async function rotated(p, rot) {
  const key = p.id + "|" + rot;
  if (decoded.has(key)) { const v = decoded.get(key); decoded.delete(key); decoded.set(key, v); return v; }
  const pr = (async () => {
    const bmp = await createImageBitmap(p.blob);
    const w = bmp.width, h = bmp.height, c = document.createElement("canvas");
    if (rot % 180) { c.width = h; c.height = w; } else { c.width = w; c.height = h; }
    const x = c.getContext("2d"); x.translate(c.width / 2, c.height / 2); x.rotate((rot * Math.PI) / 180); x.drawImage(bmp, -w / 2, -h / 2, w, h); bmp.close();
    return c;
  })();
  decoded.set(key, pr);
  while (decoded.size > 8) decoded.delete(decoded.keys().next().value);
  return pr;
}
function effRot(p, target) {
  if (p.rot != null) return p.rot;
  const a = p.w / p.h, d0 = Math.abs(Math.log(a / target)), d90 = Math.abs(Math.log(1 / a / target));
  return d90 + 0.05 < d0 ? 270 : 0;
}
async function drawFill(ctx, p, dx, dy, dw, dh) {
  const rot = effRot(p, dw / dh); p.lastRot = rot;
  const r = await rotated(p, rot), pn = p.pan || (p.pan = { cx: 0.5, cy: 0.5, z: 1 });
  const t = dw / dh; let sw = r.width, sh = r.height;
  if (sw / sh > t) sw = sh * t; else sh = sw / t;
  sw /= pn.z; sh /= pn.z;
  const sx = pn.cx * r.width - sw / 2, sy = pn.cy * r.height - sh / 2;
  const ix0 = Math.max(0, sx), iy0 = Math.max(0, sy), ix1 = Math.min(r.width, sx + sw), iy1 = Math.min(r.height, sy + sh);
  ctx.save(); ctx.fillStyle = "#fff"; ctx.fillRect(dx, dy, dw, dh);
  if (ix1 > ix0 && iy1 > iy0) { const k = dw / sw; ctx.drawImage(r, ix0, iy0, ix1 - ix0, iy1 - iy0, dx + (ix0 - sx) * k, dy + (iy0 - sy) * k, (ix1 - ix0) * k, (iy1 - iy0) * k); }
  ctx.restore();
  return { p, x: dx, y: dy, w: dw, h: dh, perX: sw / dw / r.width, perY: sh / dh / r.height };
}
async function paintSlot(cv, j, key) {
  const W = cv.width, H = cv.height, arr = j[key], x = cv.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  const rects = [];
  if (arr.length >= 2) {
    const g = Math.max(2, Math.round(W * 0.006));
    if (j.layout === "h") { const w1 = Math.floor((W - g) / 2); rects.push(await drawFill(x, arr[0], 0, 0, w1, H), await drawFill(x, arr[1], w1 + g, 0, W - w1 - g, H)); }
    else { const h1 = Math.floor((H - g) / 2); rects.push(await drawFill(x, arr[0], 0, 0, W, h1), await drawFill(x, arr[1], 0, h1 + g, W, H - h1 - g)); }
  } else if (arr.length === 1) rects.push(await drawFill(x, arr[0], 0, 0, W, H));
  return rects;
}
async function slotBytes(j, key) {
  const W = 1600, c = document.createElement("canvas"); c.width = W; c.height = Math.round(W / ratioOf(key));
  await paintSlot(c, j, key);
  const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.88));
  return new Uint8Array(await b.arrayBuffer());
}

/* ---------- 작업 카드 ---------- */
function newJob(from) {
  const last = from || S.jobs[S.jobs.length - 1];
  const lineName = (last && last.line) || localStorage.getItem("sdj-line") || "1호선";
  return {
    id: uid(), date: (last && last.date) || ymd(new Date()), line: lineName, station: (last && last.station) || "", stationCustom: (last && last.stationCustom) || "",
    kind: (last && last.kind) || "ES", unit: "", pos: "", part: "", partSpec: "", count: 1, status: "", layout: "v", before: [], after: [],
  };
}
const unitOptions = (sel) => `<option value="">호기</option>` + Array.from({ length: 40 }, (_, i) => `<option${String(i + 1) === String(sel) ? " selected" : ""}>${i + 1}</option>`).join("");
const stationOptions = (j) => `<option value="">역 선택</option>` + lineOf(j).stations.map((s) => `<option${s === j.station ? " selected" : ""}>${esc(s)}</option>`).join("") + `<option value="__custom"${j.station === "__custom" ? " selected" : ""}>기타(직접 입력)</option>`;
const posOptions = (j) => DATA.positions.map((s) => `<option value="${esc(s)}"${s === j.pos ? " selected" : ""}>${s ? esc(s) : "위치 없음"}</option>`).join("");

function slotHtml(j, key, label) {
  const arr = j[key], has = arr.length > 0, target = S.sel != null;
  const inner = target ? `<span>👆 여기에 넣기</span>` : has ? `<canvas data-cv="${key}"></canvas>` : `<span>＋ 사진 넣기</span><input type="file" accept="image/*" multiple data-pick="${key}" aria-label="${label} 사진 고르기">`;
  return `<div class="slot"><div class="cap">${label}<small>${arr.length ? arr.length + "장" : ""}</small></div>
    <div class="tile${has ? " has" : ""}${target ? " target" : ""}" data-act="tile" data-key="${key}" style="--ratio:${ratioOf(key)}">${inner}</div>
    <div class="slotbtns">
      ${has ? `<button class="btn" data-act="adjust" data-key="${key}">위치</button>` : ""}
      <label class="btn">＋사진<input type="file" accept="image/*" multiple data-pick="${key}" aria-label="${label} 사진 추가"></label>
      <label class="btn" title="바로 촬영">📷<input type="file" accept="image/*" capture="environment" data-pick="${key}" aria-label="${label} 촬영"></label>
      ${has ? `<button class="btn danger" data-act="clearslot" data-key="${key}">비우기</button>` : ""}
    </div></div>`;
}
function jobHtml(j, i) {
  const l = lineOf(j);
  return `<section class="card" data-id="${j.id}">
    <h2>작업 ${i + 1} <span class="sum"></span><button class="link" data-act="dup" title="사진 빼고 그대로 복사">복제</button><button class="link" data-act="del">삭제</button></h2>
    <label class="f">날짜</label>
    <input type="date" data-f="date" value="${j.date.slice(0, 4)}-${j.date.slice(4, 6)}-${j.date.slice(6, 8)}">
    <label class="f">노선</label>
    <div class="seg">${DATA.lines.map((x) => `<button data-act="line" data-v="${esc(x.name)}" class="${x.name === j.line ? "on" : ""}">${esc(x.name)}</button>`).join("")}</div>
    <div class="vendor">${l.vendor ? "담당 업체: " + esc(l.vendor) : ""}</div>
    <label class="f">역</label>
    <select data-f="station">${stationOptions(j)}</select>
    <input type="text" data-f="stationCustom" placeholder="역 이름" value="${esc(j.stationCustom)}" style="margin-top:8px" ${j.station === "__custom" ? "" : "hidden"}>
    <label class="f">호기</label>
    <div class="grid2"><div class="seg">${["EL", "ES"].map((k) => `<button data-act="kind" data-v="${k}" class="${k === j.kind ? "on" : ""}">${k}</button>`).join("")}</div>
    <select data-f="unit" aria-label="호기 번호">${unitOptions(j.unit)}</select></div>
    <label class="f">작업</label>
    <select data-f="pos" aria-label="위치">${posOptions(j)}</select>
    <div class="row" style="margin-top:8px"><input type="text" data-f="part" placeholder="부품명 (예: 가압롤러)" value="${esc(j.part)}" autocomplete="off" style="flex:1;min-width:0"><button class="btn" data-act="findpart" style="flex:none">🔍 부품 찾기</button></div>
    ${j.partSpec ? `<button class="chip" data-act="addspec">규격 붙이기 ＋ (${esc(j.partSpec)})</button>` : ""}
    <div class="grid2" style="margin-top:8px">
      <div class="stepper"><button data-act="cminus" aria-label="개수 줄이기">－</button><span>${j.count}개</span><button data-act="cplus" aria-label="개수 늘리기">＋</button></div>
      <select data-f="status" aria-label="상태"><option value="">교체</option><option${j.status === "수선구매" ? " selected" : ""}>수선구매</option><option${j.status === "중보수" ? " selected" : ""}>중보수</option></select>
    </div>
    <div class="preview"></div>
    <div class="slots">${slotHtml(j, "before", "교체 전")}${slotHtml(j, "after", "교체 후")}</div>
    <div class="warn"></div>
  </section>`;
}
function updateCard(card, j) {
  const place = placeOf(j), work = workOf(j);
  $(".sum", card).textContent = [place, work].filter(Boolean).join(" · ");
  $(".preview", card).innerHTML = `<b>엑셀 장소</b>${esc(place) || "—"}<b style="margin-top:4px">작업명</b>${esc(work) || "—"}<b style="margin-top:4px">파일명</b>${esc(XlsmCore.reportName(xjob(j)))}`;
  const miss = [];
  if (!stationOf(j)) miss.push("역"); if (!j.unit) miss.push("호기"); if (!partOf(j)) miss.push("부품");
  if (!j.before.length) miss.push("교체 전 사진"); if (!j.after.length) miss.push("교체 후 사진");
  $(".warn", card).textContent = miss.length ? "비어 있음: " + miss.join(", ") + " (비워도 만들 수 있어요)" : "";
  $(".stepper span", card).textContent = j.count + "개";
}
let paintTok = 0;
async function paintCards() {
  const tok = ++paintTok;
  for (const cv of document.querySelectorAll("canvas[data-cv]")) {
    const card = cv.closest(".card"), j = S.jobs.find((x) => x.id === +card.dataset.id); if (!j) continue;
    const key = cv.dataset.cv; cv.width = 640; cv.height = Math.round(640 / ratioOf(key));
    try { await paintSlot(cv, j, key); } catch (e) {}
    if (tok !== paintTok) return;
  }
}
let trayUrls = [];
$("#bulkPick").addEventListener("change", async (e) => {
  const files = [...e.target.files]; e.target.value = ""; if (!files.length) return;
  toast(`사진 ${files.length}장 불러오는 중…`, 8000);
  const ph = await importMany(files); S.tray.push(...ph); $("#toast").hidden = true;
  if (ph.length) toast(`사진 ${ph.length}장이 위에 담겼어요. 사진을 누르고 교체 전/후 칸을 누르세요.`, 5000);
  renderJobs();
});
function renderTray() {
  trayUrls.forEach((u) => URL.revokeObjectURL(u)); trayUrls = [];
  const t = $("#tray"); t.hidden = !S.tray.length; if (!S.tray.length) return;
  t.innerHTML = `<div class="t"><b>받은 사진 ${S.tray.length}장</b> — 사진을 누른 뒤 아래 <b>교체 전/후 칸</b>을 누르세요. ${S.sel != null ? '<button class="link" id="trayCancel">선택 취소</button>' : ""}</div><div class="strip">${S.tray.map((p) => { const u = URL.createObjectURL(p.blob); trayUrls.push(u); return `<img src="${u}" data-tray="${p.id}" class="${p.id === S.sel ? "sel" : ""}" alt="받은 사진">`; }).join("")}</div>`;
}
function renderJobs() {
  const box = $("#jobs");
  box.innerHTML = S.jobs.length ? S.jobs.map(jobHtml).join("") : `<div class="empty">아래 <b>＋ 새 작업</b>을 눌러 시작하세요.<br>역·호기·부품을 고르고 교체 전/후 사진을 넣으면 사진대지가 만들어져요.</div>`;
  S.jobs.forEach((j) => updateCard($(`.card[data-id="${j.id}"]`), j));
  $("#cnt").textContent = S.jobs.length ? `${S.jobs.length}건` : "";
  const ready = S.jobs.filter(jobOk).length; $("#make").textContent = ready ? `사진대지 만들기 (${ready}건)` : "사진대지 만들기";
  renderTray(); paintCards(); saveSoon();
}
const jobOfEl = (e) => { const c = e.target.closest(".card"); return c ? { card: c, j: S.jobs.find((x) => x.id === +c.dataset.id) } : {}; };

/* 사진 넣기: 한 칸에는 최대 2장(위아래로 합쳐 한 장처럼) */
function putPhotos(j, key, photos) {
  const room = 2 - j[key].length;
  if (room <= 0) { toast("한 칸에는 사진 2장까지예요. 먼저 '비우기'를 누르세요."); return 0; }
  const take = photos.slice(0, room); j[key].push(...take);
  if (photos.length > take.length) toast(`한 칸에는 2장까지라 ${take.length}장만 넣었어요.`);
  return take.length;
}

const jobsEl = $("#jobs");
jobsEl.addEventListener("change", async (e) => {
  const { card, j } = jobOfEl(e); if (!j) return;
  const t = e.target;
  if (t.dataset.pick) {
    const files = [...t.files]; t.value = ""; if (!files.length) return;
    toast("사진 불러오는 중…", 8000);
    const ph = await importMany(files); if (!ph.length) return;
    putPhotos(j, t.dataset.pick, ph); $("#toast").hidden = true; renderJobs(); return;
  }
  const f = t.dataset.f; if (!f) return;
  if (f === "date") j.date = t.value.replace(/-/g, "");
  else j[f] = t.value;
  if (f === "station") { $(`[data-f="stationCustom"]`, card).hidden = t.value !== "__custom"; }
  updateCard(card, j); saveSoon();
  $("#cnt").textContent = `${S.jobs.length}건`;
});
jobsEl.addEventListener("input", (e) => {
  const { card, j } = jobOfEl(e); if (!j) return;
  const f = e.target.dataset.f; if (f === "stationCustom" || f === "part") { j[f] = e.target.value; if (f === "part") j.partSpec = ""; updateCard(card, j); saveSoon(); }
});
jobsEl.addEventListener("click", (e) => {
  const { card, j } = jobOfEl(e); if (!j) return;
  const b = e.target.closest("[data-act]"); if (!b || e.target.closest("input[type=file]")) return;
  const act = b.dataset.act, key = b.dataset.key;
  if (act === "line") {
    j.line = b.dataset.v; localStorage.setItem("sdj-line", j.line);
    if (j.station !== "__custom" && !lineOf(j).stations.includes(j.station)) j.station = "";
    const keepScroll = scrollY; renderJobs(); scrollTo(0, keepScroll);
  } else if (act === "kind") { j.kind = b.dataset.v; $$seg(b); updateCard(card, j); saveSoon(); }
  else if (act === "cplus") { j.count = Math.min(99, j.count + 1); updateCard(card, j); saveSoon(); }
  else if (act === "cminus") { j.count = Math.max(1, j.count - 1); updateCard(card, j); saveSoon(); }
  else if (act === "del") { if (j.before.length + j.after.length && !b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "정말 삭제?"; setTimeout(() => { b.dataset.sure = ""; b.textContent = "삭제"; }, 3500); return; } S.jobs = S.jobs.filter((x) => x !== j); renderJobs(); }
  else if (act === "dup") { const c = newJob(j); Object.assign(c, { unit: j.unit, pos: j.pos, part: j.part, count: j.count, status: j.status, layout: j.layout }); S.jobs.splice(S.jobs.indexOf(j) + 1, 0, c); renderJobs(); toast("복제했어요. 호기와 사진만 바꾸세요."); }
  else if (act === "findpart") openParts(j);
  else if (act === "addspec") { if (j.partSpec) { j.part = (partOf(j) + " (" + j.partSpec + ")").trim(); j.partSpec = ""; const y = scrollY; renderJobs(); scrollTo(0, y); } }
  else if (act === "clearslot") { j[key] = []; renderJobs(); }
  else if (act === "adjust") openAdjust(j, key);
  else if (act === "tile") {
    if (S.sel == null) return;
    const idx = S.tray.findIndex((p) => p.id === S.sel); if (idx < 0) return;
    if (putPhotos(j, key, [S.tray[idx]])) S.tray.splice(idx, 1);
    S.sel = null; renderJobs();
  }
});
function $$seg(b) { [...b.parentElement.children].forEach((x) => x.classList.toggle("on", x === b)); }
$("#tray").addEventListener("click", (e) => {
  const img = e.target.closest("[data-tray]");
  if (img) { const id = +img.dataset.tray; S.sel = S.sel === id ? null : id; renderJobs(); return; }
  if (e.target.id === "trayCancel") { S.sel = null; renderJobs(); }
});
$("#addJob").onclick = () => { const j = newJob(); S.jobs.push(j); renderJobs(); const c = $(`.card[data-id="${j.id}"]`); c && c.scrollIntoView({ behavior: "smooth", block: "start" }); };

/* ---------- 위치 맞추기 창 ---------- */
let adj = null;
function openAdjust(j, key) {
  adj = { j, key, rects: [], busy: false, again: false };
  $("#adjBox").style.setProperty("--ratio", ratioOf(key));
  $("#adjTitle").textContent = (key === "before" ? "교체 전" : "교체 후") + " 사진 위치 맞추기";
  const cv = $("#adjCv"); cv.width = 1000; cv.height = Math.round(1000 / ratioOf(key));
  $("#adjBack").hidden = false; adjDraw();
}
async function adjDraw() {
  if (!adj) return; if (adj.busy) { adj.again = true; return; }
  adj.busy = true;
  try {
    const cv = $("#adjCv"); adj.rects = await paintSlot(cv, adj.j, adj.key);
    $("#adjBox").querySelectorAll(".pg").forEach((x) => x.remove());
    for (const r of adj.rects) {
      const g = document.createElement("span"); g.className = "pg"; g.dataset.pid = r.p.id;
      g.style.left = (r.x / cv.width) * 100 + "%"; g.style.top = (r.y / cv.height) * 100 + "%";
      g.innerHTML = `<button data-a="rot" aria-label="회전">↻</button><button data-a="in" aria-label="확대">＋</button><button data-a="out" aria-label="축소">－</button>`;
      $("#adjBox").appendChild(g);
    }
  } finally { adj.busy = false; if (adj.again) { adj.again = false; adjDraw(); } }
}
$("#adjBox").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-a]"); if (!b || !adj) return;
  const p = adj.j[adj.key].find((x) => x.id === +b.closest(".pg").dataset.pid); if (!p) return;
  if (b.dataset.a === "rot") { p.rot = (((p.rot == null ? p.lastRot || 0 : p.rot) + 90) % 360); p.pan = { cx: 0.5, cy: 0.5, z: 1 }; }
  else p.pan.z = Math.min(5, Math.max(0.4, p.pan.z * (b.dataset.a === "in" ? 1.15 : 1 / 1.15)));
  adjDraw();
});
(function setupAdjPointer() {
  const cv = $("#adjCv"), ptrs = new Map(); let target = null, lastD = 0;
  const at = (e) => { const b = cv.getBoundingClientRect(), s = cv.width / b.width; return { x: (e.clientX - b.left) * s, y: (e.clientY - b.top) * s }; };
  const hit = (p) => adj && adj.rects.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  cv.addEventListener("pointerdown", (e) => { if (!adj) return; cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, at(e)); if (ptrs.size === 1) target = hit(at(e)); else if (ptrs.size === 2) lastD = dist(); });
  cv.addEventListener("pointermove", (e) => {
    if (!adj || !ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId), cur = at(e); ptrs.set(e.pointerId, cur);
    if (ptrs.size === 1 && target) {
      const pn = target.p.pan; pn.cx = Math.min(1, Math.max(0, pn.cx - (cur.x - prev.x) * target.perX)); pn.cy = Math.min(1, Math.max(0, pn.cy - (cur.y - prev.y) * target.perY)); adjDraw();
    } else if (ptrs.size === 2 && lastD) {
      const d = dist(), [a, b] = [...ptrs.values()], tg = target || hit({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      if (tg) { tg.p.pan.z = Math.min(5, Math.max(0.4, tg.p.pan.z * (d / lastD))); lastD = d; adjDraw(); }
    }
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) lastD = 0; if (!ptrs.size) target = null; };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", (e) => { if (!adj) return; e.preventDefault(); const t = hit(at(e)); if (t) { t.p.pan.z = Math.min(5, Math.max(0.4, t.p.pan.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); adjDraw(); } }, { passive: false });
})();
$("#adjDone").onclick = () => { $("#adjBack").hidden = true; adj = null; renderJobs(); };

/* ---------- 만들기·보내기 ---------- */
const uniqueIn = (set, name) => { let n = name, k = 2; while (set.has(n)) n = name.replace(/(\.\w+)$/, ` (${k++})$1`); set.add(n); return n; };
let making = false;
$("#make").onclick = async () => {
  if (making) return;
  const ready = S.jobs.filter(jobOk);
  if (!ready.length) { toast("교체 전/후 사진을 한 장이라도 넣은 작업이 없어요."); return; }
  if (!tpl) { toast("양식을 아직 불러오지 못했어요. 잠시 뒤 다시 눌러 주세요."); return; }
  making = true; const btn = $("#make"); btn.disabled = true;
  try {
    const zip = new JSZip(), names = new Set(), pn = new Set(), lines = [], parts = [];
    for (let i = 0; i < ready.length; i++) {
      const j = ready[i], xj = xjob(j); btn.textContent = `만드는 중… (${i + 1}/${ready.length})`;
      const name = uniqueIn(names, XlsmCore.reportName(xj));
      const xb = await XlsmCore.buildXlsm(tpl, tplInfo, xj, "before", "after", (k) => slotBytes(j, k));
      zip.file(name, xb);
      const part = { id: uid(), label: name.replace(/\.xlsm$/, ""), files: [{ name, kind: "xlsm", type: "application/vnd.ms-excel.sheet.macroEnabled.12", blob: new Blob([xb]) }] };
      [...j.before, ...j.after].forEach((p, idx) => { const pnm = uniqueIn(pn, XlsmCore.photoName(xj, idx + 1, "jpg")); zip.file("사진/" + pnm, p.blob); part.files.push({ name: pnm, kind: "photo", type: "image/jpeg", blob: p.blob }); });
      parts.push(part);
      lines.push([xj.place, xj.work, xj.status].filter(Boolean).join(" "));
    }
    logHistory(ready).catch(() => {});
    btn.textContent = "압축하는 중…";
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    out = { blob, name: `사진대지_${ymd(new Date())}.zip`, ids: ready.map((j) => j.id), parts, sent: false, text: lines.join("\n") + "\n(사진대지 앱 등록)" };
    $("#outInfo").textContent = `사진대지 ${ready.length}건 + 이름 바꾼 사진이 압축파일 하나에 들어 있어요. (${(blob.size / 1048576).toFixed(1)}MB)`;
    // 안드로이드 크롬은 zip·엑셀 파일 공유를 막는다(사진·pdf 등만 허용) → 압축파일은 저장 후 카톡에서 첨부
    out.photos = ready.flatMap((j) => { const xj = xjob(j), pn2 = new Set(); return [...j.before, ...j.after].map((p, idx) => new File([p.blob], uniqueIn(pn2, XlsmCore.photoName(xj, idx + 1, "jpg")), { type: "image/jpeg" })); });
    $("#outFile").textContent = `'${out.name}'`;
    $("#outShare").hidden = !(navigator.canShare && out.photos.length && navigator.canShare({ files: out.photos }));
    $("#outUp").disabled = false; $("#outUp").textContent = "① 사무실로 올리기";
    $("#outBack").hidden = false;
  } catch (e) { toast("만들지 못했어요: " + (e.message || e)); }
  finally { making = false; btn.disabled = false; renderJobs(); }
};
/* ---------- 사무실로 올리기: 구글 드라이브 '사진대지 수신' 폴더 ---------- */
const UPLOAD_URL = "https://script.google.com/macros/s/AKfycbwk9cwL7_61WV_MBk3ya_Q0VrQRHxEAGdJbUTWTdqFi_mfEJKvQvfmAYjiRDDRwaGZH1Q/exec";
const UPLOAD_KEY = "cD9yxhleOZCoFzlI";
const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
async function sendPart(part) {
  const files = [];
  for (const f of part.files) files.push({ name: f.name, kind: f.kind, type: f.type, b64: await b64(f.blob) });
  const r = await fetch(UPLOAD_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ key: UPLOAD_KEY, files }) });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error((j && j.error) || "서버 응답 " + r.status);
}
let flushing = false;
/* 보낼 목록(outbox)을 차례로 올린다. 인터넷이 끊기면 남겨 두고 다음에 다시 */
async function flushOutbox(show) {
  if (flushing) return; flushing = true;
  let ok = 0, left = 0, err = "";
  try {
    let box = (await idbGet("outbox").catch(() => null)) || [];
    while (box.length) {
      try { await sendPart(box[0]); ok++; box = box.slice(1); await idbSet("outbox", box); if (show) show(ok, box.length); }
      catch (e) { err = e.message || String(e); break; }
    }
    left = box.length;
  } finally { flushing = false; }
  return { ok, left, err };
}
$("#outUp").onclick = async () => {
  if (!out || out.sent) return; const b = $("#outUp"); b.disabled = true;
  try {
    const box = (await idbGet("outbox").catch(() => null)) || [];
    await idbSet("outbox", box.concat(out.parts)); out.sent = true;
    b.textContent = "올리는 중…";
    const r = await flushOutbox((n, l) => (b.textContent = `올리는 중… (${l}건 남음)`));
    if (!r.left) { b.textContent = "✓ 사무실로 올렸어요"; toast(`사진대지 ${r.ok}건을 사무실로 올렸어요.`, 4000); }
    else { b.textContent = `${r.left}건 대기 중 — 인터넷 되면 자동으로 올라가요`; toast(`아직 못 올린 ${r.left}건은 폰에 보관했다가 인터넷이 되면 자동으로 올려요.\n(${r.err})`, 7000); }
  } catch (e) { b.disabled = false; toast("올리지 못했어요: " + (e.message || e), 6000); }
};
async function autoFlush() {
  const box = (await idbGet("outbox").catch(() => null)) || []; if (!box.length || !navigator.onLine) return;
  const r = await flushOutbox(); if (r && r.ok) toast(`대기 중이던 사진대지 ${r.ok}건을 사무실로 올렸어요.${r.left ? ` (${r.left}건 남음)` : ""}`, 5000);
}
window.addEventListener("online", autoFlush);
$("#outShare").onclick = () => {
  if (!out || !out.photos) return;
  navigator.share({ files: out.photos }).catch((e) => { if (e.name !== "AbortError") toast("보내지 못했어요 (" + e.name + ": " + e.message + ")", 6000); });
};
$("#outSave").onclick = () => {
  if (!out) return; const a = document.createElement("a"); a.href = URL.createObjectURL(out.blob); a.download = out.name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); toast("저장했어요. 이제 카톡 대화방 ＋ → 파일 → 다운로드에서 보내세요.", 5000);
};
$("#outCopy").onclick = async () => { try { await navigator.clipboard.writeText(out.text); toast("복사했어요. 단톡방에 붙여넣으세요."); } catch (e) { toast("복사하지 못했어요."); } };
$("#outClear").onclick = (e) => {
  const b = e.currentTarget; if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "정말 지울까요? 한 번 더 누르세요"; setTimeout(() => { b.dataset.sure = ""; b.textContent = "보낸 작업 지우기"; }, 4000); return; }
  b.dataset.sure = ""; b.textContent = "보낸 작업 지우기";
  if (out) S.jobs = S.jobs.filter((j) => !out.ids.includes(j.id)); $("#outBack").hidden = true; renderJobs();
};
$("#outClear").textContent = "보낸 작업 지우기";
$("#outClose").onclick = () => ($("#outBack").hidden = true);

/* ---------- 메뉴 ---------- */
$("#menuBtn").onclick = () => { $("#mInfo").textContent = `버전 ${APP_VERSION} · 사진은 이 폰 안에만 있고 어디에도 올라가지 않아요.`; $("#mInstall").hidden = !deferredInstall; $("#menuBack").hidden = false; };
$("#mUpdate").onclick = async () => { try { (await navigator.serviceWorker.getRegistrations()).forEach((r) => r.unregister()); (await caches.keys()).filter((k) => k.startsWith("sdj-v")).forEach((k) => caches.delete(k)); } catch (e) {} location.reload(); };
$("#menuClose").onclick = () => ($("#menuBack").hidden = true);
function twoTap(btn, label, fn) { btn.onclick = () => { if (!btn.dataset.sure) { btn.dataset.sure = "1"; btn.textContent = "정말요? 한 번 더 누르세요"; setTimeout(() => { btn.dataset.sure = ""; btn.textContent = label; }, 3500); return; } btn.dataset.sure = ""; btn.textContent = label; fn(); $("#menuBack").hidden = true; }; }
twoTap($("#mPhotos"), "모든 작업의 사진 비우기", () => { S.jobs.forEach((j) => { j.before = []; j.after = []; }); S.tray = []; S.sel = null; renderJobs(); });
twoTap($("#mAll"), "작업 전부 지우기", () => { S.jobs = []; S.tray = []; S.sel = null; renderJobs(); });
$("#mInstall").onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch (e) {} deferredInstall = null; $("#menuBack").hidden = true; };
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; });
[["adjBack", "adjDone"], ["outBack", "outClose"], ["menuBack", "menuClose"]].forEach(([back, btn]) => $("#" + back).addEventListener("click", (e) => { if (e.target.id === back) $("#" + btn).click(); }));

/* ---------- 공유 메뉴로 받은 사진 ---------- */
async function intakeShared() {
  try {
    const cache = await caches.open("sdj-shared"), reqs = await cache.keys(); if (!reqs.length) return;
    const files = [];
    for (const r of reqs) { const res = await cache.match(r); const blob = await res.blob(); files.push(new File([blob], decodeURIComponent(res.headers.get("X-Name") || "공유 사진.jpg"), { type: blob.type || "image/jpeg", lastModified: +res.headers.get("X-Time") || Date.now() })); await cache.delete(r); }
    toast(`받은 사진 ${files.length}장 불러오는 중…`, 8000);
    const ph = await importMany(files); S.tray.push(...ph); $("#toast").hidden = true;
    if (ph.length) toast(`받은 사진 ${ph.length}장이 위에 있어요. 사진을 누르고 교체 전/후 칸을 누르세요.`, 5000);
    renderJobs();
  } catch (e) {}
}


/* ---------- 부품 찾기: 자재 목록에서 초성·글자로 검색 ---------- */
let PARTS = [];
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const choOf = (c) => { const k = c.charCodeAt(0) - 0xac00; return k >= 0 && k < 11172 ? CHO[Math.floor(k / 588)] : c; };
const isCho = (c) => c >= "ㄱ" && c <= "ㅎ";
/* 검색어(q)가 text 안에 들어 있나 — 검색어의 자음은 그 자음으로 시작하는 글자와 맞춘다 */
function hasText(text, q) {
  for (let i = 0; i + q.length <= text.length; i++) {
    let ok = true;
    for (let j = 0; j < q.length; j++) { const a = q[j], b = text[i + j]; if (a === b || (isCho(a) && choOf(b) === a)) continue; ok = false; break; }
    if (ok) return true;
  }
  return false;
}
function searchParts(raw) {
  const q = raw.toLowerCase().replace(/\s/g, ""); if (!q) return [];
  const hits = [];
  for (const p of PARTS) {
    let score = 0;
    if (p.nk.toLowerCase().startsWith(q) || (isCho(q[0]) && hasText(p.nk.slice(0, q.length), q))) score = 3;
    else if (hasText(p.nk.toLowerCase(), q)) score = 2;
    else if (hasText(p.k, q)) score = 1;
    if (score) hits.push([score, p]);
  }
  hits.sort((a, b) => b[0] - a[0] || a[1].n.localeCompare(b[1].n, "ko") || a[1].sp.localeCompare(b[1].sp, "ko"));
  return hits.map((h) => h[1]);
}
const recents = () => { try { return JSON.parse(localStorage.getItem("sdj-recent") || "[]"); } catch (e) { return []; } };
let partJob = null;
function openParts(j) {
  partJob = j; $("#partQ").value = ""; renderParts(); $("#partBack").hidden = false;
  setTimeout(() => $("#partQ").focus(), 50);
}
function renderParts() {
  const q = $("#partQ").value.trim(), box = $("#partList");
  let list, head = "";
  if (!PARTS.length) { box.innerHTML = `<div class="note" style="padding:10px">자재 목록을 불러오지 못했어요. 아래에 직접 쓰고 사용 버튼을 누르세요.</div>`; list = []; }
  else if (q) { list = searchParts(q); head = list.length ? `<div class="note" style="padding:4px 2px">${list.length > 60 ? "60개만 보여요. 더 입력해 좁혀 보세요." : list.length + "개"}</div>` : `<div class="note" style="padding:10px">맞는 부품이 없어요. 아래 '이 글자로 쓰기'를 누르세요.</div>`; list = list.slice(0, 60); }
  else { list = recents().map(([n, sp]) => PARTS.find((p) => p.n === n && p.sp === sp)).filter(Boolean); head = `<div class="note" style="padding:4px 2px">${list.length ? "최근 쓴 부품" : "부품 이름이나 초성을 입력하세요. 예) ㄱㅇㄷㄹㄹ → 가이드롤러"}</div>`; }
  box.innerHTML = head + list.map((p) => `<button class="pitem" data-n="${esc(p.n)}" data-sp="${esc(p.sp)}"><b>${esc(p.n)}</b><small>${esc(p.sp)}${p.o !== p.n ? " · 자재명 " + esc(p.o) : ""}</small></button>`).join("");
  $("#partUse").hidden = !q; $("#partUse").textContent = `'${q}' 이 글자로 쓰기`;
}
$("#partQ").addEventListener("input", renderParts);
$("#partList").addEventListener("click", (e) => {
  const b = e.target.closest(".pitem"); if (!b || !partJob) return;
  const n = b.dataset.n, sp = b.dataset.sp;
  const r = recents().filter(([a, c]) => !(a === n && c === sp)); r.unshift([n, sp]);
  try { localStorage.setItem("sdj-recent", JSON.stringify(r.slice(0, 10))); } catch (e2) {}
  partJob.part = n; partJob.partSpec = sp; closeParts();
});
$("#partUse").onclick = () => { if (!partJob) return; partJob.part = $("#partQ").value.trim(); partJob.partSpec = ""; closeParts(); };
function closeParts() { $("#partBack").hidden = true; partJob = null; const y = scrollY; renderJobs(); scrollTo(0, y); }
$("#partClose").onclick = () => { $("#partBack").hidden = true; partJob = null; };
$("#partBack").addEventListener("click", (e) => { if (e.target.id === "partBack") $("#partClose").click(); });

/* ---------- 교체 이력 조회 (이 폰에 쌓인 기록 기준) ---------- */
const todayYmd = () => ymd(new Date());
async function logHistory(ready) {
  const hist = (await idbGet("history").catch(() => null)) || [];
  const now = Date.now();
  ready.forEach((j) => {
    hist.push({
      ts: now,
      date: /^\d{8}$/.test(j.date || "") ? j.date : todayYmd(),
      line: j.line || "", station: stationOf(j), kind: j.kind || "", unit: j.unit || "",
      part: partOf(j), count: j.count || 1, status: j.status || "",
    });
  });
  // 최근 3000건만 보관
  await idbSet("history", hist.slice(-3000)).catch(() => {});
}
function periodStart(p) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (p === "today") return d.getTime();
  if (p === "week") { const w = (d.getDay() + 6) % 7; d.setDate(d.getDate() - w); return d.getTime(); } // 월요일 시작
  if (p === "month") { d.setDate(1); return d.getTime(); }
  return 0; // all
}
function histDateMs(r) {
  const s = r.date || "";
  if (/^\d{8}$/.test(s)) return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getTime();
  return r.ts || 0;
}
let histState = { period: "month", q: "" };
async function renderHist() {
  const all = (await idbGet("history").catch(() => null)) || [];
  const start = periodStart(histState.period);
  const q = histState.q.trim().toLowerCase();
  let rows = all.filter((r) => histDateMs(r) >= start);
  if (q) rows = rows.filter((r) => [r.station, (r.kind || "") + (r.unit || ""), r.part, r.status].join(" ").toLowerCase().includes(q));
  rows.sort((a, b) => histDateMs(b) - histDateMs(a) || b.ts - a.ts);

  const sum = $("#histSum"), list = $("#histList");
  if (!all.length) { sum.innerHTML = '<div class="empty">아직 기록이 없어요<br>사진대지를 만들면 역·호기·부품·개수가 한 건씩 쌓여요.</div>'; list.innerHTML = ""; return; }
  if (!rows.length) { sum.innerHTML = '<div class="empty">해당 조건에 기록이 없어요<br>기간이나 검색어를 바꿔 보세요.</div>'; list.innerHTML = ""; return; }
  const total = rows.reduce((n, r) => n + (+r.count || 1), 0);
  const by = (key) => { const m = new Map(); rows.forEach((r) => { const k = key(r) || "(미입력)"; m.set(k, (m.get(k) || 0) + (+r.count || 1)); }); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const bars = (arr) => { const mx = arr[0] ? arr[0][1] : 1; return arr.slice(0, 6).map(([k, n]) => `<div class="brow"><span>${esc(k)}</span><i style="width:${Math.max(6, Math.round((n / mx) * 100))}%"></i><em>${n}</em></div>`).join(""); };
  sum.innerHTML =
    `<div class="big"><div><b>${rows.length}</b><small>작업 건</small></div><div><b>${total}</b><small>부품 개수</small></div></div>` +
    `<div class="bars"><h4>역사별</h4>${bars(by((r) => r.station))}</div>` +
    `<div class="bars"><h4>부품별</h4>${bars(by((r) => r.part))}</div>`;
  list.innerHTML = rows.map((r) => {
    const d = r.date && /^\d{8}$/.test(r.date) ? `${r.date.slice(4, 6)}/${r.date.slice(6, 8)}` : "";
    const place = [r.station, r.unit ? (r.kind || "") + r.unit : ""].filter(Boolean).join(" ");
    const work = [r.part, (+r.count ? r.count + "개" : "")].filter(Boolean).join(" ");
    return `<div class="hrow2"><div><b>${esc(place || "(역 미입력)")}</b><small>${esc(work)}${r.status ? " · " + esc(r.status) : ""}</small></div><span class="hwhen">${d}</span></div>`;
  }).join("");
}
$("#histPeriod").addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (!b) return; histState.period = b.dataset.p; [...$("#histPeriod").children].forEach((x) => x.classList.toggle("on", x === b)); renderHist(); });
$("#histQ").addEventListener("input", (e) => { histState.q = e.target.value; renderHist(); });


/* ---------- 탭 ---------- */
const TABS = ["home", "plan", "stock", "stat", "photo"];
const TITLES = { home: "승강업무", plan: "일정", stock: "창고 재고", stat: "현황", photo: "사진대지" };
const pgOf = (k) => $("#pg" + k[0].toUpperCase() + k.slice(1));
let curTab = "home", statSeg = "acc";
function showTab(t) {
  curTab = t;
  TABS.forEach((k) => { pgOf(k).hidden = k !== t; });
  [...$("#tabs").children].forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  $("#ttl").textContent = TITLES[t]; $("#actBar").hidden = t !== "photo"; $("#cnt").hidden = t !== "photo";
  if (t === "photo") renderJobs();
  if (t === "home") renderHome();
  if (t === "plan") renderPlan();
  if (t === "stock") renderStock();
  if (t === "stat") renderStat();
  scrollTo(0, 0);
  try { localStorage.setItem("sdj-tab", t); } catch (e) {}
}
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-t]"); if (b) showTab(b.dataset.t); });

/* ---------- 데이터 읽는 곳 (나중에 사내 서버로 바뀌면 여기만 고치면 됨) ---------- */
const dataCache = {};
async function loadData(name) { if (dataCache[name]) return dataCache[name]; const r = await fetch("data/" + name + ".json", { cache: "no-cache" }); if (!r.ok) throw new Error(name); return (dataCache[name] = await r.json()); }
async function getPlan() {
  let st = null; try { st = await idbGet("plan"); } catch (e) {}
  if (st && st.items && st.items.length) return { items: st.items, demo: false };
  const d = await loadData("sample").catch(() => ({})); return { items: d.plan || [], demo: true };
}
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
function itemDate(it) { if (it.date) { const [y, m, d] = it.date.split("-").map(Number); return new Date(y, m - 1, d); } const d = today0(); d.setDate(d.getDate() + (it.off || 0)); return d; }
const WD = "일월화수목금토";
const dLabel = (d) => `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
const telHref = (t) => "tel:" + String(t || "").replace(/[^\d+]/g, "");
const chipsHtml = (list, cur) => list.map(([v, l]) => `<button data-f="${v}"${v === cur ? ' class="on"' : ""}>${l}</button>`).join("");
const stnHtml = (t) => esc(t).replace(/([가-힣A-Za-z0-9]+?)(\([^)]*\))/g, "<b>$1</b><i>$2</i>");
const CATS = ["점검", "검사", "중보수", "수선"];
const catCls = { "점검": "c1", "검사": "c2", "중보수": "c3", "수선": "c3" };
const lineCls = { "1호선": "l1", "2호선": "l2" };
const itemHtml = (it) => `<div class="item"><div><span class="cat ${catCls[it.cat] || "c1"}">${esc(it.cat)}</span>${it.line ? `<span class="lt ${lineCls[it.line] || ""}"></span><small class="sub2">${esc(it.line)} ${esc(it.kind || "")}</small>` : ""}</div><div class="stn" style="margin-top:5px;font-size:15px;line-height:1.5">${stnHtml(it.text)}</div></div>`;


/* ---------- 비상연락망(업체) · 오늘 당직 지정 ---------- */
let dutyMode = null;
async function getContacts() {
  let st = null; try { st = await idbGet("contacts"); } catch (e) {}
  if (st && st.data) return { data: st.data, demo: false };
  const d = await loadData("sample").catch(() => ({})); return { data: (d.work && d.work.vendor) || {}, demo: true };
}
const todayKey = () => { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
async function getRosterAll() { try { const s = await idbGet("roster"); return (s && s.map) || {}; } catch (e) { return {}; } }
async function getDuty() { const m = await getRosterAll(), e = m[todayKey()] || {}; return { duty: e.duty || [], off: e.off || [], has: !!m[todayKey()] }; }
async function toggleDuty(key) {
  const m = await getRosterAll(), k = todayKey(), e = m[k] || { duty: [], off: [] };
  const duty = new Set(e.duty), off = new Set(e.off);
  if (duty.has(key)) duty.delete(key); else { duty.add(key); off.delete(key); }
  m[k] = { duty: [...duty], off: [...off] }; await idbSet("roster", { map: m, ts: Date.now() });
}
const telNorm = (t) => { const d = String(t).replace(/\D/g, ""); return d.length === 11 ? d.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3") : d.length === 10 ? d.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3") : String(t); };
function parseContacts(grids) {
  const res = {}, blocks = [];
  grids.forEach(({ grid }) => {
    [...grid.keys()].sort((a, b) => a - b).forEach((r) => {
      const row = grid.get(r);
      [...row.entries()].filter(([c, v]) => v.replace(/\s/g, "") === "성명").forEach(([c]) => {
        const right = [...row.entries()].filter(([cc]) => cc > c).sort((a, b) => a[0] - b[0]);
        const rc = (right.find(([, v]) => v.replace(/\s/g, "") === "직급") || [])[0];
        const tc = (right.find(([cc, v]) => /^(HP|H\.P|핸드폰|휴대폰|연락처|전화)/i.test(v.replace(/\s/g, "")) && (!rc || cc > rc)) || [])[0];
        if (!tc) return; blocks.push({ grid, r, nc: c, rc, tc });
      });
    });
  });
  blocks.sort((a, b) => a.r - b.r || a.nc - b.nc);
  blocks.forEach((b, i) => {
    let line = null, inn = "", gen = "";
    for (let r = b.r - 1; r >= Math.max(1, b.r - 6); r--) {
      const row = b.grid.get(r); if (!row) continue;
      row.forEach((v, c) => {
        if (c < b.nc - 2 || c > b.tc + 1) return;
        const m = /([12])\s*호선/.exec(v); if (m && !line) line = m[1] + "호선";
        const L = v.replace(/\s/g, "");
        const nextVal = () => { const rr = [...row.entries()].filter(([cc]) => cc > c).sort((a, b2) => a[0] - b2[0])[0]; return rr ? rr[1] : ""; };
        if (/^사내전화/.test(L) && !inn) inn = nextVal();
        if (/^일반전화/.test(L) && !gen) gen = nextVal();
      });
    }
    line = line || (i === 0 ? "1호선" : "2호선"); if (res[line]) return;
    const people = []; let miss = 0;
    const last = Math.max(...b.grid.keys());
    for (let r = b.r + 1; r <= last; r++) {
      const row = b.grid.get(r) || new Map(), name = (row.get(b.nc) || "").trim(), tel = (row.get(b.tc) || "").trim();
      if (!name || !/\d{3,4}[-\s]?\d{4}/.test(tel)) { if (++miss >= 3) break; continue; } miss = 0;
      if (/^(성명|NO)$/i.test(name)) break;
      people.push({ name, role: b.rc ? (row.get(b.rc) || "").trim() : "", tel: telNorm(tel) });
    }
    if (people.length) res[line] = { co: "", in: inn, gen: gen, people };
  });
  if (!Object.keys(res).length) throw new Error("비상연락망 모양을 찾지 못했어요 (성명·직급·HP 칸이 필요해요)");
  return res;
}

/* ---------- 홈 ---------- */
const callIc = '<svg class="ic" viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z"/></svg>';
async function renderHome() {
  const [d, pl] = await Promise.all([loadData("sample").catch(() => null), getPlan()]);
  if (!d) { $("#hWork").innerHTML = '<div class="empty">데이터를 불러오지 못했어요</div>'; return; }
  const t0 = today0().getTime();
  const todays = pl.items.filter((it) => itemDate(it).getTime() === t0).sort((a, b) => CATS.indexOf(a.cat) - CATS.indexOf(b.cat));
  const openAcc = (d.acc || []).filter((a) => !a.done).length, lng = (d.longrepair || []).length;
  $("#hTiles").innerHTML =
    `<button class="tile2" data-go="plan"><b>${todays.length}</b><small>오늘 작업</small></button>` +
    `<button class="tile2${openAcc ? " warn2" : ""}" data-go="stat" data-seg="acc"><b>${openAcc}</b><small>처리 중 사고</small></button>` +
    `<button class="tile2${lng ? " warn2" : ""}" data-go="stat" data-seg="long"><b>${lng}</b><small>장기 미수선</small></button>`;
  const ct = await getContacts(), duty = await getDuty();
  const cell = (p) => `<a class="pc" href="${esc(telHref(p.tel))}"><span>${esc(p.name)}${p.role ? `<small class="rk">${esc(p.role)}</small>` : ""}</span>${callIc}</a>`;
  const body = (arr) => (arr && arr.length ? arr.map(cell).join("") : '<div class="empty1">없음</div>');
  const cls = { "통상": "l0", "1호선": "l1", "2호선": "l2" };
  const dutyCell = (k, p, on) => `<button class="pc dpick${on ? " on" : ""}" data-k="${k}|${esc(p.name)}"><span>${esc(p.name)}${p.role ? `<small class="rk">${esc(p.role)}</small>` : ""}</span><em>${on ? "당직 ✓" : "당직"}</em></button>`;
  const venCol = (k) => {
    const v = ct.data[k] || {}, ppl = v.people || [], dset = new Set(duty.duty), oset = new Set(duty.off);
    const isD = (p) => dset.has(k + "|" + p.name), isO = (p) => oset.has(k + "|" + p.name) && !isD(p);
    const dayP = ppl.filter((p) => !isD(p) && !isO(p)), dutyP = ppl.filter(isD), offP = ppl.filter(isO);
    const nums = `<div class="nums">${v.in ? `<span>사내 ${esc(v.in)}</span>` : ""}${v.gen ? `<a href="${esc(telHref(v.gen))}">일반 ${esc(v.gen)}</a>` : ""}</div>`;
    const inner = dutyMode === k
      ? `<div class="sub duty">눌러서 오늘 당직 지정</div>${ppl.map((p) => dutyCell(k, p, isD(p))).join("")}`
      : `<div class="sub">주간 ${dayP.length}명</div>${body(dayP)}<div class="sub duty">당직 ${dutyP.length}명</div>${body(dutyP)}` + (offP.length ? `<div class="sub off">휴무 ${offP.length}명</div><div class="offlist">${offP.map(cell).join("")}</div>` : "");
    return `<div class="col ${cls[k]}"><div class="ch">${k} · ${esc(v.co || "")}</div>${nums}<div class="cb">${inner}</div><button class="link dmode" data-m="${k}">${dutyMode === k ? "지정 끝내기" : "오늘 당직 지정"}</button></div>`;
  };
  const w = d.work || {}, st = w.staff || {};
  $("#hWork").innerHTML =
    '<div class="grp"><h3>승강관리소 직원</h3><div class="cols c3">' +
    ["통상", "1호선", "2호선"].map((k) => `<div class="col ${cls[k]}"><div class="ch">${k === "통상" ? "통상" : k + " 담당"}</div><div class="cb">${body(st[k])}</div></div>`).join("") +
    `</div></div><div class="grp"><h3>승강업체 비상연락망${ct.demo ? "" : ""}</h3><div class="cols c2">` + ["1호선", "2호선"].map(venCol).join("") +
    `</div><div class="planbar" style="margin-top:8px"><label class="btn">비상연락망 불러오기(엑셀)<input type="file" accept=".xlsx,.xlsm,.json,application/json" id="ctFile"></label>${ct.demo ? "" : '<button class="link" id="ctClear">지우기</button>'}</div>${ct.demo ? "" : `<div class="planbar"><label class="btn">업체 근무표 불러오기(엑셀)<input type="file" accept=".xlsx,.xlsm" id="rsFile"></label>${duty.has ? '<small class="note">오늘 근무 반영됨</small>' : '<small class="note">오늘 근무표 없음</small>'}</div>`}</div>`;
  $("#hPlan").innerHTML = `<div class="sec"><h2>오늘 작업 · ${dLabel(new Date())}</h2></div>` + (todays.map(itemHtml).join("") || '<div class="empty">오늘 작업이 없어요</div>');
  $("#hAcc").innerHTML = '<div class="sec"><h2>최근 사고</h2></div>' + (d.acc || []).slice(0, 3).map(accHtml).join("");
}

/* 업체 근무표(엑셀) → 날짜별 당직·휴무. 이름 칸이면 '당/휴' 같은 표시를, 주간/당직 칸이면 적힌 이름을 읽음 */
function parseRoster(grids, fname, contacts) {
  const people = []; Object.entries(contacts).forEach(([ln, v]) => (v.people || []).forEach((p) => people.push({ key: ln + "|" + p.name, name: p.name })));
  const clean = (t) => String(t).replace(/\([^)]*\)/g, "").replace(/[\d\s]/g, "");
  const exact = (t) => { const c = clean(t); return c ? people.find((p) => p.name === c) : null; };
  const loose = (t) => { const c = clean(t); return c ? people.find((p) => p.name === c) || people.find((p) => c.includes(p.name)) : null; };
  const cls = (v) => { const x = String(v).replace(/\s/g, ""); if (!x) return "day"; if (/당|야간|숙직/.test(x)) return "duty"; if (/^(휴|연|비|대휴|OFF|off|결|병|공가|[-–—])/i.test(x)) return "off"; return "day"; };
  const out = {}; let matched = 0;
  grids.forEach(({ grid, merges }) => {
    let base = null;
    grid.forEach((cols) => cols.forEach((v) => { const m = /(20\d\d)\s*년\s*(\d{1,2})\s*월/.exec(v); if (m && !base) base = { y: +m[1], m: +m[2] }; }));
    if (!base) { const m = /(20\d\d)\D{0,3}(\d{1,2})/.exec(fname || ""); if (m && +m[2] >= 1 && +m[2] <= 12) base = { y: +m[1], m: +m[2] }; }
    const rows = [...grid.keys()].sort((a, b) => a - b), heads = [];
    rows.forEach((r) => {
      const cs = [...grid.get(r).entries()].filter(([c, v]) => /^\d{1,2}$/.test(v) && +v >= 1 && +v <= 31).sort((a, b) => a[0] - b[0]);
      let best = [], cur = [];
      cs.forEach(([c, v]) => { const prev = cur.length ? +cur[cur.length - 1][1] : null; if (prev !== null && (+v === prev + 1 || (+v === 1 && prev >= 28))) cur.push([c, v]); else cur = [[c, v]]; if (cur.length > best.length) best = cur.slice(); });
      if (best.length >= 5) heads.push({ r, days: best.map(([c, v]) => { const mg = merges.find((m) => m.r1 === r && m.c1 === c); return { day: +v, c0: c, c1: mg ? mg.c2 : c }; }) });
    });
    if (!heads.length) return;
    if (!base) { const m = /(\d{4})[-_.]?(\d{1,2})/.exec(fname || ""); const ans = prompt("몇 월 근무표인가요? (예: 2026-11)", m ? m[1] + "-" + m[2] : ""); const mm = /(20\d\d)\D+(\d{1,2})/.exec(ans || ""); if (!mm) throw new Error("몇 월인지 알 수 없어요"); base = { y: +mm[1], m: +mm[2] }; }
    let curM = heads[0].days[0].day > 20 ? base.m - 1 : base.m, prevDay = 0;
    const dcs = heads.map((h) => h.days.map((d) => { if (d.day < prevDay) curM++; prevDay = d.day; const dt = new Date(base.y, curM - 1, d.day); return { ...d, date: dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate()) }; }));
    const slot = (date) => out[date] || (out[date] = { duty: new Set(), off: new Set(), seen: new Set() });
    heads.forEach((h, hi) => {
      const end = hi + 1 < heads.length ? heads[hi + 1].r : rows[rows.length - 1] + 1, first = h.days[0].c0;
      for (let r = h.r + 1; r < end; r++) {
        const row = grid.get(r); if (!row) continue;
        const lefts = [...row.entries()].filter(([c]) => c < first).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        const who = lefts.map(exact).find(Boolean) || lefts.map(loose).find(Boolean);
        const kind = lefts.map((v) => v.replace(/\s/g, "")).map((x) => (/^(당직|숙직|야간)/.test(x) ? "duty" : /^(휴무|휴가|비번)/.test(x) ? "off" : /^주간/.test(x) ? "day" : "")).find(Boolean);
        row.forEach((v, c) => {
          if (c < first) return; const dc = dcs[hi].find((d) => c >= d.c0 && c <= d.c1); if (!dc) return;
          if (who) { const e = slot(dc.date), t = cls(v); matched++; e.seen.add(who.key); if (t === "duty") e.duty.add(who.key); else if (t === "off") e.off.add(who.key); }
          else if (kind) { const toks = String(v).split(/[,，/·\n]+|\s+/).filter(Boolean); toks.forEach((tk) => { const pp = exact(tk); if (!pp) return; matched++; const e = slot(dc.date); e.seen.add(pp.key); if (kind === "duty") e.duty.add(pp.key); else if (kind === "off") e.off.add(pp.key); }); }
        });
      }
    });
  });
  if (!matched) throw new Error("연락망에 있는 이름을 근무표에서 찾지 못했어요 (비상연락망을 먼저 불러왔는지, 근무표에 이름이 있는지 확인)");
  const map = {}; Object.entries(out).forEach(([d, e]) => { map[d] = { duty: [...e.duty], off: [...e.off] }; });
  return map;
}
document.addEventListener("change", async (e) => {
  if (e.target.id !== "rsFile") return;
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const ct = await getContacts(); if (ct.demo) throw new Error("비상연락망을 먼저 불러와 주세요");
    const map = parseRoster(await loadGrids(await f.arrayBuffer()), f.name, ct.data);
    const all = await getRosterAll(); const ds = Object.keys(map).sort();
    await idbSet("roster", { map: { ...all, ...map }, ts: Date.now() });
    toast(`${ds.length}일치 근무표 반영 (${ds[0].slice(5)} ~ ${ds[ds.length - 1].slice(5)})`, 4500); renderHome();
  } catch (err) { toast("불러오지 못했어요: " + err.message, 6000); }
});

document.addEventListener("click", async (e) => {
  const m = e.target.closest(".dmode"); if (m) { dutyMode = dutyMode === m.dataset.m ? null : m.dataset.m; return renderHome(); }
  const dp = e.target.closest(".dpick"); if (dp) { await toggleDuty(dp.dataset.k); return renderHome(); }
  if (e.target.id === "ctClear") { if (confirm("불러온 비상연락망을 지우고 샘플로 되돌릴까요?")) { await idbSet("contacts", {}); renderHome(); } }
});
document.addEventListener("change", async (e) => {
  if (e.target.id !== "ctFile") return;
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    let data;
    if (/\.json$/i.test(f.name)) { const j = JSON.parse(await f.text()); data = j.contacts; } else data = parseContacts(await loadGrids(await f.arrayBuffer()));
    if (!data || !Object.keys(data).length) throw new Error("읽을 연락처가 없어요");
    const old = (await idbGet("contacts").catch(() => null)) || {}; const cur = old.data || {};
    Object.keys(data).forEach((k) => { if (!data[k].co && cur[k] && cur[k].co) data[k].co = cur[k].co; });
    await idbSet("contacts", { data: { ...cur, ...data }, ts: Date.now() });
    toast(`연락처 ${Object.values(data).reduce((n, v) => n + v.people.length, 0)}명 불러왔어요`, 4000); renderHome();
  } catch (err) { toast("불러오지 못했어요: " + err.message, 6000); }
});
$("#hTiles").addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (!b) return; if (b.dataset.seg) statSeg = b.dataset.seg; showTab(b.dataset.go); });

/* ---------- 일정 ---------- */
const planState = { p: "today", f: "all" };
function planRange(p) {
  const t = today0();
  if (p === "today") return [t, t];
  if (p === "week") { const a = new Date(t); a.setDate(t.getDate() - t.getDay()); const b = new Date(a); b.setDate(a.getDate() + 6); return [a, b]; } // 일요일 시작(점검표와 같게)
  return [new Date(t.getFullYear(), t.getMonth(), 1), new Date(t.getFullYear(), t.getMonth() + 1, 0)];
}
async function renderPlan() {
  const { items, demo } = await getPlan();
  $("#planDemo").hidden = !demo; $("#planClear").hidden = demo;
  $("#planKind").innerHTML = chipsHtml([["all", "전체"], ["1호선", "1호선"], ["2호선", "2호선"], ["검사", "검사"], ["중보수", "중보수"]], planState.f);
  [...$("#planPeriod").children].forEach((b) => b.classList.toggle("on", b.dataset.p === planState.p));
  const [a, b] = planRange(planState.p), f = planState.f;
  const rows = items.map((it) => ({ it, d: itemDate(it) })).filter((x) => x.d >= a && x.d <= b)
    .filter((x) => f === "all" || (f === "1호선" || f === "2호선" ? x.it.line === f : x.it.cat === f))
    .sort((x, y) => x.d - y.d || CATS.indexOf(x.it.cat) - CATS.indexOf(y.it.cat) || (x.it.line || "").localeCompare(y.it.line || "") || (x.it.kind || "").localeCompare(y.it.kind || ""));
  if (!rows.length) { $("#planList").innerHTML = `<div class="empty">이 기간·조건에 일정이 없어요${demo ? "" : "<br>다른 달 점검표는 위 버튼으로 불러오세요."}</div>`; return; }
  let html = "", last = -1; const t0 = today0().getTime();
  rows.forEach((x) => { const k = x.d.getTime(); if (k !== last) { html += `<div class="dayh${k === t0 ? " today" : ""}">${dLabel(x.d)}${k === t0 ? " · 오늘" : ""}</div>`; last = k; } html += itemHtml(x.it); });
  $("#planList").innerHTML = html;
}
$("#planPeriod").addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b) { planState.p = b.dataset.p; renderPlan(); } });
$("#planKind").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { planState.f = b.dataset.f; renderPlan(); } });
$("#planClear").onclick = async () => { if (!confirm("이 폰에 불러온 일정을 모두 지울까요?")) return; await idbSet("plan", { items: [] }); renderPlan(); toast("지웠어요"); };

/* 월간점검표 엑셀(.xlsx/.xlsm) 읽기 — AI 없이 표 모양(요일 줄·분류 칸)으로 직접 읽음, 파일은 이 폰 밖으로 나가지 않음 */
const xColNum = (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return [c, +m[2]]; };
async function loadGrids(buf) {
  const zip = await JSZip.loadAsync(buf);
  const txt = async (p) => { const f = zip.file(p); return f ? f.async("string") : null; };
  const dom = (s) => new DOMParser().parseFromString(s, "application/xml");
  const ss = [], sx = await txt("xl/sharedStrings.xml");
  if (sx) [...dom(sx).getElementsByTagName("si")].forEach((si) => ss.push([...si.getElementsByTagName("t")].filter((t) => t.parentNode.nodeName !== "rPh").map((t) => t.textContent).join("")));
  const names = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1]) - parseInt(b.match(/(\d+)\.xml/)[1]));
  const out = [];
  for (const sn of names) {
    const x = dom(await txt(sn)), grid = new Map(), merges = [];
    [...x.getElementsByTagName("c")].forEach((c) => {
      const [col, row] = xColNum(c.getAttribute("r")), t = c.getAttribute("t"); let v = "";
      if (t === "inlineStr") v = [...c.getElementsByTagName("t")].map((e) => e.textContent).join("");
      else { const ve = c.getElementsByTagName("v")[0]; if (!ve) return; v = t === "s" ? ss[+ve.textContent] || "" : ve.textContent; }
      v = String(v).trim(); if (!v) return;
      if (!grid.has(row)) grid.set(row, new Map()); grid.get(row).set(col, v);
    });
    [...x.getElementsByTagName("mergeCell")].forEach((m) => { const [a, b] = m.getAttribute("ref").split(":"); if (!b) return; const [c1, r1] = xColNum(a), [c2, r2] = xColNum(b); merges.push({ c1, r1, c2, r2 }); });
    out.push({ grid, merges });
  }
  return out;
}
async function readXlsx(buf, fname) {
  const grids = await loadGrids(buf);
  const items = []; let title = "";
  for (const { grid, merges } of grids) {
    let base = null;
    grid.forEach((cols) => cols.forEach((v) => { const m = /(20\d\d)\s*년\s*(\d{1,2})\s*월/.exec(v); if (m && !base) base = { y: +m[1], m: +m[2] }; }));
    if (!base) { const m = /(20\d\d)\D{0,3}(\d{1,2})/.exec(fname || ""); if (m && +m[2] >= 1 && +m[2] <= 12) base = { y: +m[1], m: +m[2] }; }
    const rowsSorted = [...grid.keys()].sort((a, b) => a - b);
    // 요일 줄 아래 "날짜 숫자 줄" 찾기: 1~31이 5개 이상 이어지는 줄
    const heads = [];
    rowsSorted.forEach((r) => {
      const cs = [...grid.get(r).entries()].filter(([c, v]) => /^\d{1,2}$/.test(v) && +v >= 1 && +v <= 31).sort((a, b) => a[0] - b[0]);
      let best = [], cur = [];
      cs.forEach(([c, v], i) => { const prev = cur.length ? +cur[cur.length - 1][1] : null; if (prev !== null && (+v === prev + 1 || (+v === 1 && prev >= 28))) cur.push([c, v]); else cur = [[c, v]]; if (cur.length > best.length) best = cur.slice(); });
      if (best.length >= 5) heads.push({ r, days: best.map(([c, v]) => { const mg = merges.find((m) => m.r1 === r && m.c1 === c); return { day: +v, c0: c, c1: mg ? mg.c2 : c }; }) });
    });
    if (!heads.length) continue;
    if (!base) { const m = /(\d{4})[-_.]?(\d{1,2})/.exec(fname || ""); const ans = prompt("몇 월 일정인가요? (예: 2026-11)", m ? m[1] + "-" + m[2] : ""); const mm = /(20\d\d)\D+(\d{1,2})/.exec(ans || ""); if (!mm) throw new Error("몇 월인지 알 수 없어요"); base = { y: +mm[1], m: +mm[2] }; }
    title = base.y + "년 " + base.m + "월";
    let curM = heads[0].days[0].day > 20 ? base.m - 1 : base.m, prevDay = 0;
    const dateOfHead = heads.map((h) => h.days.map((d) => { if (d.day < prevDay) curM++; prevDay = d.day; return { ...d, date: new Date(base.y, curM - 1, d.day) }; }));
    const cell = (r, c) => { const row = grid.get(r); return row ? row.get(c) : undefined; };
    heads.forEach((h, hi) => {
      const end = hi + 1 < heads.length ? heads[hi + 1].r : (rowsSorted[rowsSorted.length - 1] + 1), first = h.days[0].c0, dcs = dateOfHead[hi];
      for (let r = h.r + 1; r < end; r++) {
        let label = ""; const row = grid.get(r);
        if (row) for (const [c, v] of [...row.entries()].sort((a, b) => a[0] - b[0])) if (c < first) { label = v; break; }
        if (!label) { const m = merges.find((m) => m.r1 < r && m.r2 >= r && m.c1 < first); if (m) label = cell(m.r1, m.c1) || ""; }
        const L = label.replace(/\s/g, ""); let cls = null;
        const ln = (/([12])\s*호선/.exec(L) || /([12])/.exec(L) || [])[1];
        if (/^EL/i.test(L)) cls = { cat: "점검", kind: "EL", line: (ln || "1") + "호선" };
        else if (/^ES/i.test(L)) cls = { cat: "점검", kind: "ES", line: (ln || "1") + "호선" };
        else if (/^검사/.test(L)) cls = { cat: "검사", kind: "", line: "" };
        else if (/^중보수/.test(L)) cls = { cat: "중보수", kind: "", line: "" };
        else if (/^수선/.test(L)) cls = { cat: "수선", kind: "", line: "" };
        if (!cls || !row) continue;
        row.forEach((v, c) => {
          if (c < first) return; const dc = dcs.find((d) => c >= d.c0 && c <= d.c1); if (!dc) return;
          const text = v.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^[-–—\s]+$/.test(s)).join(" · "); if (!text) return;
          const dt = dc.date; items.push({ date: dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate()), ...cls, text });
        });
      }
    });
  }
  if (!items.length) throw new Error("월간점검표 모양을 찾지 못했어요 (날짜 숫자 줄과 EL/ES/검사/중보수 칸이 필요해요)");
  return { name: title + " 월간점검표", items };
}
$("#planFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const res = /\.json$/i.test(f.name) ? JSON.parse(await f.text()) : await readXlsx(await f.arrayBuffer(), f.name);
    const items = (res.items || []).filter((it) => it && /^\d{4}-\d{2}-\d{2}$/.test(it.date || "") && it.text && it.cat);
    if (!items.length) throw new Error("읽을 일정이 없어요");
    let st = null; try { st = await idbGet("plan"); } catch (er) {}
    const nd = new Set(items.map((i) => i.date)); // 같은 날짜는 새 파일 내용으로 바꿈
    const keep = ((st && st.items) || []).filter((i) => !nd.has(i.date));
    await idbSet("plan", { items: keep.concat(items), ts: Date.now() });
    const ds = [...nd].sort(); toast(`${items.length}건 불러왔어요 (${ds[0].slice(5)} ~ ${ds[ds.length - 1].slice(5)})`, 4500);
    renderPlan();
  } catch (err) { toast("불러오지 못했어요: " + err.message, 6000); }
});

/* ---------- 재고 ---------- */
const stockState = { q: "", f: "all" };
async function renderStock() {
  const d = await loadData("sample").catch(() => ({})); let arr = (d.stock || []).slice();
  $("#stockF").innerHTML = chipsHtml([["all", "전체"], ["zero", "없는 것"], ["low", "부족(2개 이하)"]], stockState.f);
  const q = stockState.q.toLowerCase().replace(/\s/g, "");
  if (q) arr = arr.filter((x) => hasText((x.n + x.sp).toLowerCase().replace(/\s/g, ""), q));
  if (stockState.f === "zero") arr = arr.filter((x) => x.qty === 0); else if (stockState.f === "low") arr = arr.filter((x) => x.qty <= 2);
  arr.sort((a, b) => a.qty - b.qty || a.n.localeCompare(b.n, "ko"));
  $("#stockList").innerHTML = arr.map((x) => {
    const cc = x.qty === 0 ? "zero" : x.qty <= 2 ? "low" : "";
    let alt = "";
    if (x.qty <= 2) alt = x.compat && x.compat.length ? `<div class="alt"><b>대체 가능</b> ${x.compat.map((c) => `${esc(c.n)} ${esc(c.sp)} · <b>${c.qty}개</b>`).join("<br>")}</div>` : (x.qty === 0 ? '<div class="alt" style="background:#fde7e5;color:var(--bad)">대체 부품 없음 · 구매 필요</div>' : "");
    return `<div class="item"><div class="top"><div><b>${esc(x.n)}</b><div class="sub2">${esc(x.sp)} · 위치 ${esc(x.loc || "-")}</div></div><span class="qty ${cc}">${x.qty}개</span></div>${alt}</div>`;
  }).join("") || '<div class="empty">찾는 부품이 없어요</div>';
}
$("#stockQ").addEventListener("input", (e) => { stockState.q = e.target.value; renderStock(); });
$("#stockF").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { stockState.f = b.dataset.f; renderStock(); } });

/* ---------- 현황(사고 · 장기 미수선 · 교체 이력) ---------- */
const accState = { f: "all" };
const accHtml = (a) => { const dt = itemDate(a); return `<div class="item"><div class="top"><b>${esc(a.place)}</b><span class="when">${dLabel(dt)}</span></div><div class="sub2"><span class="pill">${esc(a.kind || "")}</span><span class="pill ${a.done ? "ok" : "bad"}">${a.done ? "처리 완료" : "처리 중"}</span>${esc(a.what)}</div>${a.note ? `<div class="sub2">${esc(a.note)}</div>` : ""}</div>`; };
async function renderStat() {
  [...$("#statSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.s === statSeg));
  $("#sAcc").hidden = statSeg !== "acc"; $("#sLong").hidden = statSeg !== "long"; $("#sHist").hidden = statSeg !== "hist";
  if (statSeg === "hist") return renderHist();
  const d = await loadData("sample").catch(() => ({}));
  if (statSeg === "acc") {
    $("#accF").innerHTML = chipsHtml([["all", "전체"], ["open", "처리 중"], ["done", "처리 완료"]], accState.f);
    const arr = (d.acc || []).filter((a) => accState.f === "all" || (accState.f === "done" ? a.done : !a.done)).sort((a, b) => itemDate(b) - itemDate(a));
    $("#accList").innerHTML = arr.map(accHtml).join("") || '<div class="empty">기록이 없어요</div>';
  } else {
    const t = today0().getTime();
    const arr = (d.longrepair || []).map((x) => ({ ...x, days: Math.round((t - itemDate(x).getTime()) / 864e5) })).sort((a, b) => b.days - a.days);
    $("#longList").innerHTML = arr.map((x) => `<div class="item"><div class="top"><b>${esc(x.place)} · ${esc(x.item)}</b><span class="pill ${x.days >= 30 ? "bad" : "warn"}">${x.days}일째</span></div><div class="sub2">${esc(x.why || "")} · ${dLabel(itemDate(x))}부터</div></div>`).join("") || '<div class="empty">장기 미수선이 없어요</div>';
  }
}
$("#statSeg").addEventListener("click", (e) => { const b = e.target.closest("[data-s]"); if (b) { statSeg = b.dataset.s; renderStat(); } });
$("#accF").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { accState.f = b.dataset.f; renderStat(); } });

/* ---------- 시작 ---------- */
async function init() {
  try { const r = await fetch("data/stations.json"); if (r.ok) Object.assign(DATA, await r.json()); } catch (e) {}
  try { const r = await fetch("data/parts.json"); if (r.ok) { const d = await r.json(); PARTS = d.items.map(([n, sp, o]) => ({ n, sp, o, k: (n + sp + o).toLowerCase().replace(/\s/g, ""), nk: n.replace(/\s/g, "") })); } } catch (e) {}
  try { const st = await idbGet("state"); if (st) { S.jobs = (st.jobs || []).map((j) => { const k = { layout: "v", partSpec: "", ...j }; if (k.part === "__custom") k.part = k.partCustom || ""; return k; }); S.tray = st.tray || []; S.seq = st.seq || 0; } } catch (e) {}
  renderJobs();
  try {
    const r = await fetch("template.xlsm"); tpl = await r.arrayBuffer(); tplInfo = await XlsmCore.inspectTemplate(tpl);
    renderJobs();
  } catch (e) { toast("양식을 불러오지 못했어요. 인터넷에 한 번 연결한 뒤 다시 열어 주세요.", 6000); }
  if (location.search.includes("shared")) { await intakeShared(); history.replaceState(null, "", location.pathname); }
  if ("serviceWorker" in navigator) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (had && !window.__rl && !making) { window.__rl = 1; toast("새 버전으로 바꾸는 중…", 1500); setTimeout(() => location.reload(), 800); } });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
  }
  $("#foot").textContent = `버전 ${APP_VERSION}`;
  let t0 = "home"; try { t0 = localStorage.getItem("sdj-tab") || "home"; } catch (e) {}
  showTab(location.search.includes("shared") ? "photo" : (TITLES[t0] ? t0 : "home"));
  autoFlush();
}
init();
