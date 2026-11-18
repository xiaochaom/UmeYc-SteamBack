import psutil
import re

from . import Engine

"""Create a game info object: contains game_id and install_root
"""


def make_game_info(p: Engine, game_id: int) -> dict:
    # we try to use the version in the engine if possible - because it has fully validated info
    info = (p.all_games or {}).get(game_id, None)
    if not info:
        info = next((g for g in p.get_custom_games() if g["game_id"] == game_id), None)

    if not info:
        print(f'未找到游戏 {game_id} 的信息，尝试使用默认 Steam 路径')
        info = {
            # On a real steamdeck there may be multiple install_roots (main vs sdcard etc) (but only one per game)
            "install_root": p.get_steam_root(),
            "game_id": game_id,
            "game_name": f"游戏 {game_id}"
        }

    return info


"""Find running steam games and return their game IDs (only used on linux desktops - not used in decky)

Look for processes with names like this to find running steam games.  Remove any duplicates.
home.../.steam/debian-installation/ubuntu12_32/reaper SteamLaunch AppId=1318690 ...
"""


def find_running_games() -> list[int]:
    # also available in environ['SteamGameId']
    appMatch = re.compile('AppId=(.+)')
    # steam username is in environ['SteamAppUser']

    """Get the game id from a process, or None if process is not a game"""
    def get_game_id(p: psutil.Process) -> int:
        line = p.cmdline()
        if len(line) >= 3 and line[1] == "SteamLaunch":
            # environ = p.environ()
            match = appMatch.fullmatch(line[2])
            if match:
                return int(match.group(1))
        return None

    r = []
    for proc in psutil.process_iter():
        try:
            id = get_game_id(proc)
            if id:
                r.append(id)
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            pass  # Windows won't let us see some processes
    return r
