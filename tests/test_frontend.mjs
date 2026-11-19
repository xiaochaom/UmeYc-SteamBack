// 对真实构建产物提供最小 Decky/React 宿主，验证界面状态与 RPC 行为。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const bundle = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8')
  .replace('export { index as default };', 'globalThis.loadPlugin = index;');

async function harness(options = {}) {
  let modal;
  let custom = options.custom || [];
  let listener;
  let globalComponent;
  let page;
  const calls = [];
  const timers = new Set();
  const dialogs = [];
  let menu = 2;
  const menuStore = { GetOpenSideMenu: () => menu, CloseSideMenus() { menu = 0; } };
  const running = [];
  let saves = options.saves || [{ filename: 'save_42_1770000000000', timestamp: 1770000000000,
    game_info: { game_id: 42, game_name: '测试游戏', install_root: '/Steam' },
    pinned: false, note: '', is_undo: false }];
  const effects = [];
  const components = new Map();
  let current;
  let cursor;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    createContext: () => ({}),
    useState(initial) {
      const index = cursor++;
      if (!(index in current.values)) current.values[index] = typeof initial === 'function' ? initial() : initial;
      const state = current;
      return [state.values[index], value => {
        state.values[index] = typeof value === 'function' ? value(state.values[index]) : value;
      }];
    },
    useEffect(effect) { if (!current.mounted) effects.push(effect); },
  };
  const api = {
    _version: 2,
    routerHook: { addGlobalComponent(name, component) { globalComponent = component; }, removeGlobalComponent() {} },
    toaster: { toast() { throw Error('插件不得写入 Deck 通知'); } },
    openFilePicker: async () => ({ path: '/home/deck/存档', realpath: '/home/deck/存档' }),
    async call(method, ...args) {
      calls.push({ method, args });
      switch (method) {
        case 'get_path_context': return { home: '/home/deck', steam_root: '/Steam', backup_root: '/home/deck/homebrew/data/Steamback/saves2' };
        case 'set_account_id': return null;
        case 'find_mounted': return ['/Steam'];
        case 'get_custom_games': return custom;
        case 'set_custom_game': custom = [{ ...args[0], paths: args[1] }]; return custom[0];
        case 'list_save_files': return { directory: '/home/deck/存档', parent: '/home/deck', entries: [{ name: 'slot.sav', path: '/home/deck/存档/slot.sav', directory: false }, { name: '子目录', path: '/home/deck/存档/子目录', directory: true }], truncated: false };
        case 'find_supported': return [{ ...args[0][0], current_save_time: 1770000000000, save_games_roots: { '/Steam/userdata/123/42/remote': '', '/home/deck/游戏存档': '_1' } }];
        case 'get_saveinfos': return saves.map(s => ({ ...s }));
        case 'do_backup': return saves[0];
        case 'update_snapshot': { if (options.renameFails) throw Error('模拟保存失败'); const i = saves.findIndex(s => s.filename === args[0]); saves[i] = { ...saves[i], pinned: args[1], note: args[2], ...(args[3] === undefined ? {} : { name: args[3] }) }; return saves[i]; }
        case 'delete_snapshot': saves = saves.filter(s => s.filename !== args[0]); return true;
        case 'do_restore': return null;
        default: throw Error(`unexpected RPC: ${method}`);
      }
    },
  };
  const dfl = new Proxy({
    beforePatch(object, key, handler) {
      const original = object[key];
      object[key] = function (...args) { handler(args); return original.apply(this, args); };
      return { unpatch() { object[key] = original; } };
    },
    getGamepadNavigationTrees: () => options.mainWidth ? [{ id: 'GamepadUI_Full_Root', Root: { Element: { ownerDocument: { defaultView: { innerWidth: options.mainWidth, innerHeight: 534 } } } } }] : [], quickAccessMenuClasses: { Title: 'title' }, Router: { RunningApps: running },
    showModal(element) {
      menuStore.CloseSideMenus();
      modal = element;
      let resolve;
      const result = { closed: false, ClosedPromise: new Promise(r => { resolve = r; }), Close() { result.closed = true; resolve(); } };
      modal = { ...element, props: { ...element.props, closeModal: result.Close } };
      dialogs.push(result);
      return result;
    },
  }, { get: (object, key) => object[key] ?? key });
  const context = vm.createContext({
    console, SP_REACT: react, DFL: dfl,
    setTimeout(fn) {
      if (options.accountAfterWait) context.App.m_CurrentUser.strSteamID = options.accountAfterWait;
      queueMicrotask(fn);
    },
    window: { innerWidth: options.width || 854, innerHeight: 534, SP_REACT: react,
      SteamUIStore: { WindowStore: { GamepadUIMainWindowInstance: { MenuStore: menuStore } } },
      setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); },
      __DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit: { connect: () => api } },
    App: { m_CurrentUser: { strSteamID: options.steamID ?? '76561197960265851' } },
    SteamClient: {
      InstallFolder: { GetInstallFolders: async () => [{ strFolderPath: '/Steam', vecApps: [{ nAppID: 42, strAppName: '测试游戏' }] }] },
      Apps: { GetAllShortcuts: async () => [{ appid: -1, data: { strAppName: '非 Steam 游戏' } }] },
      GameSessions: { RegisterForAppLifetimeNotifications(fn) { listener = fn; return { unregister() {} }; } },
    },
  });
  vm.runInContext(bundle, context);
  const plugin = context.loadPlugin();
  assert.equal(plugin.name, 'UmeYc-SteamBack');
  function render(element = page || plugin.content) {
    current = components.get(element.type) || { values: [], mounted: false };
    components.set(element.type, current);
    cursor = 0;
    const result = element.type(element.props);
    current.mounted = true;
    return result;
  }
  function nodes(tree) {
    if (!tree || typeof tree !== 'object') return [];
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    return [tree, ...Object.values(tree.props || {}).flatMap(nodes)];
  }
  const find = (tree, type, predicate) => nodes(tree).find(n => n.type === type && predicate(n.props));
  render(globalComponent());
  render();
  effects.splice(0).forEach(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  function manage() {
    find(render(plugin.content), 'ButtonItem', p => p['aria-label'] === '打开游戏存档 42').props.onClick();
    const manager = render(modal);
    page = nodes(manager).find(n => typeof n.type === 'function' && n.props.side);
    render();
  }
  async function remount() {
    components.clear();
    render();
    effects.splice(0).forEach(effect => effect());
    await new Promise(resolve => setImmediate(resolve));
  }
  async function flush() { effects.splice(0).forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve)); }
  return { render, find, nodes, calls, listener, running, manage, remount, flush, modal: () => modal, dialogs,
    setSteamID(id) { context.App.m_CurrentUser.strSteamID = id; },
    async sideMenu(value) { if (value === 0) menuStore.CloseSideMenus(); else menu = value; timers.forEach(fn => fn()); await flush(); },
    async tick() { timers.forEach(fn => fn()); await flush(); },
    overlay: () => render(globalComponent()),
    button: (tree, label) => find(tree, 'ButtonItem', p => p.children.includes(label)) };
}

