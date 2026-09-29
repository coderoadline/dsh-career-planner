/**
 * 简历 → Markdown 解析。
 *
 * 【v1.5.4】主力改用 **officeparser**（`npm i officeparser`）：
 *   它能识别文件类型、给出 warnings、支持 OCR（`ocr:true`）、返回结构化节点，
 *   比手写的正则解包可靠得多 —— 尤其是它**能告诉你是哪种文件**，
 *   而手写版只会笼统报"抽不出文字（可能是扫描件）"。
 *
 * 【但 officeparser 是可选依赖】：
 *   没装 / 加载失败 → 自动回退到下面内置的零依赖实现，
 *   保住「零依赖也能用」这个老原则。两条路对外接口一致。
 *
 * 两条路都遵守同一条铁律：**原件永不被修改**，结果写成 `<原名>.md` 新文件。
 * 抽不出文字时**如实报错**，不返回空白冒充成功。
 *
 * 用法：
 *   import { resumeToMarkdown } from './resume-parse.mjs'
 *   const { md, source } = await resumeToMarkdown('简历.pdf', buf)
 */
import { readFile } from 'node:fs/promises';
import { inflateRawSync, inflateSync, brotliDecompressSync } from 'node:zlib';

const DECOMP = (method, data) => {
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`压缩方式 ${method} 不支持`);
};

/** 从 docx（zip）里取 word/document.xml 的正文 */
function fromDocx(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 docx（zip 结构损坏）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let entry = null;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === 'word/document.xml') entry = { method, compSize, localOff };
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (!entry) throw new Error('docx 里没有 word/document.xml');

  const lh = entry.localOff;
  const lNameLen = buf.readUInt16LE(lh + 26);
  const lExtraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + lNameLen + lExtraLen;
  const xml = DECOMP(entry.method, buf.subarray(start, start + entry.compSize)).toString('utf8');

  const body = (xml.match(/<w:body[\s\S]*<\/w:body>/) || [xml])[0];
  const paras = body.split(/<w:p[ >]/).slice(1);
  const lines = [];
  for (const p of paras) {
    const t = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('');
    let line = t
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ').trim();
    if (!line || /^[·•\-–—\s]+$/.test(line)) continue;
    // 行首漏出来的属性值噪声（形如 -3727455866130）。
    // ⚠️ 只吃 6 位以上纯数字戳：更宽的匹配会把「2025年4.22」的年份也吃掉。
    line = line.replace(/^[-—–\s]*(?:\d{6,}\s*)+/, '');
    lines.push(line);
  }
  // 全文去重：docx 常把同一段在「表格」和「正文」各放一份
  return [...new Set(lines)];
}

/** 从 pdf 里取文本算子（只对"文字版 PDF"有效） */
function fromPdf(buf) {
  const chunks = [];
  // 找出所有 stream…endstream，尝试解压后抽文本
  const s = buf.toString('latin1');
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    let data = buf.subarray(start, end);
    let text = null;
    try { text = inflateSync(data).toString('latin1'); }
    catch { try { text = inflateRawSync(data).toString('latin1'); } catch { text = null; } }
    if (!text) continue;
    // 内容流里的文本算子： (abc) Tj  /  [(a) -2 (b)] TJ
    const parts = [];
    for (const t of text.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      let v = t[0].slice(1, -1);
      v = v.replace(/\\([()\\])/g, '$1').replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
      parts.push(v);
    }
    if (parts.length) chunks.push(parts.join(''));
  }
  const text = chunks.join('\n').replace(/[ \t]+/g, ' ').trim();
  if (!text) {
    throw new Error('这个 PDF 里抽不出文字（可能是扫描件/图片版）。'
      + '请把内容复制成 .txt 或 .md 再上传，或直接粘贴给 Agent。');
  }
  return text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
}

