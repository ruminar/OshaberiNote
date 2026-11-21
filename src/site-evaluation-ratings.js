/* 作品群の鑑定結果と、公開記録から計算する能力値。 */
(() => {
  "use strict";
  const unknown = "判定不能";
  const axes = [
    ["impact", "破壊力", "面白さ"], ["speed", "スピード", "読者の反応"],
    ["reach", "射程距離", "提供価値"], ["stamina", "持続力", "投稿活動"],
    ["precision", "精密動作性", "読みやすさ"], ["originality", "成長性", "独創性"]
  ];
  const modelAxes = axes.filter(([key]) => !["speed", "stamina"].includes(key));
  const evidenceKinds = ["strength", "weakness"];
  const classifications = {
    decisive: ["決め手", "strength"], useful: ["有用", "strength"], slight: ["軽微", "strength"],
    critical: ["致命的", "weakness"], material: ["影響あり", "weakness"], minor: ["無視できる", "weakness"]
  };
  const categories = Object.keys(classifications);
  const speedThresholds = [200, 100, 50, 20];
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
  const nonempty = { ...string, minLength: 1 };
  const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  const keyed = (keys, value) => Object.fromEntries(keys.map(key => [key, value]));
  const forAxes = build => object(Object.fromEntries(modelAxes.map(([key]) => [key, build(key)])));
  const parseJson = raw => JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
  const text = item => typeof item === "string" && Boolean(item.trim());
  const exactKeys = (item, keys) => item && typeof item === "object" && !Array.isArray(item) &&
    Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key));

  function evidenceFormat() {
    return forAxes(() => object(keyed(evidenceKinds, { ...string, maxLength: 240 })));
  }

  function readEvidence(raw, articleId) {
    const value = parseJson(raw);
    if (!exactKeys(value, modelAxes.map(([key]) => key))) throw new Error("評価軸が一致しません。");
    return Object.fromEntries(modelAxes.map(([key]) => {
      const entry = value[key];
      if (!exactKeys(entry, evidenceKinds) || !evidenceKinds.every(kind => typeof entry[kind] === "string" && entry[kind].length <= 240)) {
        throw new Error("根拠メモの項目が一致しません。");
      }
      return [key, evidenceKinds.filter(kind => text(entry[kind])).map(kind =>
        ({ id: `${articleId}:${key}:${kind}`, kind, example: entry[kind].trim() }))];
    }));
  }

  function outputFormat(reviews) {
    const articleIds = reviews.map(review => review.id);
    return object({
      type: nonempty,
      summary: nonempty,
      features: { type: "array", items: nonempty, maxItems: 3 },
      representatives: { type: "array", items: { type: "string", enum: articleIds }, maxItems: 3 },
      ratings: forAxes(key => {
        const evidence = reviews.flatMap(review => review.evidence[key]);
        return object({
          assignments: object(Object.fromEntries(evidence.map(item => [item.id, {
            type: "string", enum: categories.filter(category => classifications[category][1] === item.kind)
          }]))),
          counts: object(keyed(categories, { type: "integer", minimum: 0, maximum: evidence.length }))
        });
      })
    });
  }

  function invalidAssessment() { return new Error("能力鑑定の出力形式を確認できませんでした。"); }

  function classify(entry, reviews, key) {
    const evidence = reviews.flatMap(review => review.evidence[key].map(item => ({ ...item, title: review.title })));
    if (!exactKeys(entry, ["counts", "assignments"]) || !exactKeys(entry.counts, categories) ||
        !categories.every(category => Number.isInteger(entry.counts[category]) && entry.counts[category] >= 0) ||
        !exactKeys(entry.assignments, evidence.map(item => item.id))) throw invalidAssessment();
    const counts = keyed(categories, 0);
    const lines = [];
    for (const item of evidence) {
      const category = entry.assignments[item.id];
      if (!categories.includes(category) || classifications[category][1] !== item.kind) throw invalidAssessment();
      counts[category]++;
      lines.push(`- ${classifications[category][0]} · ${item.title} · ${item.example}`);
    }
    const breakdown = [ ["長所", "strength"], ["短所", "weakness"] ].map(([label, kind]) =>
      `${label} ${categories.filter(category => classifications[category][1] === kind)
        .map(category => `${classifications[category][0]} ${counts[category]}件`).join("・")}`).join(" ｜ ");
    const discrepancy = categories.some(category => entry.counts[category] !== counts[category]);
    const reason = [`${breakdown}（参照 ${reviews.length}本）`];
    if (discrepancy) reason.push("LLMの申告件数と分類結果に差があったため、根拠の分類から再集計しました。");
    if (!evidence.length) reason.push("この軸の長所・短所の根拠は抽出されませんでした。");
    return { counts, breakdown, reason: [...reason, ...lines].join("\n") };
  }

  function parse(raw, reviews) {
    const value = parseJson(raw);
    const articleIds = reviews.map(review => review.id);
    if (!exactKeys(value, ["type", "summary", "features", "representatives", "ratings"]) ||
        !text(value.type) || !text(value.summary) || !Array.isArray(value.features) || value.features.length > 3 || !value.features.every(text) ||
        !Array.isArray(value.representatives) || value.representatives.length > 3 || new Set(value.representatives).size !== value.representatives.length ||
        !value.representatives.every(id => articleIds.includes(id)) || !exactKeys(value.ratings, modelAxes.map(([key]) => key))) {
      throw invalidAssessment();
    }
    const ratings = Object.fromEntries(modelAxes.map(([key]) => [key, classify(value.ratings[key], reviews, key)]));
    return { ...value, ratings };
  }

  globalThis.OshaberiNoteEvaluationRatings = Object.freeze({ axes, modelAxes, speed, stamina, evidenceFormat, readEvidence, outputFormat, parse });
})();
