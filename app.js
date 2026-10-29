/* 사진대지 앱 — 업체·직원용. 서버 없이 폰 안에서만 돌아간다(사진은 어디에도 올라가지 않음). */
"use strict";
const APP_VERSION = "1.2.1";
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
    const zip = new JSZip(), names = new Set(), pn = new Set(), lines = [];
    for (let i = 0; i < ready.length; i++) {
      const j = ready[i], xj = xjob(j); btn.textContent = `만드는 중… (${i + 1}/${ready.length})`;
      const name = uniqueIn(names, XlsmCore.reportName(xj));
      zip.file(name, await XlsmCore.buildXlsm(tpl, tplInfo, xj, "before", "after", (k) => slotBytes(j, k)));
      [...j.before, ...j.after].forEach((p, idx) => zip.file("사진/" + uniqueIn(pn, XlsmCore.photoName(xj, idx + 1, "jpg")), p.blob));
      lines.push([xj.place, xj.work, xj.status].filter(Boolean).join(" "));
    }
    btn.textContent = "압축하는 중…";
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    out = { blob, name: `사진대지_${ymd(new Date())}.zip`, ids: ready.map((j) => j.id), text: lines.join("\n") + "\n(사진대지 앱 등록)" };
    $("#outInfo").textContent = `사진대지 ${ready.length}건 + 이름 바꾼 사진이 압축파일 하나에 들어 있어요. (${(blob.size / 1048576).toFixed(1)}MB)`;
    $("#outShare").hidden = !(navigator.canShare && navigator.canShare({ files: [new File([blob], out.name, { type: "application/zip" })] }));
    $("#outBack").hidden = false;
  } catch (e) { toast("만들지 못했어요: " + (e.message || e)); }
  finally { making = false; btn.disabled = false; renderJobs(); }
};
let shareTry = 0;
$("#outShare").onclick = () => {
  if (!out) return;
  const V = [["application/zip", out.name], ["application/octet-stream", out.name], ["application/octet-stream", out.name.replace(/\.zip$/, ".bin")]];
  const [type, nm] = V[shareTry % V.length], f = new File([out.blob], nm, { type });
  // 눌린 즉시 호출해야 폰이 허용한다(그 앞에 await 금지)
  navigator.share({ files: [f] }).then(() => { shareTry = 0; }, (e) => {
    if (e.name === "AbortError") return;
    shareTry++;
    toast(`보내지 못했어요 [방식 ${shareTry}/${V.length}]\n${e.name}: ${e.message}\n다시 누르면 다른 방식으로 시도해요. 계속 안 되면 '폰에 저장'.`, 9000);
  });
};
$("#outSave").onclick = () => {
  if (!out) return; const a = document.createElement("a"); a.href = URL.createObjectURL(out.blob); a.download = out.name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); toast("저장을 시작했어요. 알림창이나 내 파일의 '다운로드' 폴더를 확인하세요.");
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  $("#foot").textContent = `버전 ${APP_VERSION}`;
}
init();
