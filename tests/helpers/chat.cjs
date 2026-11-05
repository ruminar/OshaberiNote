const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '../..', name), 'utf8');
const copy = value => value === undefined ? undefined : structuredClone(value);
module.exports = function backend() {
  const data = {}, handlers = {}, connections = [], permissionChecks = [];
  let fail = false, allowed = true;
  const event = name => ({ addListener(fn) { (handlers[name] ??= []).push(fn); } });
  const context = vm.createContext({ URL, TextEncoder, structuredClone, crypto: require('node:crypto').webcrypto, console,
    chrome: {
      runtime: { id: 'test', getURL: file => 'chrome-extension://test/' + file, onMessage: event('message'), onInstalled: event('install'), onStartup: event('startup'), onConnect: event('connect') },
      permissions: { contains: async options => { permissionChecks.push(copy(options)); return allowed; }, onRemoved: event('removed') },
      storage: { local: { get: async key => ({ [key]: copy(data[key]) }), set: async value => {
        if (fail) throw new Error('storage failed');
        const changes = Object.fromEntries(Object.entries(value).filter(([key, next]) => JSON.stringify(next) !== JSON.stringify(data[key])).map(([key, next]) => [key, { oldValue: copy(data[key]), newValue: copy(next) }]));
        Object.assign(data, copy(value));
        if (Object.keys(changes).length) queueMicrotask(() => { for (const fn of handlers.storage ?? []) fn(copy(changes), 'local'); });
      } }, onChanged: event('storage') },
      action: { onClicked: event('action') }, tabs: { create: async () => {} }, declarativeNetRequest: { updateDynamicRules: async () => {} }
    }
  });
  for (const file of ['src/common.js', 'src/chat-actions.js', 'src/chat-state.js', 'src/platform/browser-api.js', 'src/routing.js', 'src/background.js']) vm.runInContext(source(file), context, { filename: file });
  const sender = { id: 'test', url: 'chrome-extension://test/home.html', frameId: 0, tab: { id: 1 } };
  const send = (message, from = sender) => new Promise((resolve, reject) => {
    const handled = handlers.message[0](message, from, result => result.ok ? resolve(copy(result.settings)) : reject(Object.assign(new Error(result.error), { code: result.code })));
    if (!handled) resolve(undefined);
  });
  function connect(owner = 'owner') {
    let disconnect;
    const connection = { name: 'oshaberi-chat:' + owner, sender, onMessage: { addListener() {} }, onDisconnect: { addListener(fn) { disconnect = fn; } } };
    handlers.connect[0](connection); connections.push(connection);
    return () => disconnect();
  }
  return { context, data, handlers, permissionChecks, connect, send,
    chat: (operation, patch) => send({ type: 'chat-operation', operation, patch }),
    save: patch => send({ type: 'save-settings', patch }),
    settings: () => send({ type: 'get-state' }),
    set fail(value) { fail = value; }, set allowed(value) { allowed = value; }
  };
};
module.exports.source = source;
