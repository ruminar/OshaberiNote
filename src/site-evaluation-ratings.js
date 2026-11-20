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
  const ranks = ["A", "B", "C", "D", "E", unknown];
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
    const latest = new Date(newest).toISOString().slice(0, 10), since = now - windowDays * day;
    if (now - newest >= inactiveDays * day) return { rank: "E", reason: `公開一覧の最新投稿日は${latest}で、60日以上経過しています。` };
    if (timestamps.at(-1) >= since) return { rank: unknown, reason: `最新投稿日は${latest}です。公開記事一覧の初回表示では直近${windowDays}日間の投稿を確認しきれませんでした。` };
    const count = [...timestamps, ...pinned].filter(value => value >= since).length;
    const weekly = count / (windowDays / 7);
    const rank = weekly >= 7 ? "A" : weekly >= 2 ? "B" : weekly >= 1 ? "C" : "D";
    return { rank, reason: `公開一覧から確認した直近${windowDays}日は${count}本（週平均${weekly}本）、最新投稿は${latest}です。` };
  }

  function outputFormat(articleIds) {
    const string = { type: "string", minLength: 1 };
    const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
    const axis = object({ rank: { type: "string", enum: ranks }, reason: string });
    return object({
      type: string,
      summary: string,
      features: { type: "array", items: string, maxItems: 3 },
      representatives: { type: "array", items: { type: "string", enum: articleIds }, maxItems: 3 },
      ratings: object(Object.fromEntries(modelAxes.map(([key]) => [key, axis])))
    });
  }

  function parse(raw, articleIds) {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
    const text = item => typeof item === "string" && Boolean(item.trim());
    if (!text(value?.type) || !text(value.summary) || !Array.isArray(value.features) || value.features.length > 3 || !value.features.every(text) ||
        !Array.isArray(value.representatives) || value.representatives.length > 3 || new Set(value.representatives).size !== value.representatives.length ||
        !value.representatives.every(id => articleIds.includes(id)) || !value.ratings || Object.keys(value.ratings).length !== modelAxes.length ||
        !modelAxes.every(([key]) => ranks.includes(value.ratings[key]?.rank) && text(value.ratings[key].reason))) {
      throw new Error("能力鑑定の出力形式を確認できませんでした。もう一度評価できます。");
    }
    return value;
  }

  globalThis.OshaberiNoteEvaluationRatings = Object.freeze({ axes, modelAxes, speed, stamina, outputFormat, parse });
})();
