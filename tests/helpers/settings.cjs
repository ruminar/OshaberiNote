"use strict";
module.exports = function settings(tags = []) {
  return { enabled: true, theme: "system", noteUserId: "", dashboardDisabled: false, mode:'normal', ollamaUrl: "http://127.0.0.1:11434", ollamaModel: "", ollamaSystemPrompt: "",
    hideArticleRecommendations: false, hidePaidArticles: false, hideLikeCounts: false, keepNoteHeaderVisible: false, tagSchemaVersion: 2,
    tagGroups: [1, 2, 3, 4].map(number => ({ id: `group${number}`, name: "", tags: number === 1 ? tags : [] })),
    selectedTagGroupId: "group1", groupSelectionRevision: 0, tagGroupsRevision: 0 };
};
module.exports.groups = function groups(tags = []) {
  const {tagSchemaVersion,tagGroups,selectedTagGroupId,groupSelectionRevision,tagGroupsRevision}=module.exports(tags);
  return {tagSchemaVersion,tagGroups,selectedTagGroupId,groupSelectionRevision,tagGroupsRevision};
};