/** 旧版 .doc（OLE2）：抓 WordDocument 流里的可见文本（尽力而为） */
function fromDoc(buf) {
  // doc 里文本常是 UTF-16LE 或 CP1252 连续串。先试 UTF-16LE 的可打印片段
  const utf16 = buf.toString('utf16le');
  const cand = utf16.match(/[\u4e00-\u9fffA-Za-z0-9\s，。：；、（）()\-—·,.!%/+#@]{6,}/g);
  if (cand && cand.length) {
    return [...new Set(cand.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 6))];
  }
  // 退一步：ASCII 可打印片段
  const ascii = buf.toString('latin1');
  const a2 = ascii.match(/[\x20-\x7e]{10,}/g);
  if (a2 && a2.length) return [...new Set(a2.map((s) => s.trim()))];
  throw new Error('旧版 .doc 抽不出文字。请另存为 .docx / .pdf / .txt 再上传。');
}

/**
 * 解析简历文件 → Markdown 文本。
 * @param {string} name 文件名（用于判扩展名）
 * @param {Buffer} buf  文件内容
 * @returns {Promise<{md:string, ext:string, lines:number, source:string}>}
 */
export async function resumeToMarkdown(name, buf) {
  const dot = name.lastIndexOf('.');
  const ext = (dot >= 0 ? name.slice(dot) : '').toLowerCase();
  const isImage = ['.png', '.jpg', '.jpeg'].includes(ext);
  if (!['.md', '.markdown', '.txt', '.docx', '.doc', '.pdf'].includes(ext) && !isImage) {
    throw new Error(`暂不支持解析「${ext || '无扩展名'}」，请上传 doc / docx / pdf / md / txt，或直接粘贴简历文字`);
  }

  // 纯文本不值得绕库
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    const lines = buf.toString('utf8').split(/\r?\n/);
    return finish(name, ext, lines, '原文');
  }

  // ① 主力：officeparser（可选依赖）
  let opErr = null;
  try {
    const { parseOffice } = await import('officeparser');
    // ⚠️ 必须显式给 fileType：officeparser 靠魔数自动识别文件类型，
    //    而 .md / .txt / .png 这类**没有魔数**的格式会直接报
    //    "Auto-detection of file type from buffer failed"。
    //    扩展名我们已经知道了，直接告诉它，别让它猜。
    const fileType = ext.slice(1);
    const ast = await parseOffice(buf, {
      ocr: true,                 // 图片/扫描件走 OCR（tesseract.js）
      extractAttachments: true,
      fileType,                  // ← 关键：绕过魔数识别
    });
    // 用 to('text') 而不是 to('markdown')：后者会把 WPS/Word 的文档属性
    // （author、KSOProductBuildVer、ICV、created…）当正文塞进结果，污染 md。
    const text = (await ast.to('text')).value;
    const lines = String(text).split(/\r?\n/);
    if (lines.join('').trim()) {
      const warn = (ast.warnings || []).map((w) => w && (w.message || w)).filter(Boolean);
      const via = isImage ? 'officeparser OCR' : 'officeparser';
      return finish(name, ext, lines, `${via}（${ast.type || fileType}）${warn.length ? '，有告警' : ''}`);
    }
    opErr = `officeparser 认出这是 ${ast.type || fileType}，但没抽出文字`;
  } catch (e) {
    opErr = `officeparser 不可用或失败：${(e && e.message) || e}`;
  }

  // 图片没有内置兜底（OCR 只有 officeparser 走 tesseract），直接报错但说清
  if (isImage) {
    throw new Error(`${opErr}。图片版简历需要 OCR，officeparser 未装或未启用；`
      + '请安装依赖（npm i officeparser），或把图片里的文字复制成 .txt/.md 再上传。');
  }

  // ② 兜底：内置零依赖实现
  try {
    let lines;
    let source;
    if (ext === '.docx') { source = 'docx 解析（内置兜底）'; lines = fromDocx(buf); }
    else if (ext === '.doc') { source = 'doc 解析（内置兜底）'; lines = fromDoc(buf); }
    else { source = 'pdf 解析（内置兜底）'; lines = fromPdf(buf); }
    return finish(name, ext, lines, source);
  } catch (fbErr) {
    // 两条路都不行：把两个原因都说清楚，别只报一个
    throw new Error(
      `${opErr}；内置兜底也不行：${(fbErr && fbErr.message) || fbErr}。`
      + '如果这是扫描件/图片版 PDF，请把内容复制成 .txt 或 .md 再上传，或直接粘贴给 Agent。',
    );
  }
}

/** 清洗 + 组装 Markdown。原件不碰。 */
function finish(name, ext, lines, source) {
  const body = lines
    .map((l) => String(l).trimEnd())
    .filter((l, i, arr) => l.trim() !== '' || (i > 0 && arr[i - 1].trim() !== ''))
    .join('\n')
    .replace(/^#+\s*$/gm, '')
    .trim();
  if (!body) throw new Error('解析结果是空的（文件里没有可读文字）');
  const md = `# ${name.replace(/\.[^.]+$/, '')}\n\n> 由 ${source} 自动生成，原始文件未被修改。\n\n${body}\n`;
  return { md, ext, lines: lines.length, source };
}
