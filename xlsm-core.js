/* 사진대지 xlsm 생성 핵심 로직 — 양식(xlsm)의 매크로를 보존하려고 zip 안의 XML만 고친다. */
(function (g) {
  "use strict";

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function attr(tag, name) {
    const m = tag.match(new RegExp("\\s" + name.replace(":", "\\:") + '="([^"]*)"'));
    return m ? m[1] : null;
  }
  function parseRels(xml) {
    const map = {};
    (xml.match(/<Relationship\b[^>]*>/g) || []).forEach((t) => {
      const id = attr(t, "Id");
      if (id) map[id] = { target: attr(t, "Target"), type: attr(t, "Type") || "" };
    });
    return map;
  }
  function resolve(baseDir, target) {
    if (target.startsWith("/")) return target.slice(1);
    const parts = (baseDir ? baseDir.split("/") : []).filter(Boolean);
    target.split("/").forEach((p) => {
      if (p === "..") parts.pop();
      else if (p !== ".") parts.push(p);
    });
    return parts.join("/");
  }
  function dirOf(path) {
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }
  function relsPathOf(path) {
    return dirOf(path) + "/_rels/" + path.slice(path.lastIndexOf("/") + 1) + ".rels";
  }

  /* 양식 분석: 사진대지 시트, 사진 두 장의 위치(위=교체 전, 아래=교체 후)와 비율 */
  async function inspectTemplate(buf) {
    const zip = await g.JSZip.loadAsync(buf);
    const wb = await zip.file("xl/workbook.xml").async("string");
    const sheets = wb.match(/<sheet\b[^>]*>/g) || [];
    let sheetTag = sheets.find((t) => attr(t, "name") === "사진대지") || sheets[0];
    if (!sheetTag) throw new Error("양식에서 시트를 찾지 못했어요.");
    const rid = attr(sheetTag, "r:id");
    const wbRels = parseRels(await zip.file("xl/_rels/workbook.xml.rels").async("string"));
    const sheetPath = resolve("xl", wbRels[rid].target);
    const sheetRelsPath = relsPathOf(sheetPath);
    const sheetRelsFile = zip.file(sheetRelsPath);
    if (!sheetRelsFile) throw new Error("양식 시트에 사진이 없어요.");
    const sRels = parseRels(await sheetRelsFile.async("string"));
    const drawRel = Object.values(sRels).find((r) => /\/drawing$/.test(r.type));
    if (!drawRel) throw new Error("양식 시트에 사진이 없어요.");
    const drawingPath = resolve(dirOf(sheetPath), drawRel.target);
    const drawing = await zip.file(drawingPath).async("string");
    const anchors = [];
    const re = /<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:\1>/g;
    let m;
    while ((m = re.exec(drawing))) {
      const a = m[0];
      if (a.indexOf("<xdr:pic>") < 0) continue;
      const row = +((a.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/) || [])[1] || 0);
      const embed = (a.match(/r:embed="([^"]+)"/) || [])[1];
      const ext = a.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
      anchors.push({ row, embed, ratio: ext ? +ext[1] / +ext[2] : 5293179 / 3743624 });
    }
    anchors.sort((x, y) => x.row - y.row);
    if (anchors.length < 2) throw new Error("양식에 사진이 두 장 있어야 해요(교체 전/후).");
    return {
      sheetPath,
      drawingPath,
      drawingRelsPath: relsPathOf(drawingPath),
      before: anchors[0],
      after: anchors[1],
    };
  }

  /* 사진대지 한 건 만들기. crop(fileOrBlob, ratio) → Promise<Uint8Array|ArrayBuffer> (JPEG) */
  async function buildXlsm(buf, info, job, beforeImg, afterImg, crop) {
    const zip = await g.JSZip.loadAsync(buf);
    const drel = await zip.file(info.drawingRelsPath).async("string");
    const rels = parseRels(drel);
    let newRels = drel;
    const removed = [];
    const slots = [
      [info.before, beforeImg, "sdj_before"],
      [info.after, afterImg, "sdj_after"],
    ];
    for (const [slot, img, name] of slots) {
      const oldTarget = rels[slot.embed].target;
      const oldPath = resolve(dirOf(info.drawingPath), oldTarget);
      const newTarget = oldTarget.replace(/[^/]+$/, name + ".jpeg");
      zip.file(resolve(dirOf(info.drawingPath), newTarget), await crop(img, slot.ratio));
      newRels = newRels.replace('Target="' + oldTarget + '"', 'Target="' + newTarget + '"');
      removed.push(oldPath);
    }
    zip.file(info.drawingRelsPath, newRels);

    // 다른 곳에서 안 쓰는 옛 사진만 지운다
    const relFiles = Object.keys(zip.files).filter((p) => p.endsWith(".rels"));
    for (const p of removed) {
      let used = false;
      for (const rf of relFiles) {
        const x = await zip.file(rf).async("string");
        const base = dirOf(rf.replace(/_rels\/[^/]+\.rels$/, "x"));
        for (const r of Object.values(parseRels(x))) {
          if (r.target && resolve(base, r.target) === p) used = true;
        }
      }
      if (!used) zip.remove(p);
    }

    let ct = await zip.file("[Content_Types].xml").async("string");
    if (!/Extension="jpeg"/i.test(ct)) {
      ct = ct.replace("<Types", "<Types").replace(/(<Types\b[^>]*>)/, '$1<Default Extension="jpeg" ContentType="image/jpeg"/>');
      zip.file("[Content_Types].xml", ct);
    }

    let s = await zip.file(info.sheetPath).async("string");
    const setCell = (ref, inner) => {
      const re = new RegExp('<c r="' + ref + '"(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</c>)');
      if (re.test(s)) s = s.replace(re, inner);
      else throw new Error(ref + " 칸을 양식에서 찾지 못했어요.");
    };
    setCell("J3", '<c r="J3"><v>' + Number(dateOf(job)) + "</v></c>");
    setCell("K3", '<c r="K3" t="inlineStr"><is><t>' + esc(job.place || "") + "</t></is></c>");
    setCell("L3", '<c r="L3" t="inlineStr"><is><t>' + esc(job.work || "") + "</t></is></c>");
    // J3/K3/L3를 참조하는 칸의 저장된 값도 맞춰 둔다(열자마자 맞게 보이도록)
    const cache = { J3: String(Number(dateOf(job))), K3: esc(job.place || ""), L3: esc(job.work || "") };
    s = s.replace(/(<c r="[A-Z]+\d+"[^>]*>)<f>(J3|K3|L3)<\/f><v>[^<]*<\/v>/g, (all, open, ref) => open + "<f>" + ref + "</f><v>" + cache[ref] + "</v>");
    zip.file(info.sheetPath, s);

    let wb = await zip.file("xl/workbook.xml").async("string");
    if (!/fullCalcOnLoad/.test(wb)) {
      wb = wb.replace(/<calcPr\b([^>]*?)\s*\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
      zip.file("xl/workbook.xml", wb);
    }
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  }

  function safeName(s) {
    return String(s).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  }
  /* 날짜가 비었거나 형식이 틀리면 오늘 날짜로 */
  function dateOf(job) {
    if (/^\d{8}$/.test(job.date || "")) return job.date;
    const d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  }
  function reportName(job) {
    return safeName(dateOf(job) + " " + (job.place || "") + " " + (job.work || "") + (job.status ? " - " + job.status : "")) + ".xlsm";
  }
  function photoName(job, k, ext) {
    return safeName(dateOf(job).slice(2) + " " + (job.place || "") + " - " + k) + "." + ext;
  }
  function normWork(w) {
    w = String(w || "").trim().replace(/(\d+)\s*ea\b/gi, "$1개").replace(/\s+/g, " ");
    if (w && !/교체$/.test(w)) w += " 교체";
    return w;
  }

  g.XlsmCore = { inspectTemplate, buildXlsm, reportName, photoName, safeName, normWork };
})(typeof window !== "undefined" ? window : globalThis);
