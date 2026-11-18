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
        case 'get_path_context': return { home: '/home/deck', steam_root: '/Steam' };
        case 'set_account_id': return null;
        case 'find_mounted': return ['/Steam'];
        case 'get_custom_games': return custom;
        case 'set_custom_game': custom = [{ ...args[0], paths: args[1] }]; return custom[0];
        case 'list_save_files': return { directory: '/home/deck/存档', parent: '/home/deck', entries: [{ name: 'slot.sav', path: '/home/deck/存档/slot.sav', directory: false }, { name: '子目录', path: '/home/deck/存档/子目录', directory: true }], truncated: false };
        case 'find_supported': return [{ ...args[0][0], save_games_roots: { '/Steam/userdata/123/42/remote': '', '/home/deck/游戏存档': '_1' } }];
        case 'get_saveinfos': return saves.map(s => ({ ...s }));
        case 'do_backup': return saves[0];
        case 'update_snapshot': { const i = saves.findIndex(s => s.filename === args[0]); saves[i] = { ...saves[i], pinned: args[1], note: args[2], ...(args[3] === undefined ? {} : { name: args[3] }) }; return saves[i]; }
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
      dialogs.push(result);
      return result;
    },
  }, { get: (object, key) => object[key] ?? key });
  const context = vm.createContext({
    console, SP_REACT: react, DFL: dfl,
    window: { innerWidth: options.width || 854, innerHeight: 534, SP_REACT: react,
      SteamUIStore: { WindowStore: { GamepadUIMainWindowInstance: { MenuStore: menuStore } } },
      setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); },
      __DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit: { connect: () => api } },
    App: { m_CurrentUser: { strSteamID: '76561197960265851' } },
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
  render();
  effects.splice(0).forEach(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  function manage() {
    find(render(plugin.content), 'ButtonItem', p => p['aria-label'] === '打开游戏存档 42').props.onClick();
    const overlay = globalComponent();
    const left = render(overlay);
    page = left.props.children[0];
    render();
  }
  async function remount() {
    components.clear();
    render();
    effects.splice(0).forEach(effect => effect());
    await new Promise(resolve => setImmediate(resolve));
  }
  async function flush() { effects.splice(0).forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve)); }
  function leftBounds() {
    const overlay = render(globalComponent());
    return render(overlay).props.style;
  }
  return { render, find, nodes, calls, listener, running, manage, remount, flush, leftBounds, modal: () => modal, dialogs,
    async sideMenu(value) { if (value === 0) menuStore.CloseSideMenus(); else menu = value; timers.forEach(fn => fn()); await flush(); },
    async tick() { timers.forEach(fn => fn()); await flush(); },
    overlay: () => render(globalComponent()),
    button: (tree, label) => find(tree, 'ButtonItem', p => p.children.includes(label)) };
}

test('首页仅刷新与游戏列表，点击游戏打开独立左侧存档页，仅手动备份', async () => {
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
  let tree = h.render(details);
  h.find(tree, 'TextField', p => p.label.startsWith('存档名称')).props.onChange({ target: { value: '首领前' } });
  assert.equal(h.find(tree, 'TextField', p => p.label.startsWith('备注')), undefined);
  const column = h.find(tree, 'Focusable', p => p.style?.flexDirection === 'column');
  assert.equal(column.props.style.gap, 12);
  const rowsOfActions = h.nodes(tree).filter(n => n.type === 'Focusable' && n.props['flow-children'] === 'row');
  assert.deepEqual(rowsOfActions.map(row => h.nodes(row).filter(n => n.type === 'DialogButton').map(n => n.props.children.join(''))),
    [['恢复存档', '删除存档'], ['保存名称', '关闭']]);
  tree = h.render(details);
  await h.find(tree, 'DialogButton', p => p.children.includes('保存名称')).props.onClick();
  assert.equal(h.calls.filter(c => c.method === 'update_snapshot').at(-1).args[3], '首领前');
  assert.equal(h.calls.filter(c => c.method === 'update_snapshot').at(-1).args[2], '原有备注');
  assert.equal(h.calls.filter(c => c.method === 'update_snapshot').at(-1).args[1], true);
  assert.equal(h.calls.filter(c => c.method === 'delete_snapshot').length, 0);
  button(`存档详情 ${saves[0].filename}`).props.onClick();
  tree = h.render(h.modal());
  h.find(tree, 'DialogButton', p => p.children.includes('删除存档')).props.onClick();
  assert.equal(h.calls.filter(c => c.method === 'delete_snapshot').length, 0);
  await h.modal().props.onOK();
  assert.equal(h.calls.find(c => c.method === 'delete_snapshot').args[0], saves[0].filename);
});

test('收起侧栏清空左侧选择、路径草稿及本插件所有弹窗，重新打开仅显示首页', async () => {
  const h = await harness(); h.manage(); await h.flush();
  h.find(h.render(), 'DialogButton', p => p['aria-label']?.startsWith('存档详情 ')).props.onClick();
  h.find(h.render(h.modal()), 'DialogButton', p => p.children.includes('删除存档')).props.onClick();
  assert.equal(h.dialogs.length, 2);
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

test('管理页依次为选择路径、完整路径和逐行备份，自动与自选路径可区分', async () => {
  for (const custom of [[], [{ game_id: 42, game_name: '测试游戏', install_root: '/Steam', paths: ['/home/deck/自选槽位.sav', '/run/media/存档'] }]]) {
    const h = await harness({ custom }); h.manage(); await h.flush();
    const nodes = h.nodes(h.render());
    const choose = nodes.findIndex(n => n.type === 'DialogButton' && n.props.children.includes('选择路径'));
    const path = nodes.findIndex(n => n.type === 'div' && n.props.children.some(c => typeof c === 'string' && c.includes('存档路径：')));
    const records = nodes.findIndex(n => n.type === 'DialogButton' && n.props['aria-label']?.startsWith('存档详情 '));
    assert.ok(choose >= 0 && path > choose && records > path);
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

test('左侧面板使用实际 CSS 视口，与 Decky 边界相接，不留黑边', async () => {
  for (const width of [854, 1280, 600]) {
    const h = await harness({ width: 1, mainWidth: width });
    h.manage(); await h.flush();
    const style = h.leftBounds();
    assert.equal(style.left, 0);
    assert.equal(style.width + 348, width);
    assert.equal(style.height, 534);
  }
});
