/* 승강업무 통합앱 - 사고·고장 / 교체이력 실시간 공유용 백엔드
   스프레드시트를 DB처럼 쓰는 아주 단순한 Apps Script 웹앱.
   시트: "acc" (사고·고장), "hist" (교체이력) - 첫 실행 시 자동 생성됨. */

var KEY = "sdj2026"; // 분소 사람들끼리만 쓰는 간단한 암호(진짜 보안 아님, 장난 방지용)

var ACC_FIELDS = ["id","date","line","station","kind","unit","type","what","cause","action","part","worker","ftype","nonrun","tRecv","tArr","tDone","note","done","updatedAt"];
var HIST_FIELDS = ["id","ts","date","line","station","kind","unit","part","count","cu","status","maker"];

function getSS_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("SS_ID");
  var ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create("승강업무통합앱 DB"); props.setProperty("SS_ID", ss.getId()); }
  return ss;
}

function getSheet_(name, fields) {
  var ss = getSS_();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(fields); }
  return sh;
}

function sheetToRows_(sh, fields) {
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  var head = vals[0];
  var rows = [];
  for (var i = 1; i < vals.length; i++) {
    var o = {};
    for (var c = 0; c < head.length; c++) o[head[c]] = vals[i][c];
    if (o.id !== "" && o.id != null) rows.push(o);
  }
  return rows;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var p = e.parameter || {};
  if (p.key !== KEY) return out_({ ok: false, error: "key" });
  var coll = p.coll;
  if (coll === "acc") return out_({ ok: true, items: sheetToRows_(getSheet_("acc", ACC_FIELDS), ACC_FIELDS) });
  if (coll === "hist") return out_({ ok: true, items: sheetToRows_(getSheet_("hist", HIST_FIELDS), HIST_FIELDS) });
  return out_({ ok: false, error: "coll" });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "body" }); }
  if (body.key !== KEY) return out_({ ok: false, error: "key" });
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.coll === "acc") return out_(upsertAcc_(body));
    if (body.coll === "hist") return out_(addHist_(body));
    return out_({ ok: false, error: "coll" });
  } finally { lock.releaseLock(); }
}

function upsertAcc_(body) {
  var sh = getSheet_("acc", ACC_FIELDS);
  var item = body.item || {};
  if (body.action === "delete") {
    var vals = sh.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) { if (String(vals[i][0]) === String(item.id)) { sh.deleteRow(i + 1); break; } }
    return { ok: true };
  }
  if (!item.id) item.id = Date.now();
  item.updatedAt = Date.now();
  var data = sh.getDataRange().getValues();
  var head = data[0], rowIdx = -1;
  for (var r = 1; r < data.length; r++) { if (String(data[r][0]) === String(item.id)) { rowIdx = r + 1; break; } }
  var row = head.map(function (f) { return item[f] !== undefined ? item[f] : ""; });
  if (rowIdx > 0) sh.getRange(rowIdx, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  return { ok: true, item: item };
}

function addHist_(body) {
  var sh = getSheet_("hist", HIST_FIELDS);
  var item = body.item || {};
  if (!item.id) item.id = Date.now() + "-" + Math.floor(Math.random() * 1000);
  var row = HIST_FIELDS.map(function (f) { return item[f] !== undefined ? item[f] : ""; });
  sh.appendRow(row);
  return { ok: true, item: item };
}