test('Steam 启动账号为零时等待真实账号，每次刷新重新注册账号', async () => {
  const h = await harness({ steamID: '0', accountAfterWait: '76561197960265851' });
  assert.equal(h.calls.find(c => c.method === 'set_account_id').args[0], 123);
  assert.ok(h.calls.some(c => c.method === 'find_supported'));
  // A backend restart must not rely on a previously resolved initialization.
  await h.button(h.render(), '刷新').props.onClick();
  assert.ok(h.calls.filter(c => c.method === 'set_account_id').length >= 2);
  h.setSteamID('76561198404030766');
  await h.button(h.render(), '刷新').props.onClick();
  assert.equal(h.calls.filter(c => c.method === 'set_account_id').at(-1).args[0], 443765038);
  h.manage();
  await h.remount();
  const registered = h.calls.filter(c => c.method === 'set_account_id').length;
  await h.button(h.render(), '立即备份').props.onClick();
  assert.equal(h.calls.filter(c => c.method === 'set_account_id').length, registered + 1);
  assert.equal(h.calls.findLast(c => c.method === 'set_account_id').args[0], 443765038);
  assert.ok(h.calls.some(c => c.method === 'do_backup'));
});

test('账号持续未就绪时不扫描错误目录，账号就绪后可以刷新恢复', async () => {
  const h = await harness({ steamID: '0' });
  assert.equal(h.calls.filter(c => c.method === 'set_account_id' || c.method === 'find_supported').length, 0);
  assert.ok(h.nodes(h.render()).some(n => JSON.stringify(n.props?.children).includes('Steam 账号尚未加载')));
  h.setSteamID('76561197960265851');
  await h.button(h.render(), '刷新').props.onClick();
  assert.equal(h.calls.find(c => c.method === 'set_account_id').args[0], 123);
  assert.ok(h.calls.some(c => c.method === 'find_supported'));
});

