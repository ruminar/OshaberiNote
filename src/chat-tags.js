/* 原文を保持し、完了したAI回答の箇条書き・太字と既知のタグ表記だけを安全なDOMで表示する。 */
(() => {
  "use strict";
  const core = globalThis.OshaberiNote;
  function parts(text) {
    const result = [];
    let offset = 0, count = 0;
    for (const match of text.matchAll(/\[#([^\[\]\r\n]{1,100})\]/gu)) {
      if (count >= 100) break;
      let tag;
      try {
        if (match[1].length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(match[1])) continue;
        tag = core.normalizeTag(match[1]);
      } catch { continue; }
      if (match.index > offset) result.push({ text: text.slice(offset, match.index) });
      result.push({ text: match[0], tag }); count++;
      offset = match.index + match[0].length;
    }
    if (offset < text.length) result.push({ text: text.slice(offset) });
    return result;
  }
  function create({ document: doc, platform, getSettings, onSaved }) {
    const byId = id => doc.getElementById(id), dialog = byId("chat-tag-dialog");
    let selected, saving = false, uncertain = false;
    const buttons = [];
    const signs = ["①", "②", "③", "④"];
    function refresh() {
      if (!dialog.open || !selected) return;
      const settings = getSettings();
      const blocked = saving || uncertain || !settings?.enabled || Boolean(settings?.tagWarning) || !selected.valid();
      for (let index = 0; index < buttons.length; index++) {
        const group = settings?.tagGroups.find(item => item.id === core.groupIds[index]);
        const registered = group?.tags.includes(selected.tag);
        buttons[index].textContent = `${signs[index]}${group ? core.groupName(group) : `グループ${index + 1}`}${registered ? "（登録済み）" : "に登録"}`;
        buttons[index].disabled = blocked || !group || registered;
      }
    }
    async function register(groupId) {
      if (!selected || saving || uncertain) return;
      const settings = getSettings(), tag = selected.tag;
      const group = settings?.tagGroups.find(item => item.id === groupId);
      if (!settings?.enabled || settings.tagWarning || !selected.valid() || !group || group.tags.includes(tag)) { refresh(); return; }
      saving = true; refresh();
      byId("chat-tag-status").textContent = "登録しています…";
      try {
        const next = await platform.tag({ type: "ADD_TAG", groupId, tag });
        onSaved(next);
        byId("chat-tag-status").textContent = `「#${tag}」を${core.groupName(next.tagGroups.find(item => item.id === groupId))}に登録しました。`;
      } catch (error) {
        uncertain = error.code === "UNCONFIRMED";
        byId("chat-tag-status").textContent = uncertain
          ? "登録結果を確認できません。ページを再読み込みしてお気に入りを確認してください。自動再送は行いません。"
          : error.message;
      } finally { saving = false; refresh(); }
    }
    for (const [index, groupId] of core.groupIds.entries()) {
      const button = doc.createElement("button"); button.type = "button";
      button.setAttribute("data-chat-tag-group", groupId);
      button.textContent = `${signs[index]}グループ${index + 1}に登録`;
      button.onclick = () => { void register(groupId); };
      byId("chat-tag-groups").append(button); buttons.push(button);
    }
    byId("chat-tag-close").onclick = () => dialog.close();
    dialog.addEventListener("close", () => { selected?.trigger.setAttribute("aria-expanded", "false"); selected = undefined; });
    function render(node, content, valid) {
      let offset = 0;
      const parsed = parts(content).map(part => { const start = offset; offset += part.text.length; return { ...part, start, end: offset }; });
      // HTMLとして解釈せず、同一行の **本文** だけをstrongへ変換する。
      const bold = [...content.matchAll(/(?<![\\*])\*\*(?!\*)(\S(?:[^\r\n]*?\S)?)(?<!\\)\*\*(?!\*)/gu)]
        .map(match => ({ start: match.index, end: match.index + match[0].length }))
        .filter(range => !parsed.some(part => part.tag && (
          (range.start < part.end && range.start + 2 > part.start) ||
          (range.end - 2 < part.end && range.end > part.start))));
      const hasList = /^[ \t]*\*[ \t]+\S/m.test(content);
      if (!hasList && !parsed.some(part => part.tag) && !bold.length) { node.textContent = content; return; }
      node.replaceChildren();
      function appendRange(parent, start, end) {
        for (const part of parsed) {
          const from = Math.max(start, part.start), to = Math.min(end, part.end);
          if (from >= to) continue;
          const child = doc.createElement(part.tag ? "button" : "span"); child.textContent = content.slice(from, to);
          if (part.tag) {
            child.type = "button"; child.className = "chat-tag-button";
            child.setAttribute("aria-haspopup", "dialog"); child.setAttribute("aria-controls", "chat-tag-dialog");
            child.setAttribute("aria-expanded", "false"); child.setAttribute("aria-label", `#${part.tag}の操作を選択`);
            child.onclick = () => {
              if (!valid() || saving) return;
              selected = { tag: part.tag, trigger: child, valid };
              byId("chat-tag-heading").textContent = `#${part.tag}`;
              byId("chat-tag-search").href = core.tagUrl(part.tag);
              byId("chat-tag-status").textContent = uncertain ? "登録結果が未確認です。ページを再読み込みして確認してください。" : "";
              child.setAttribute("aria-expanded", "true");
              dialog.showModal(); refresh();
            };
          }
          parent.append(child);
        }
      }
      function appendInline(parent, start, end) {
        let cursor = start;
        for (const range of bold) {
          if (range.start < start || range.end > end) continue;
          appendRange(parent, cursor, range.start);
          const strong = doc.createElement("strong"); appendRange(strong, range.start + 2, range.end - 2); parent.append(strong);
          cursor = range.end;
        }
        appendRange(parent, cursor, end);
      }
      if (!hasList) { appendInline(node, 0, content.length); return; }
      // ulは段落の中へ入れず、本文コンテナ直下に組み立てる。
      const stack = [];
      let paragraphStart, paragraphEnd;
      function flushParagraph() {
        if (paragraphStart !== undefined) {
          const value = content.slice(paragraphStart, paragraphEnd).replace(/[\r\n]+$/, "");
          if (value.trim()) { const p = doc.createElement("p"); appendInline(p, paragraphStart, paragraphStart + value.length); node.append(p); }
        }
        paragraphStart = undefined;
      }
      for (const match of content.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/gu)) {
        if (!match[0]) break;
        const line = match[1], start = match.index, end = start + line.length;
        const item = /^([ \t]*)\*[ \t]+(\S.*)$/.exec(line);
        if (item) {
          flushParagraph();
          const indent = item[1].replace(/\t/g, "    ").length;
          while (stack.length && stack.at(-1).indent > indent) stack.pop();
          if (!stack.length || indent > stack.at(-1).indent) {
            const ul = doc.createElement("ul");
            (stack.at(-1)?.last ?? node).append(ul); stack.push({ indent, ul, last: null });
          }
          const li = doc.createElement("li"), level = stack.at(-1);
          appendInline(li, end - item[2].length, end); level.ul.append(li); level.last = li;
        } else if (!line.trim()) {
          // 空行はリスト内の次の項目も許容し、通常段落では改行を保持する。
          if (paragraphStart !== undefined) paragraphEnd = start + match[0].length;
        } else if (stack.length && /^[ \t]+/.test(line) && line.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length > stack.at(-1).indent) {
          const continuation = doc.createElement("span"); continuation.textContent = "\n"; stack.at(-1).last.append(continuation);
          appendInline(stack.at(-1).last, start + line.match(/^[ \t]*/)[0].length, end);
        } else {
          stack.length = 0;
          paragraphStart ??= start; paragraphEnd = start + match[0].length;
        }
      }
      flushParagraph();
    }
    return Object.freeze({ render, refresh, close() { if (dialog.open) dialog.close(); } });
  }
  globalThis.OshaberiNoteChatTags = Object.freeze({ parts, create });
})();
