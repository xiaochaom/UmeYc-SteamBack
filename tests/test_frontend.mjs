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
  const calls = [];
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
      if (!(index in current.values)) current.values[index] = initial;
      const state = current;
      return [state.values[index], value => {
        state.values[index] = typeof value === 'function' ? value(state.values[index]) : value;
      }];
    },
    useEffect(effect) { if (!current.mounted) effects.push(effect); },
  };
  const api = {
    _version: 2,
    toaster: { toast() {} },
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
    quickAccessMenuClasses: { Title: 'title' }, Router: { RunningApps: running },
    showModal(element) { modal = element; },
  }, { get: (object, key) => object[key] ?? key });
  const context = vm.createContext({
    console, SP_REACT: react, DFL: dfl,
    window: { SP_REACT: react, setInterval() { return 1; }, clearInterval() {},
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
  function render(element = plugin.content) {
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
    find(render(), 'ButtonItem', p => p.children.includes('管理存档')).props.onClick();
  }
  async function remount() {
    components.clear();
    render();
    effects.splice(0).forEach(effect => effect());
    await new Promise(resolve => setImmediate(resolve));
  }
  async function flush() { effects.splice(0).forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve)); }
  return { render, find, nodes, calls, listener, running, manage, remount, flush, modal: () => modal,
    button: (tree, label) => find(tree, 'ButtonItem', p => p.children.includes(label)) };
}

test('只读路径分组及手动备份，没有生命周期监听或自动开关', async () => {
  const h = await harness();
  let tree = h.render();
  assert.ok(h.find(tree, 'PanelSection', p => p.title === '已找到存档路径（1）'));
  assert.ok(h.find(tree, 'PanelSection', p => p.title === '待选择存档路径（1）'));
  h.button(tree, '展开游戏列表 ▾').props.onClick();
  tree = h.render();
  const text = h.nodes(tree).flatMap(n => n.props?.children || []).filter(c => typeof c === 'string');
  assert.ok(text.includes('自动识别的存档路径：\n/Steam/userdata/123/42/remote\n/home/deck/游戏存档'));
  assert.ok(text.includes('未找到存档路径，请自行选择'));
  assert.equal(h.nodes(tree).filter(n => n.type === 'ToggleField').length, 0);
  assert.equal(h.listener, undefined);
  assert.equal(h.calls.filter(c => c.method === 'do_backup').length, 0);
  h.manage();
  await h.button(h.render(), '立即备份').props.onClick();
  const backup = h.calls.find(c => c.method === 'do_backup');
  assert.equal(backup.args[0].game_id, 42);
  assert.equal(backup.args.length, 2);
});

test('逐行固定且置顶，详情弹窗重命名、备注及确认删除都作用于对应记录', async () => {
  const saves = [1, 2, 3].map(i => ({ filename: `save_42_${1770000000000 + i}`, timestamp: 1770000000000 + i,
    game_info: { game_id: 42, game_name: '测试游戏', install_root: '/Steam' }, pinned: false, note: '', is_undo: false }));
  const h = await harness({ saves });
  h.manage();
  const button = (label) => h.find(h.render(), 'DialogButton', p => p['aria-label'] === label);
  await button(`固定 ${saves[0].filename}`).props.onClick();
  let rows = h.nodes(h.render()).filter(n => n.type === 'DialogButton' && n.props['aria-label']?.startsWith('存档详情 '));
  assert.equal(rows[0].props['aria-label'], `存档详情 ${saves[0].filename}`);
  assert.equal(rows[1].props['aria-label'], `存档详情 ${saves[2].filename}`);
  button(`存档详情 ${saves[0].filename}`).props.onClick();
  const details = h.modal();
  let tree = h.render(details);
  h.find(tree, 'TextField', p => p.label.startsWith('存档名称')).props.onChange({ target: { value: '首领前' } });
  h.find(tree, 'TextField', p => p.label.startsWith('备注')).props.onChange({ target: { value: '保留这份进度' } });
  tree = h.render(details);
  await h.find(tree, 'DialogButton', p => p.children.includes('保存名称与备注')).props.onClick();
  assert.equal(h.calls.filter(c => c.method === 'update_snapshot').at(-1).args[3], '首领前');
  assert.ok(h.nodes(h.render()).some(n => n.props?.children?.includes('保留这份进度')));
  await button(`解除固定 ${saves[0].filename}`).props.onClick();
  assert.equal(h.calls.filter(c => c.method === 'delete_snapshot').length, 0);
  button(`存档详情 ${saves[0].filename}`).props.onClick();
  tree = h.render(h.modal());
  h.find(tree, 'DialogButton', p => p.children.includes('删除此存档')).props.onClick();
  assert.equal(h.calls.filter(c => c.method === 'delete_snapshot').length, 0);
  await h.modal().props.onOK();
  assert.equal(h.calls.find(c => c.method === 'delete_snapshot').args[0], saves[0].filename);
});

test('运行中详情仍可打开，禁用恢复且确认时再次检查', async () => {
  const h = await harness();
  h.manage();
  h.find(h.render(), 'DialogButton', p => p['aria-label']?.startsWith('存档详情 ')).props.onClick();
  const details = h.modal();
  let tree = h.render(details);
  h.find(tree, 'DialogButton', p => p.children.includes('恢复此存档')).props.onClick();
  const confirmation = h.modal();
  h.running.push({ appid: '42' });
  tree = h.render(details);
  assert.equal(h.find(tree, 'DialogButton', p => p.children.includes('恢复此存档')).props.disabled, true);
  await confirmation.props.onOK();
  assert.equal(h.calls.filter(c => c.method === 'do_restore').length, 0);
});

test('管理页依次为选择路径、完整路径和逐行备份，自动与自选路径可区分', async () => {
  for (const custom of [[], [{ game_id: 42, game_name: '测试游戏', install_root: '/Steam', paths: ['/home/deck/自选槽位.sav', '/run/media/存档'] }]]) {
    const h = await harness({ custom }); h.manage();
    const nodes = h.nodes(h.render());
    const choose = nodes.findIndex(n => n.type === 'DialogButton' && n.props.children.includes('选择路径'));
    const path = nodes.findIndex(n => n.type === 'div' && n.props.children.some(c => typeof c === 'string' && c.includes('存档路径：')));
    const records = nodes.findIndex(n => n.type === 'DialogButton' && n.props['aria-label']?.startsWith('存档详情 '));
    assert.ok(choose >= 0 && path > choose && records > path);
    assert.equal(nodes[path].props.children.join(''), custom.length ? '自选存档路径：\n/home/deck/自选槽位.sav\n/run/media/存档' : '自动识别的存档路径：\n/Steam/userdata/123/42/remote\n/home/deck/游戏存档');
    h.button(h.render(), '返回游戏列表').props.onClick();
    assert.ok(h.find(h.render(), 'PanelSection', p => p.title === '已找到存档路径（1）'));
  }
});

test('选择存档为 Portal 样式内嵌页面，选择文件并保存，不开启自动备份', async () => {
  const h = await harness(); h.manage();
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
  assert.ok(h.button(h.render(), '返回游戏列表'));
});

test('内嵌选择草稿跨 Steam 重建保留，取消不写配置', async () => {
  const h = await harness(); h.manage();
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
