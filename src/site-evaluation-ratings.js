/* 作品群の鑑定結果と、公開記録から計算する能力値。 */
(() => {
  "use strict";
  const unknown = "判定不能";
  const axes = [
    ["impact", "破壊力", "面白さ"], ["speed", "スピード", "読者の反応"],
    ["reach", "射程距離", "平均本文文字数"], ["stamina", "持続力", "投稿活動"],
    ["precision", "精密動作性", "読みやすさ"], ["originality", "成長性", "独創性"]
  ];
  const modelAxes = axes.filter(([key]) => ["impact", "precision", "originality"].includes(key));
  const evidenceKinds = ["strength", "weakness"];
  const levels = { strength: ["圧倒的", "顕著", "有用", "軽微"], weakness: ["致命的", "深刻", "影響あり", "影響なし"] };
  const legacyStrengthLevels = { 突出: "圧倒的", 決め手: "顕著" };
  const levelLabels = Object.values(levels).flat();
  const speedThresholds = [360, 120, 60, 20];
  const windowDays = 56, inactiveDays = 60, day = 86400000;

  function grade(value, thresholds) {
    return ["A", "B", "C", "D"][thresholds.findIndex(minimum => value >= minimum)] ?? "E";
  }

  function speed(articles) {
    const counts = articles.map(article => article.likeCount).filter(value => Number.isSafeInteger(value) && value >= 0);
    if (!counts.length || counts.length !== articles.length) return { rank: unknown, reason: `クリエイターページの一覧でスキ数を確認できた記事は${counts.length} / ${articles.length}本です。` };
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (!Number.isSafeInteger(total)) return { rank: unknown, reason: "スキ数の合計を正確に計算できませんでした。" };
    const average = total / counts.length;
    return { rank: grade(average, speedThresholds), reason: `クリエイターページの一覧 ${counts.length}本のスキ合計${total}件 ÷ ${counts.length}本で、平均${average.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}件です。ランク境界は試用値です。` };
  }

  const bodyLength = body => [...body.replace(/\s/gu, "")].length;

  function reach(articles) {
    if (!articles.length || articles.some(article => typeof article.body !== "string")) {
      return { rank: unknown, reason: "記事の本文文字数を確認できませんでした。" };
    }
    const linkCards = articles.reduce((sum, { body }) => sum + (body.match(/^\[リンクカード\][ \t]*\r?$/gm)?.length ?? 0), 0);
    if (linkCards >= 500) {
      return { rank: unknown, reason: `選んだ記事のリンクカードが合計${linkCards}件あり、500件以上のため射程距離は判定不能です。` };
    }
    const total = articles.reduce((sum, { body }) => sum + bodyLength(
      body.replace(/^\[リンクカード\][ \t]*\r?\n(?:[ \t]*(?:種類|タイトル|著者|紹介文|URL|埋め込みURL)：[^\r\n]+(?:\r?\n|$))+/gm, "")
    ), 0);
    const average = total / articles.length;
    const display = value => value.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
    return { rank: grade(average, [20000, 10000, 4000, 1000]),
      reason: `評価した${articles.length}本の本文合計${display(total)}字 ÷ ${articles.length}本で、平均${display(average)}字です（リンクカード情報・空白・改行を除く）。` };
  }

  function stamina(dates, now, pinnedDates = []) {
    const timestamps = dates.map(value => typeof value === "string" ? Date.parse(value) : NaN);
    const ordered = timestamps.length >= 2 && timestamps.every((value, index) => Number.isFinite(value) && value <= now && (!index || value <= timestamps[index - 1]));
    const pinned = pinnedDates.map(value => typeof value === "string" ? Date.parse(value) : NaN);
    if (!ordered || pinned.some(value => !Number.isFinite(value) || value > now)) return { rank: unknown, reason: "公開記事一覧から投稿順と投稿日を確認できませんでした。" };
    const newest = Math.max(timestamps[0], ...pinned);
    const latest = new Date(newest).toISOString().slice(0, 10);
    if (now - newest >= inactiveDays * day) return { rank: "E", reason: `公開一覧の最新投稿日は${latest}で、60日以上経過しています。` };
    const windowStart = now - windowDays * day;
    const since = Math.max(windowStart, timestamps.at(-1));
    const observedDays = Math.max(1, Math.ceil((now - since) / day));
    const count = [...timestamps, ...pinned].filter(value => value >= since).length;
    const weekly = count * 7 / observedDays;
    const rank = weekly >= 7 ? "A" : weekly >= 2 ? "B" : weekly >= 1 ? "C" : "D";
    const period = since > windowStart ? `初回の公開一覧で確認した期間（${observedDays}日間）` : `公開一覧から確認した直近${windowDays}日`;
    const weeklyText = weekly.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
    return { rank, reason: `${period}は${count}本（週平均${weeklyText}本）、最新投稿は${latest}です。` };
  }

  const string = { type: "string" };
  const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  const keyed = (keys, value) => Object.fromEntries(keys.map(key => [key, value]));
  const forAxes = build => object(Object.fromEntries(modelAxes.map(([key]) => [key, build(key)])));
  const parseJson = raw => JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
  const exactKeys = (item, keys) => item && typeof item === "object" && !Array.isArray(item) &&
    Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key));

  function evidenceFormat() {
    return forAxes(() => object({
      strength: { ...string, maxLength: 240, description: "記事本文に基づく長所の具体例と理由。重要度のラベルを入れない。該当なしは空文字。" },
      weakness: { ...string, maxLength: 240, description: "記事本文に基づく短所の具体例と理由。重要度のラベルを入れない。該当なしは空文字。" },
      ...Object.fromEntries(evidenceKinds.map(kind => [`${kind}_level`, { ...string, enum: ["", ...levels[kind]] }]))
    }));
  }

  function readEvidence(raw) {
    let value;
    try { value = parseJson(raw); }
    catch { throw new Error("応答が有効なJSONではありません。"); }
    const axisKeys = modelAxes.map(([key]) => key);
    if (!exactKeys(value, axisKeys)) throw new Error("JSONに必要な3つの評価軸が揃っていないか、余分な項目があります。");
    return Object.fromEntries(modelAxes.map(([key, label]) => {
      const entry = value[key];
      if (!exactKeys(entry, [...evidenceKinds, ...evidenceKinds.map(kind => `${kind}_level`)])) {
        throw new Error(`${label}（${key}）の根拠・重要度の項目に不足または余分があります。`);
      }
      const evidence = [];
      for (const kind of evidenceKinds) {
        const field = `${label}の${kind === "strength" ? "長所" : "短所"}`;
        if (typeof entry[kind] !== "string") throw new Error(`${field}（${kind}）が文字列ではありません。`);
        const example = entry[kind].trim();
        const bareExample = example.replace(/^[「『"'\s]+|[」』"'。．.\s]+$/gu, "");
        if (levelLabels.includes(bareExample) || Object.hasOwn(legacyStrengthLevels, bareExample)) {
          throw new Error(`${field}（${kind}）に重要度のラベルだけがあり、記事に基づく根拠がありません。`);
        }
        if ([...example].length > 240) throw new Error(`${field}（${kind}）の根拠が240文字を超えています。`);
        const rawLevel = typeof entry[`${kind}_level`] === "string" ? entry[`${kind}_level`].trim() : null;
        let level = rawLevel;
        if (kind === "strength" && Object.hasOwn(legacyStrengthLevels, rawLevel)) level = legacyStrengthLevels[rawLevel];
        if (example && level === "") throw new Error(`${field}（${kind}_level）に重要度がありません。`);
        if (level !== "" && !levels[kind].includes(level)) throw new Error(`${field}（${kind}_level）の重要度が指定の選択肢にありません。`);
        if (example) evidence.push({ kind, level, example });
      }
      return [key, evidence];
    }));
  }

  function aggregate(reviews) {
    const evidenceByArticle = reviews.map(({ title, raw }) => ({ title, evidence: readEvidence(raw) }));
    return Object.fromEntries(modelAxes.map(([key]) => {
      const counts = keyed(levelLabels, 0);
      const rows = { strength: [], weakness: [] };
      for (const { title, evidence } of evidenceByArticle) {
        for (const { kind, level, example } of evidence[key]) {
          counts[level]++;
          rows[kind].push([title, level, example]);
        }
      }
      const groupLabels = [["長所", "strength"], ["短所", "weakness"]];
      const breakdown = groupLabels.map(([label, kind]) =>
        `${label} ${levels[kind].map(level => `${level} ${counts[level]}件`).join("・")}`).join(" ｜ ");
      const groups = groupLabels.map(([label, kind]) => ({ label, rows: rows[kind] }));
      return [key, { counts, breakdown, reason: `${breakdown}（参照 ${reviews.length}本）`, groups }];
    }));
  }

  function rankEvidence(aggregated, speedRank, hasMedia) {
    const balance = counts => (counts.圧倒的 + counts.顕著) - (counts.致命的 + counts.深刻);
    const mediaBonus = hasMedia ? 1 + Number(["A", "B"].includes(speedRank)) : 0;
    const precision = aggregated.precision.counts;
    const ranks = {
      impact: grade(balance(aggregated.impact.counts) + mediaBonus, [5, 3, 2, 1]),
      precision: grade(2 * balance(precision) + precision.有用 - precision.影響あり, [6, 5, 3, 1]),
      originality: grade(balance(aggregated.originality.counts), [4, 3, 2, 1])
    };
    return Object.fromEntries(modelAxes.map(([key]) => {
      const axis = aggregated[key];
      const rank = ranks[key];
      const [strength, weakness] = evidenceKinds.map(kind => levels[kind].map(level => axis.counts[level]).join("/"));
      return [key, { ...axis, rank, display: `${rank}　長所(${strength})｜ 短所(${weakness})` }];
    }));
  }

  globalThis.OshaberiNoteEvaluationRatings = Object.freeze({ axes, speed, reach, bodyLength, stamina, evidenceFormat, readEvidence, aggregate, rankEvidence });
})();
