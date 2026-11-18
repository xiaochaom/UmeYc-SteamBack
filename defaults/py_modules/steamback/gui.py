"""中文桌面界面，与 Decky 插件共用备份、固定和滚动清理逻辑。"""
import asyncio
import datetime
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog

import sv_ttk
from async_tkinter_loop import async_handler
from . import util


def saveinfo_ago_str(save):
    return datetime.datetime.fromtimestamp(save["timestamp"] / 1000).strftime("%Y-%m-%d %H:%M:%S")


class GUI:
    def __init__(self, root, engine):
        self.root = root
        self.engine = engine
        self.watcher = util.SteamWatcher(engine)
        self.saves = {}
        self.games = {}
        self.available = set()
        root.title("UmeYc-SteamBack")
        root.geometry("1150x680")
        root.minsize(900, 500)
        self.status = ttk.Label(root, text="正在识别游戏存档…", wraplength=1000)
        self.status.pack(side=tk.BOTTOM, fill=tk.X, padx=12, pady=8)
        ttk.Label(root, text="自动备份默认关闭，请按游戏开启。每款游戏保留最近 10 个普通备份，固定存档不占名额。解除固定后，下次滚动清理时再处理。",
                  wraplength=1000).pack(fill=tk.X, padx=12, pady=10)
        panels = ttk.Panedwindow(root, orient=tk.HORIZONTAL)
        panels.pack(fill=tk.BOTH, expand=True, padx=12)
        left, right = ttk.Frame(panels), ttk.Frame(panels)
        panels.add(left, weight=1)
        panels.add(right, weight=2)
        self.game_tree = self.tree(left, ("游戏", "自动备份", "识别状态"), (200, 85, 150))
        self.save_tree = self.tree(right, ("游戏", "备份时间", "类型", "备注"), (180, 165, 90, 240))
        for label, callback in [
            ("开启 / 关闭自动备份", self.toggle_game),
            ("选择存档路径", self.configure),
            ("添加游戏（输入 ID）", self.add_game),
            ("立即备份", async_handler(self.backup)),
            ("刷新列表", async_handler(self.refresh)),
        ]:
            ttk.Button(left, text=label, command=callback).pack(fill=tk.X, pady=3)
        for label, callback in [
            ("恢复所选存档 / 撤销恢复", async_handler(self.restore)),
            ("固定 / 解除固定", async_handler(self.toggle_pin)),
            ("编辑备注并固定", async_handler(self.edit_note)),
            ("删除所选备份", async_handler(self.delete)),
        ]:
            ttk.Button(right, text=label, command=callback).pack(fill=tk.X, pady=3)

    def tree(self, parent, columns, widths):
        frame = ttk.Frame(parent)
        frame.pack(fill=tk.BOTH, expand=True)
        tree = ttk.Treeview(frame, columns=columns, show="headings", selectmode="browse")
        for name, width in zip(columns, widths):
            tree.heading(name, text=name)
            tree.column(name, width=width, minwidth=60)
        bar = ttk.Scrollbar(frame, orient=tk.VERTICAL, command=tree.yview)
        tree.configure(yscrollcommand=bar.set)
        bar.pack(side=tk.RIGHT, fill=tk.Y)
        tree.pack(fill=tk.BOTH, expand=True)
        return tree

    def game(self):
        selected = self.game_tree.selection()
        if not selected:
            messagebox.showinfo("选择游戏", "请先在左侧选择游戏。", parent=self.root)
            return None
        return self.games[int(selected[0])]

    def save(self):
        selected = self.save_tree.selection()
        if not selected:
            messagebox.showinfo("选择备份", "请先在右侧选择备份。", parent=self.root)
            return None
        return self.saves[selected[0]]

    def error(self, error):
        self.status.config(text=f"操作失败：{error}")
        messagebox.showerror("操作失败", str(error), parent=self.root)

    def toggle_game(self):
        game = self.game()
        if game:
            try:
                enabled = self.engine.get_enabled_games()
                if game["game_id"] not in enabled and game["game_id"] not in self.available:
                    messagebox.showinfo("选择存档", "尚未识别到存档，请先选择文件或文件夹。", parent=self.root)
                    self.configure(game)
                    return
                self.engine.set_game_enabled(game["game_id"], game["game_id"] not in enabled)
                asyncio.create_task(self.refresh())
            except Exception as error:
                self.error(error)

    def add_game(self):
        game_id = simpledialog.askinteger("添加游戏", "输入 Steam 游戏或非 Steam 快捷方式 ID：", minvalue=1, parent=self.root)
        if game_id is None:
            return
        name = simpledialog.askstring("游戏名称", "输入游戏名称：", parent=self.root)
        if name:
            self.configure({"game_id": game_id, "game_name": name, "install_root": self.engine.get_steam_root()})

    def configure(self, game=None):
        game = game or self.game()
        if not game:
            return
        paths = list(next((g["paths"] for g in self.engine.get_custom_games() if g["game_id"] == game["game_id"]), []))
        dialog = tk.Toplevel(self.root)
        dialog.title(f'选择「{game["game_name"]}」存档')
        dialog.geometry("760x420")
        ttk.Label(dialog, text="可选择多个存档文件或文件夹。保存路径不会自动开启备份。\n移除全部路径后保存，可恢复云存档自动识别。").pack(padx=12, pady=12)
        listing = tk.Listbox(dialog)
        listing.pack(fill=tk.BOTH, expand=True, padx=12)
        for path in paths:
            listing.insert(tk.END, path)

        def add(folder):
            chosen = (filedialog.askdirectory(title="选择存档文件夹", parent=dialog) if folder else
                      filedialog.askopenfilename(title="选择存档文件", parent=dialog))
            if chosen and chosen not in listing.get(0, tk.END):
                listing.insert(tk.END, chosen)

        def manual():
            chosen = simpledialog.askstring("输入存档路径", "输入存档文件或文件夹的绝对路径：", parent=dialog)
            if chosen:
                listing.insert(tk.END, chosen)

        def remove():
            for index in reversed(listing.curselection()):
                listing.delete(index)

        def commit():
            try:
                self.engine.set_custom_game(game, list(listing.get(0, tk.END)))
                dialog.destroy()
                asyncio.create_task(self.refresh())
            except Exception as error:
                self.error(error)

        buttons = ttk.Frame(dialog)
        buttons.pack(fill=tk.X, padx=12, pady=12)
        for text, callback in [("选择文件夹", lambda: add(True)), ("选择文件", lambda: add(False)),
                               ("输入路径", manual), ("移除所选路径", remove), ("保存配置", commit), ("取消", dialog.destroy)]:
            ttk.Button(buttons, text=text, command=callback).pack(side=tk.LEFT, padx=3)

    async def backup(self):
        game = self.game()
        if game:
            try:
                saved = await self.engine.do_backup(game)
                self.status.config(text="备份完成" if saved else "暂无变化或没有可备份的文件")
                await self.refresh_saves()
            except Exception as error:
                self.error(error)

    async def restore(self):
        save = self.save()
        if not save:
            return
        if save["game_info"]["game_id"] in util.find_running_games():
            messagebox.showinfo("请先退出游戏", "游戏运行期间不能恢复存档。", parent=self.root)
            return
        if not messagebox.askyesno("恢复存档", f'将「{save["game_info"]["game_name"]}」恢复至 {saveinfo_ago_str(save)}？\n恢复前会生成可撤销备份。', parent=self.root):
            return
        try:
            await self.engine.do_restore(save)
            self.status.config(text="存档已恢复")
            await self.refresh_saves()
        except Exception as error:
            self.error(error)

    async def toggle_pin(self):
        save = self.save()
        if save and not save["is_undo"]:
            try:
                await self.engine.update_snapshot(save["filename"], not save["pinned"], save["note"])
                await self.refresh_saves()
            except Exception as error:
                self.error(error)

    async def edit_note(self):
        save = self.save()
        if save and not save["is_undo"]:
            note = simpledialog.askstring("固定存档备注", "输入备注（最多 500 字）：", initialvalue=save["note"], parent=self.root)
            if note is not None:
                try:
                    await self.engine.update_snapshot(save["filename"], True, note)
                    await self.refresh_saves()
                except Exception as error:
                    self.error(error)

    async def delete(self):
        save = self.save()
        if save and messagebox.askyesno("删除备份", f'确定删除「{save["game_info"]["game_name"]}」在 {saveinfo_ago_str(save)} 的{"固定" if save["pinned"] else ""}备份吗？\n此操作无法撤销，游戏当前存档不受影响。', parent=self.root):
            try:
                await self.engine.delete_snapshot(save["filename"])
                await self.refresh_saves()
            except Exception as error:
                self.error(error)

    async def refresh_saves(self):
        selected = self.save_tree.selection()
        saves = await self.engine.get_saveinfos()
        saves.sort(key=lambda s: (not s["pinned"], -s["timestamp"]))
        self.saves = {s["filename"]: s for s in saves}
        self.save_tree.delete(*self.save_tree.get_children())
        for save in saves:
            self.save_tree.insert("", tk.END, iid=save["filename"], values=(
                save["game_info"]["game_name"], saveinfo_ago_str(save),
                "固定存档" if save["pinned"] else "撤销备份" if save["is_undo"] else "滚动备份", save["note"]))
        if selected and selected[0] in self.saves:
            self.save_tree.selection_set(selected)

    async def refresh(self):
        try:
            selected = self.game_tree.selection()
            games = {g["game_id"]: g for g in self.engine.find_all_game_info()}
            games.update({g["game_id"]: g for g in self.engine.get_custom_games()})
            self.games = games
            self.engine.all_games = games
            supported = await self.engine.find_supported(list(games.values()))
            self.available = {g["game_id"] for g in supported}
            enabled = self.engine.get_enabled_games()
            self.game_tree.delete(*self.game_tree.get_children())
            for game in sorted(games.values(), key=lambda g: g["game_name"]):
                self.game_tree.insert("", tk.END, iid=str(game["game_id"]), values=(
                    game["game_name"], "已开启" if game["game_id"] in enabled else "已关闭",
                    "已识别" if game["game_id"] in self.available else "请自行选择存档"))
            if selected and int(selected[0]) in games:
                self.game_tree.selection_set(selected)
            await self.refresh_saves()
            self.status.config(text="正在监测已开启备份的游戏…")
        except Exception as error:
            self.error(error)

    async def run(self):
        await self.refresh()
        async def watch():
            while True:
                await asyncio.sleep(5)
                try:
                    result = await self.watcher.check_once()
                    if result.backed_up:
                        await self.refresh_saves()
                        self.status.config(text="游戏已退出，自动备份完成")
                except Exception as error:
                    self.status.config(text=f"自动备份失败：{error}")
        task = asyncio.create_task(watch())
        try:
            while self.root.winfo_exists():
                self.root.update()
                await asyncio.sleep(0.05)
        except tk.TclError:
            pass
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def run(engine):
    root = tk.Tk()
    sv_ttk.set_theme("dark")
    gui = GUI(root, engine)
    asyncio.run(gui.run())
