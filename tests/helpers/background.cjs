// note操作の流用試験用。AI処理そのものはchat.test.cjsで実ポートを検証する。
module.exports = function prepare(context) {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  Object.assign(context, { TextEncoder, structuredClone, crypto: require('node:crypto').webcrypto });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/chat-state.js'), 'utf8'), context);
  const port = context.OshaberiNoteBackgroundPlatform;
  if (Object.isFrozen(port)) return;
  port.onChatDisconnect ??= () => {};
  port.onPermissionRemoved ??= () => {};
  let queue = Promise.resolve();
  port.run ??= task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
};