test('首页仅刷新与游戏列表，点击游戏打开 Steam 原生存档弹窗，仅手动备份', async () => {
  const h = await harness();
  const tree = h.render();
  assert.ok(h.button(tree, '刷新'));
  assert.ok(h.find(tree, 'PanelSection', p => p.title === '游戏（2）'));
  assert.ok(h.button(tree, '测试游戏'));
  assert.ok(h.button(tree, '非 Steam 游戏'));
  assert.equal(h.nodes(tree).filter(n => n.type === 'ToggleField').length, 0);
  assert.equal(h.listener, undefined);
  assert.equal(h.calls.filter(c => c.method === 'do_backup').length, 0);
  h.manage(); await h.flush();
  await h.button(h.render(), '立即备份').props.onClick();
  const backup = h.calls.find(c => c.method === 'do_backup');
  assert.equal(backup.args[0].game_id, 42);
  assert.equal(backup.args.length, 2);
});

test('存档统一按时间倒序，无固定按钮；详情两行操作、重命名保留旧备注及确认删除', async () => {
  const saves = [1, 2, 3].map(i => ({ filename: `save_42_${1770000000000 + i}`, timestamp: 1770000000000 + i,
    game_info: { game_id: 42, game_name: '测试游戏', install_root: '/Steam' }, pinned: i === 1, note: '原有备注', is_undo: false }));
  const h = await harness({ saves });
  h.manage(); await h.flush();
  const button = (label) => h.find(h.render(), 'DialogButton', p => p['aria-label'] === label);
  assert.equal(h.nodes(h.render()).filter(n => n.props?.['aria-label']?.startsWith('固定 ')).length, 0);
  let rows = h.nodes(h.render()).filter(n => n.type === 'DialogButton' && n.props['aria-label']?.startsWith('存档详情 '));
  assert.equal(rows[0].props['aria-label'], `存档详情 ${saves[2].filename}`);
  assert.equal(rows[1].props['aria-label'], `存档详情 ${saves[1].filename}`);
  button(`存档详情 ${saves[0].filename}`).props.onClick();
  const details = h.modal();
  const detailDialog = h.dialogs.at(-1);
  const gameDialog = h.dialogs[0];
  let tree = h.render(details);
  assert.equal(tree.props.bCloseAfterOK, false);
  h.find(tree, 'TextField', p => p.label.startsWith('存档名称')).props.onChange({ target: { value: '首领前' } });
  assert.equal(h.find(tree, 'TextField', p => p.label.startsWith('备注')), undefined);
  assert.ok(h.nodes(tree).some(n => n.props?.children?.includes('删除存档只删除备份，不会删除游戏当前存档。')));
  const column = h.find(tree, 'Focusable', p => p.style?.flexDirection === 'column');
  let prevented = false, stopped = false;
  column.props.onSubmit({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.ok(prevented && stopped);
  assert.equal(column.props.style.gap, 8);
  const rowsOfActions = h.nodes(tree).filter(n => n.type === 'Focusable' && n.props['flow-children'] === 'row');
  assert.deepEqual(rowsOfActions.map(row => h.nodes(row).filter(n => n.type === 'DialogButton').map(n => n.props.children.join(''))),
    [['恢复存档', '删除存档'], ['保存名称', '关闭']]);
  tree = h.render(details);
  await h.find(tree, 'DialogButton', p => p.children.includes('保存名称')).props.onClick();
  await h.tick();
  assert.equal(detailDialog.closed, true);
  assert.equal(gameDialog.closed, false);
  assert.ok(h.nodes(h.render()).some(n => n.props?.children?.includes('首领前')));
  assert.equal(h.calls.filter(c => c.method === 'update_snapshot').at(-1).args[3], '首领前');
  assert.equal(h.calls.filter(c => c.method === 'update_snapshot').at(-1).args[2], '原有备注');
  assert.equal(h.calls.filter(c => c.method === 'update_snapshot').at(-1).args[1], true);
  assert.equal(h.calls.filter(c => c.method === 'delete_snapshot').length, 0);
  button(`存档详情 ${saves[0].filename}`).props.onClick();
  tree = h.render(h.modal());
  h.find(tree, 'DialogButton', p => p.children.includes('删除存档')).props.onClick();
  assert.match(h.modal().props.strDescription, /只删除备份，不会删除游戏当前存档/);
  assert.equal(h.calls.filter(c => c.method === 'delete_snapshot').length, 0);
  await h.modal().props.onOK();
  assert.equal(h.calls.find(c => c.method === 'delete_snapshot').args[0], saves[0].filename);
});

test('名称保存失败时保留详情和游戏管理弹窗，可用关闭仅退出详情', async () => {
  const h = await harness({ renameFails: true }); h.manage(); await h.flush();
  h.find(h.render(), 'DialogButton', p => p['aria-label']?.startsWith('存档详情 ')).props.onClick();
  const details = h.modal();
  await h.find(h.render(details), 'DialogButton', p => p.children.includes('保存名称')).props.onClick();
  assert.ok(h.dialogs.every(d => !d.closed));
  assert.ok(h.find(h.render(details), 'p', p => p.role === 'alert'));
  h.find(h.render(details), 'DialogButton', p => p.children.includes('关闭')).props.onClick();
  assert.equal(h.dialogs.at(-1).closed, true);
  assert.equal(h.dialogs[0].closed, false);
});

test('收起侧栏清空管理页选择、路径草稿及本插件所有弹窗，重新打开仅显示首页', async () => {
  const h = await harness(); h.manage(); await h.flush();
  h.find(h.render(), 'DialogButton', p => p['aria-label']?.startsWith('存档详情 ')).props.onClick();
  h.find(h.render(h.modal()), 'DialogButton', p => p.children.includes('删除存档')).props.onClick();
  assert.equal(h.dialogs.length, 3);
  await h.tick();
  assert.ok(h.dialogs.every(d => !d.closed));
  await h.sideMenu(0);
  assert.ok(h.dialogs.every(d => d.closed));
  assert.equal(h.overlay(), null);
  assert.equal(h.calls.filter(c => c.method === 'delete_snapshot').length, 0);
  await h.sideMenu(2);
  assert.equal(h.overlay(), null);
  h.manage(); await h.flush();
  h.find(h.render(), 'DialogButton', p => p.children.includes('选择路径')).props.onClick();
  h.render(h.render()); await h.flush();
  await h.sideMenu(0); await h.sideMenu(2);
  h.manage(); await h.flush();
  assert.equal(h.render().props.strTitle, '测试游戏');
});

test('运行中详情仍可打开，禁用恢复且确认时再次检查', async () => {
  const h = await harness();
  h.manage(); await h.flush();
  h.find(h.render(), 'DialogButton', p => p['aria-label']?.startsWith('存档详情 ')).props.onClick();
  const details = h.modal();
  let tree = h.render(details);
  h.find(tree, 'DialogButton', p => p.children.includes('恢复存档')).props.onClick();
  const confirmation = h.modal();
  h.running.push({ appid: '42' });
  tree = h.render(details);
  assert.equal(h.find(tree, 'DialogButton', p => p.children.includes('恢复存档')).props.disabled, true);
  await confirmation.props.onOK();
  assert.equal(h.calls.filter(c => c.method === 'do_restore').length, 0);
});

test('管理页依次为选择路径、游戏路径、实际备份路径和逐行备份，说明删除范围', async () => {
  for (const custom of [[], [{ game_id: 42, game_name: '测试游戏', install_root: '/Steam', paths: ['/home/deck/自选槽位.sav', '/run/media/存档'] }]]) {
    const h = await harness({ custom }); h.manage(); await h.flush();
    const nodes = h.nodes(h.render());
    const choose = nodes.findIndex(n => n.type === 'DialogButton' && n.props.children.includes('选择路径'));
    const path = nodes.findIndex(n => n.type === 'div' && n.props.children.some(c => typeof c === 'string' && c.includes('存档路径：')));
    const records = nodes.findIndex(n => n.type === 'DialogButton' && n.props['aria-label']?.startsWith('存档详情 '));
    const backupPath = nodes.findIndex(n => n.type === 'div' && n.props.children.includes('备份保存路径：\n/home/deck/homebrew/data/Steamback/saves2'));
    const currentTime = nodes.findIndex(n => n.type === 'div' && n.props.children.some(c => typeof c === 'string' && c.startsWith('当前游戏存档时间：')));
    assert.ok(choose >= 0 && path > choose && backupPath > path && currentTime > backupPath && records > currentTime);
    assert.match(nodes[currentTime].props.children.join(''), /2026/);
    assert.ok(nodes.some(n => n.props?.children?.some(c => typeof c === 'string' && c.includes('删除存档只删除备份，不会删除游戏当前存档。'))));
    assert.equal(nodes[path].props.children.join(''), custom.length ? '自选存档路径：\n/home/deck/自选槽位.sav\n/run/media/存档' : '自动识别的存档路径：\n/Steam/userdata/123/42/remote\n/home/deck/游戏存档');
    h.render().props.onOK();
  }
});

test('选择存档为 Portal 样式内嵌页面，选择文件并保存，不开启自动备份', async () => {
  const h = await harness(); h.manage(); await h.flush();
  h.find(h.render(), 'DialogButton', p => p.children.includes('选择路径')).props.onClick();
  let picker = h.render();
  let panel = h.render(picker);
  await h.flush();
  panel = h.render(h.render());
  assert.equal(panel.props.strTitle, '选择游戏存档');
  const nodes = h.nodes(panel);
  const choose = nodes.findIndex(n => n.type === 'DialogButton' && n.props.children.includes('选择文件夹'));
  const path = nodes.findIndex(n => n.type === 'div' && n.props.children.includes('/home/deck/存档'));
  const file = nodes.findIndex(n => n.type === 'DialogButton' && n.props['aria-label'] === '选择文件 slot.sav');
  assert.ok(choose >= 0 && path > choose && file > path);
  nodes[file].props.onClick();
  panel = h.render(h.render());
  assert.ok(h.nodes(panel).some(n => n.props?.children?.includes('/home/deck/存档/slot.sav')));
  await panel.props.onOK();
  assert.deepEqual(Array.from(h.calls.find(c => c.method === 'set_custom_game').args[1]), ['/home/deck/存档/slot.sav']);
  assert.equal(h.calls.filter(c => c.method === 'set_game_enabled').length, 0);
  assert.equal(h.render().props.strTitle, '测试游戏');
});

test('内嵌选择草稿跨 Steam 重建保留，取消不写配置', async () => {
  const h = await harness(); h.manage(); await h.flush();
  h.find(h.render(), 'DialogButton', p => p.children.includes('选择路径')).props.onClick();
  h.render(h.render()); await h.flush();
  let panel = h.render(h.render());
  h.find(panel, 'DialogButton', p => p['aria-label'] === '选择文件 slot.sav').props.onClick();
  await h.remount();
  h.render(h.render()); await h.flush();
  panel = h.render(h.render());
  assert.ok(h.nodes(panel).some(n => n.props?.children?.includes('/home/deck/存档/slot.sav')));
  panel.props.onCancel();
  assert.equal(h.calls.filter(c => c.method === 'set_custom_game').length, 0);
});

test('游戏管理使用原生 ModalRoot，路径与列表置于可滚动区域，关闭会关闭全部本插件弹窗', async () => {
  const h = await harness(); h.manage(); await h.flush();
  const manager = h.dialogs[0];
  assert.equal(manager.closed, false);
  h.render().props.onOK();
  assert.equal(manager.closed, true);
  assert.equal(h.overlay(), null);
});
