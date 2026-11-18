// 对真实构建产物提供最小 Decky/React 宿主，验证界面状态与 RPC 行为。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const bundle = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8')
  .replace('export { index as default };', 'globalThis.loadPlugin = index;');

async function harness(options = {}) {
  let enabled = [];
  let modal;
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
        case 'get_custom_games': return options.custom || [];
        case 'get_enabled_games': return [...enabled];
        case 'set_game_enabled': enabled = args[1] ? [args[0]] : []; return [...enabled];
        case 'find_supported': return [{ ...args[0][0], save_games_roots: { '/Steam/userdata/123/42/remote': '', '/home/deck/游戏存档': '_1' } }];
        case 'get_saveinfos': return saves.map(s => ({ ...s }));
        case 'do_backup': return saves[0];
        case 'update_snapshot': saves[0] = { ...saves[0], pinned: args[1], note: args[2] }; return saves[0];
        case 'delete_snapshot': saves = []; return true;
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
    find(render(), 'ButtonItem', p => p.children.includes('展开游戏列表 ▾')).props.onClick();
    find(render(), 'ButtonItem', p => p.children.includes('管理存档')).props.onClick();
  }
  return { render, find, nodes, calls, listener, running, manage, modal: () => modal,
    button: (tree, label) => find(tree, 'ButtonItem', p => p.children.includes(label)) };
}

test('默认全关，显示分组数量，展开后可见开关和非 Steam 游戏', async () => {
  const h = await harness();
  let tree = h.render();
  assert.ok(h.find(tree, 'PanelSection', p => p.title === '已开启自动备份（0）'));
  assert.ok(h.find(tree, 'PanelSection', p => p.title === '未开启自动备份（2）'));
  h.button(tree, '展开游戏列表 ▾').props.onClick();
  tree = h.render();
  assert.equal(h.find(tree, 'ToggleField', p => p.label === '测试游戏').props.checked, false);
  assert.equal(h.find(tree, 'ToggleField', p => p.label === '非 Steam 游戏').props.disabled, true);
  const text = h.nodes(tree).flatMap(n => n.props?.children || []).filter(c => typeof c === 'string');
  assert.ok(text.includes('自动识别的存档路径：\n/Steam/userdata/123/42/remote\n/home/deck/游戏存档'));
  assert.ok(text.includes('未找到存档路径，请自行选择'));
  await h.find(tree, 'ToggleField', p => p.label === '测试游戏').props.onChange(true);
  tree = h.render();
  assert.ok(h.find(tree, 'PanelSection', p => p.title === '已开启自动备份（1）'));
  assert.equal(h.find(tree, 'ToggleField', p => p.label === '测试游戏').props.checked, true);
});

test('生命周期事件仅为已开启的游戏发起自动备份', async () => {
  const h = await harness();
  await h.listener({ unAppID: 42, bRunning: false });
  assert.equal(h.calls.filter(c => c.method === 'do_backup').length, 0);
  let tree = h.render();
  h.button(tree, '展开游戏列表 ▾').props.onClick();
  await h.find(h.render(), 'ToggleField', p => p.label === '测试游戏').props.onChange(true);
  await h.listener({ unAppID: 42, bRunning: false });
  const call = h.calls.find(c => c.method === 'do_backup');
  assert.equal(call.args[0].game_id, 42);
  assert.equal(call.args[2], true);
});

test('固定与解除固定只更新元数据，删除固定备份先确认', async () => {
  const h = await harness();
  h.manage();
  await h.button(h.render(), '固定存档').props.onClick();
  let tree = h.render();
  assert.ok(h.button(tree, '解除固定'));
  assert.ok(h.nodes(tree).some(n => n.props?.children?.some(c => typeof c === 'string' && c.includes('备份时间：'))));
  await h.button(tree, '解除固定').props.onClick();
  assert.equal(h.calls.filter(c => c.method === 'delete_snapshot').length, 0);
  await h.button(h.render(), '固定存档').props.onClick();
  h.button(h.render(), '删除备份').props.onClick();
  assert.ok(h.modal().props.strDescription.includes('固定备份'));
  assert.equal(h.calls.filter(c => c.method === 'delete_snapshot').length, 0);
  await h.modal().props.onOK();
  assert.equal(h.calls.filter(c => c.method === 'delete_snapshot').length, 1);
});

test('运行中的游戏禁用恢复，并在确认操作时再次检查', async () => {
  const h = await harness();
  h.manage();
  const before = h.button(h.render(), '恢复');
  before.props.onClick();
  h.running.push({ appid: '42' });
  assert.equal(h.button(h.render(), '恢复').props.disabled, true);
  await h.modal().props.onOK();
  assert.equal(h.calls.filter(c => c.method === 'do_restore').length, 0);
});

test('管理页依次显示选择路径、完整路径和备份选择，自动与自选路径可区分', async () => {
  for (const custom of [[], [{ game_id: 42, game_name: '测试游戏', install_root: '/Steam', paths: ['/home/deck/自选槽位.sav', '/run/media/存档'] }]]) {
    const h = await harness({ custom });
    h.manage();
    const tree = h.render();
    const nodes = h.nodes(tree);
    const choose = nodes.findIndex(n => n.type === 'DialogButton' && n.props.children.includes('选择路径'));
    const path = nodes.findIndex(n => n.type === 'div' && n.props.children.some(c => typeof c === 'string' && c.includes('存档路径：')));
    const selector = nodes.findIndex(n => n.type === 'Dropdown' && n.props.menuLabel === '选择备份记录');
    assert.ok(choose >= 0 && path > choose && selector > path);
    const text = nodes[path].props.children.join('');
    assert.equal(text, custom.length ? '自选存档路径：\n/home/deck/自选槽位.sav\n/run/media/存档' : '自动识别的存档路径：\n/Steam/userdata/123/42/remote\n/home/deck/游戏存档');
    assert.ok(h.button(tree, '恢复'));
    h.button(tree, '返回游戏列表').props.onClick();
    assert.ok(h.find(h.render(), 'PanelSection', p => p.title === '未开启自动备份（2）'));
  }
});
