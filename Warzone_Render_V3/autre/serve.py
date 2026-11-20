# WARZONE RENDER V2 - serveur multijoueur (Python pur, aucun module a installer)
import http.server, socketserver, os, sys, json, threading, webbrowser, socket, base64, hashlib, struct, time
import re, collections, subprocess, shutil, platform, random, atexit, uuid, math, ipaddress, hmac, shlex, secrets, io, zipfile, stat, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ALLOWED = ("mods", "texturepacks", "shaders")
PORT = int(os.environ.get("PORT", 8000))
MAGIC = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
BANFILE = os.path.join(HERE, "bans.json")
REPORTFILE = os.path.join(HERE, "player_reports.json")
REPORTFILE_LEGACY = REPORTFILE
MUTEFILE = os.path.join(HERE, "mutes.json")
SERVER_META_FILE = os.path.join(HERE, "server_meta.json")
REMINDERFILE = os.path.join(HERE, "server_reminders.json")
INSTANCE_ID = uuid.uuid4().hex[:12]  # chaque demarrage cree une nouvelle instance
SERVER_NAME = "WARZONE RENDER V2"
SERVER_ID = ""
NAMES = {}   # pseudos gardes uniquement en memoire pour cette instance
ADMINS = set()  # roles admin valables uniquement pour cette instance
ADMIN_LOGIN_STATE = {}  # echecs et blocages temporaires par IP
RESOURCE_UPLOAD_TOKENS = {}  # jetons temporaires lies a une session admin WebSocket
RESOURCE_STATE_FILE = os.path.join(ROOT, "resource_state.json")
RESOURCE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024

LOCK = threading.RLock()
PLAYERS = {}                       # id -> dict joueur
NEXT_ID = [1]
CFG = {"max": 16, "dmg": 1.0, "locked": False, "pvp": True, "bots": True,
       "spawn_allowed": True, "max_bots": 12, "bot_damage": 10.0,
       "spawn_cooldown": 15,
       "resources": {"shaders": [], "packs": [], "mods": []}}
BOTS = {}
NEXT_BOT = [1]
WORLD_WEAPON = None  # une seule arme partagee au sol pour tous les joueurs
BOT_SPAWN_LAST = {}  # jeton joueur -> dernier spawn autorise (limite anti-contournement reconnexion)
BANS = []                          # {"name","ip","token","when","reason"}
MUTES = []                         # sanctions de chat persistantes pour ce dossier serveur
REPORTS = []                       # signalements /report conserves dans le dossier serveur
REMINDERS = []                     # rappels serveur affiches a tous les joueurs
NEXT_REMINDER_ID = [1]
EVENTS = collections.deque(maxlen=10)
TUNNEL = {"url": None, "state": "", "log": collections.deque(maxlen=8), "proc": None}
LOOPBACK = ("127.0.0.1", "::1")
ITEMS = ("ammo", "plate", "stim", "weapon", "health", "kit")


def save_resource_state():
    """Sauvegarde la selection de ressources partagee par tous les joueurs."""
    try:
        os.makedirs(ROOT, exist_ok=True)
        tmp = RESOURCE_STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(CFG.get("resources", {}), f, ensure_ascii=False, indent=2)
        os.replace(tmp, RESOURCE_STATE_FILE)
    except Exception as exc:
        ev("Sauvegarde ressources impossible : %s" % str(exc)[:120])


def load_resource_state():
    """Recharge les ressources actives depuis le fichier de l'instance."""
    try:
        with open(RESOURCE_STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            cleaned = {}
            for cat in ("shaders", "packs", "mods"):
                values = data.get(cat, [])
                if not isinstance(values, list): values = []
                cleaned[cat] = [str(x)[:100] for x in values[:100]
                                if re.match(r"^[A-Za-z0-9_. -]+$", str(x)) and ".." not in str(x)]
            CFG["resources"] = cleaned
    except FileNotFoundError:
        pass
    except Exception as exc:
        ev("Chargement ressources impossible : %s" % str(exc)[:120])


def issue_resource_upload_token(p):
    """Emet un jeton court pour un joueur admin ou authentifie par le code console."""
    if not (p.get("admin") or p.get("console_admin")):
        return None
    token = secrets.token_urlsafe(32)
    RESOURCE_UPLOAD_TOKENS[token] = {"pid": p.get("id"), "expires": time.time() + 1800}
    return token


def resource_upload_authorized(token):
    info = RESOURCE_UPLOAD_TOKENS.get(str(token or ""))
    if not info:
        return False
    if info.get("expires", 0) < time.time():
        RESOURCE_UPLOAD_TOKENS.pop(str(token), None)
        return False
    player = PLAYERS.get(info.get("pid"))
    return bool(player and (player.get("admin") or player.get("console_admin")))


def safe_resource_stem(filename):
    raw = os.path.basename(str(filename or "").replace("\\", "/"))
    stem = os.path.splitext(raw)[0]
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", stem).strip("_-.")[:60]
    return stem or "ressource"


def refresh_resource_lists_after_upload(category, item_name):
    resources = CFG.setdefault("resources", {"shaders": [], "packs": [], "mods": []})
    key = {"shaders": "shaders", "mods": "mods", "packs": "packs"}[category]
    values = resources.setdefault(key, [])
    if item_name not in values:
        values.append(item_name)
    resources[key] = values[:100]
    save_resource_state()
    broadcast({"t": "resources", "data": dict(resources)})
    ev("Ressource importee sur le serveur : %s (%s)" % (item_name, category))


def store_uploaded_resource(category, filename, payload):
    """Valide et stocke un shader, un mod ou un pack ZIP sur le disque serveur."""
    if not isinstance(payload, (bytes, bytearray)) or not payload:
        raise ValueError("Le fichier est vide.")
    if len(payload) > RESOURCE_UPLOAD_MAX_BYTES:
        raise ValueError("Fichier trop volumineux (32 Mo maximum).")
    filename = urllib.parse.unquote(str(filename or "fichier"))
    base_name = os.path.basename(filename.replace("\\", "/"))
    ext = os.path.splitext(base_name)[1].lower()
    os.makedirs(ROOT, exist_ok=True)

    if category == "shaders":
        if ext not in (".frag", ".glsl"):
            raise ValueError("Un shader doit etre un fichier .frag ou .glsl.")
        if len(payload) > 2 * 1024 * 1024:
            raise ValueError("Un shader ne peut pas depasser 2 Mo.")
        stem = safe_resource_stem(base_name)
        final_name = stem + ext
        folder = os.path.join(ROOT, "shaders")
        os.makedirs(folder, exist_ok=True)
        destination = os.path.join(folder, final_name)
        if os.path.exists(destination):
            raise ValueError("Un shader portant deja ce nom existe.")
        with open(destination, "xb") as f: f.write(payload)
        refresh_resource_lists_after_upload("shaders", final_name)
        return {"category": category, "filename": final_name, "resources": dict(CFG["resources"]),
                "message": "Shader importe et active pour tous les joueurs connectes."}

    if category == "mods":
        if ext != ".js":
            raise ValueError("Un mod doit etre un fichier .js.")
        if len(payload) > 5 * 1024 * 1024:
            raise ValueError("Un mod ne peut pas depasser 5 Mo.")
        stem = safe_resource_stem(base_name)
        final_name = stem + ".js"
        folder = os.path.join(ROOT, "mods")
        os.makedirs(folder, exist_ok=True)
        destination = os.path.join(folder, final_name)
        if os.path.exists(destination):
            raise ValueError("Un mod portant deja ce nom existe.")
        with open(destination, "xb") as f: f.write(payload)
        refresh_resource_lists_after_upload("mods", final_name)
        return {"category": category, "filename": final_name, "resources": dict(CFG["resources"]),
                "message": "Mod importe et active pour tous les joueurs. Recharge le jeu pour l'executer."}

    if category == "packs":
        if ext != ".zip":
            raise ValueError("Un pack de textures doit etre importe en archive .zip.")
        stem = safe_resource_stem(base_name)
        parent = os.path.join(ROOT, "texturepacks")
        os.makedirs(parent, exist_ok=True)
        pack_id = stem
        suffix = 2
        while os.path.exists(os.path.join(parent, pack_id)):
            pack_id = "%s_%d" % (stem, suffix); suffix += 1
        destination = os.path.abspath(os.path.join(parent, pack_id))
        os.makedirs(destination, exist_ok=False)
        try:
            with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
                infos = [i for i in archive.infolist() if not i.is_dir()]
                if not infos or len(infos) > 300:
                    raise ValueError("Archive vide ou contenant trop de fichiers (300 maximum).")
                total = sum(int(i.file_size) for i in infos)
                if total > 100 * 1024 * 1024:
                    raise ValueError("Le pack decompresse depasse 100 Mo.")
                paths = []
                for info in infos:
                    raw = info.filename.replace("\\", "/")
                    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
                        raise ValueError("Chemin interdit dans le ZIP.")
                    parts = [part for part in raw.split("/") if part not in ("", ".")]
                    if not parts or any(part == ".." for part in parts):
                        raise ValueError("Chemin interdit dans le ZIP.")
                    mode = (info.external_attr >> 16) & 0xFFFF
                    if stat.S_ISLNK(mode):
                        raise ValueError("Les liens symboliques sont interdits dans un pack.")
                    suffix_ext = os.path.splitext(parts[-1])[1].lower()
                    allowed = suffix_ext in (".png", ".jpg", ".jpeg", ".webp", ".json", ".css") or parts[-1].lower() == "ui.js"
                    if not allowed:
                        raise ValueError("Type de fichier interdit dans le pack : %s" % parts[-1])
                    paths.append((info, parts))
                # Retire le dossier racine unique souvent ajoute par les outils ZIP.
                first = {parts[0] for _, parts in paths if parts}
                has_root_files = any(len(parts) == 1 for _, parts in paths)
                strip_root = next(iter(first)) if len(first) == 1 and not has_root_files else None
                written = []
                for info, parts in paths:
                    if strip_root and parts[0] == strip_root:
                        parts = parts[1:]
                    if not parts:
                        continue
                    target = os.path.abspath(os.path.join(destination, *parts))
                    if os.path.commonpath([destination, target]) != destination:
                        raise ValueError("Chemin d'extraction invalide.")
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    data = archive.read(info)
                    if len(data) != info.file_size:
                        raise ValueError("Archive ZIP incomplete.")
                    with open(target, "xb") as f: f.write(data)
                    written.append("/".join(parts))
                manifest_path = os.path.join(destination, "pack.json")
                if not os.path.isfile(manifest_path):
                    raise ValueError("Le ZIP doit contenir un fichier pack.json a sa racine.")
                with open(manifest_path, "r", encoding="utf-8-sig") as f:
                    manifest = json.load(f)
                if not isinstance(manifest, dict):
                    raise ValueError("Le pack.json doit contenir un objet JSON.")
                if not (manifest.get("textures") or manifest.get("sky") or manifest.get("ui")):
                    raise ValueError("Le pack.json ne declare aucune texture, sky ou interface.")
        except Exception:
            shutil.rmtree(destination, ignore_errors=True)
            raise
        refresh_resource_lists_after_upload("packs", pack_id)
        return {"category": category, "filename": pack_id, "resources": dict(CFG["resources"]),
                "message": "Pack de textures importe et active pour tous les joueurs connectes."}

    raise ValueError("Categorie d'importation inconnue.")


def now(): return time.strftime("%H:%M:%S")
def ev(s): EVENTS.append("%s  %s" % (now(), s))

def load_server_meta():
    global SERVER_NAME, SERVER_ID, REPORTFILE
    data = {}
    try:
        with open(SERVER_META_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        pass
    if not isinstance(data, dict): data = {}
    SERVER_NAME = str(data.get("name") or "WARZONE RENDER V2")[:48].strip() or "WARZONE RENDER V2"
    SERVER_ID = str(data.get("id") or uuid.uuid4().hex[:12])[:32]
    REPORTFILE = os.path.join(HERE, "player_reports_%s_%d.json" % (SERVER_ID, PORT))
    if not os.path.exists(REPORTFILE) and os.path.exists(REPORTFILE_LEGACY):
        try: os.replace(REPORTFILE_LEGACY, REPORTFILE)
        except Exception: pass
    save_server_meta()

def save_server_meta():
    try:
        with open(SERVER_META_FILE + ".tmp", "w", encoding="utf-8") as f:
            json.dump({"id": SERVER_ID, "name": SERVER_NAME}, f, ensure_ascii=False, indent=2)
        os.replace(SERVER_META_FILE + ".tmp", SERVER_META_FILE)
    except Exception as e:
        ev("Sauvegarde nom serveur impossible : %s" % e)

def is_in_admin_base(pos):
    try:
        x, z = float(pos[0]), float(pos[2])
        return (x * x + (z - 70.0) * (z - 70.0)) <= (12.0 * 12.0)
    except Exception:
        return False

def player_in_admin_base(p):
    return is_in_admin_base(((p.get("state") or {}).get("p") or [9999, 0, 9999]))

def player_hidden(p):
    return bool(p.get("vanish") or p.get("ghost") or p.get("freecam"))

def sync_player_visibility(p):
    """Actualise le roster filtre et le modele distant pour chaque role."""
    push_roster()
    psend(p, {"t": "admin_mode", "vanish": bool(p.get("vanish")),
              "ghost": bool(p.get("ghost")), "freecam": bool(p.get("freecam"))})
    state = p.get("state")
    if not state:
        return
    for viewer in list(PLAYERS.values()):
        if viewer is p:
            continue
        if p.get("ghost") and not viewer.get("admin"):
            continue
        payload = dict(state, t="state", id=p["id"], hidden=player_hidden(p))
        psend(viewer, payload)

def is_muted(p):
    for item in MUTES:
        if item.get("token") and item.get("token") == p.get("token"):
            return True, item.get("reason", "")
    return False, ""

# ------------------------------------------------------------------ bans
def load_bans():
    try:
        with open(BANFILE, "r", encoding="utf-8") as f: BANS[:] = json.load(f)
    except Exception: pass
def save_bans():
    try:
        with open(BANFILE, "w", encoding="utf-8") as f: json.dump(BANS, f, ensure_ascii=False, indent=2)
    except Exception: pass

def load_mutes():
    try:
        with open(MUTEFILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        MUTES[:] = data[-500:] if isinstance(data, list) else []
    except Exception:
        MUTES.clear()

def save_mutes():
    try:
        with open(MUTEFILE + ".tmp", "w", encoding="utf-8") as f:
            json.dump(MUTES[-500:], f, ensure_ascii=False, indent=2)
        os.replace(MUTEFILE + ".tmp", MUTEFILE)
    except Exception as e:
        ev("Sauvegarde mutes impossible : %s" % e)

def load_reports():
    try:
        with open(REPORTFILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        REPORTS[:] = data[-500:] if isinstance(data, list) else []
    except Exception:
        REPORTS.clear()

def save_reports():
    try:
        with LOCK:
            data = list(REPORTS[-500:])
        tmp = REPORTFILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f: json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, REPORTFILE)
    except Exception as e:
        ev("Sauvegarde signalements impossible : %s" % e)

def load_reminders():
    now_t = time.time()
    try:
        with open(REMINDERFILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = []
    cleaned = []
    if isinstance(data, list):
        for item in data[:100]:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text", ""))[:800].strip()
            try: interval = max(1, min(9999999999, int(item.get("interval", 60))))
            except Exception: interval = 60
            try: rid = max(1, int(item.get("id", len(cleaned) + 1)))
            except Exception: rid = len(cleaned) + 1
            try: next_at = float(item.get("next_at", now_t + interval))
            except Exception: next_at = now_t + interval
            if text:
                if next_at <= now_t: next_at = now_t + interval
                cleaned.append({"id": rid, "text": text, "interval": interval,
                                "next_at": next_at, "active": bool(item.get("active", True))})
    REMINDERS[:] = cleaned
    NEXT_REMINDER_ID[0] = max([r["id"] for r in cleaned] or [0]) + 1

def save_reminders():
    try:
        with LOCK:
            data = [dict(r) for r in REMINDERS]
        tmp = REMINDERFILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f: json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, REMINDERFILE)
    except Exception as e:
        ev("Sauvegarde rappels impossible : %s" % e)

def reminder_loop():
    while True:
        time.sleep(0.4)
        now_t = time.time()
        due = []
        with LOCK:
            for item in REMINDERS:
                if not item.get("active", True):
                    continue
                interval = max(1, int(item.get("interval", 60)))
                if now_t >= float(item.get("next_at", now_t + interval)):
                    due.append({"id": item["id"], "text": item["text"]})
                    item["next_at"] = now_t + interval
            if due:
                save_reminders()
        for item in due:
            broadcast({"t": "reminder", "id": item["id"], "text": item["text"]})
            ev("Rappel #%s affiche" % item["id"])
def load_names():
    # Les pseudos ne sont jamais importes depuis une ancienne instance.
    NAMES.clear()
def save_names():
    # La table reste disponible en memoire jusqu'a l'arret du serveur.
    return

def is_banned(ip, token, name):
    for b in BANS:
        if b.get("ip") and b["ip"] == ip: return True
        if b.get("token") and b["token"] == token: return True
        if b.get("name") and name and b["name"].lower() == name.lower(): return True
    return False

# ------------------------------------------------------------------ websocket
class Conn:
    def __init__(self, h): self.h = h; self.sl = threading.Lock()
    def _w(self, b):
        try:
            with self.sl: self.h.wfile.write(b); self.h.wfile.flush()
        except Exception: pass
    def send(self, obj):
        data = json.dumps(obj, separators=(",", ":")).encode(); n = len(data)
        head = bytes([0x81]) + (bytes([n]) if n < 126 else b"\x7e" + struct.pack(">H", n) if n < 65536 else b"\x7f" + struct.pack(">Q", n))
        self._w(head + data)
    def pong(self, d): self._w(bytes([0x8A, len(d)]) + d)
    def close(self):
        self._w(b"\x88\x00")
        try: self.h.connection.shutdown(socket.SHUT_RDWR)
        except Exception: pass

def read_exact(f, n):
    b = b""
    while len(b) < n:
        c = f.read(n - len(b))
        if not c: raise EOFError
        b += c
    return b

def read_frames(f):
    msg = b""
    while True:
        b1, b2 = read_exact(f, 2)
        op = b1 & 0x0F; fin = b1 & 0x80; n = b2 & 0x7F
        if n == 126: n = struct.unpack(">H", read_exact(f, 2))[0]
        elif n == 127: n = struct.unpack(">Q", read_exact(f, 8))[0]
        if n > 1 << 20: raise EOFError
        mask = read_exact(f, 4) if b2 & 0x80 else None
        d = read_exact(f, n) if n else b""
        if mask: d = bytes(x ^ mask[i & 3] for i, x in enumerate(d))
        if op == 8: raise EOFError
        if op == 9: yield ("ping", d); continue
        if op == 10: continue
        msg += d
        if fin: yield ("msg", msg); msg = b""

def real_ip(h):
    peer = h.client_address[0]
    if peer in LOOPBACK:
        for hd in ("CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP"):
            v = h.headers.get(hd)
            if v: return v.split(",")[0].strip()
    return peer

def psend(p, obj): p["c"].send(obj)
def broadcast(obj, skip=None):
    with LOCK: ts = [p for i, p in PLAYERS.items() if i != skip]
    for p in ts: p["c"].send(obj)
def roster(viewer=None):
    with LOCK:
        return [{"id": i, "name": p["name"], "kills": p["kills"], "deaths": p["deaths"],
                 "hp": int((p["state"] or {}).get("hp", 100)), "dead": bool((p["state"] or {}).get("dead")),
                 "god": p["god"], "frozen": p["frozen"], "admin": p["admin"],
                 "vanish": bool(p.get("vanish")), "ghost": bool(p.get("ghost")),
                 "freecam": bool(p.get("freecam")), "muted": is_muted(p)[0]}
                for i, p in PLAYERS.items() if not p.get("ghost") or (viewer and (viewer.get("admin") or viewer.get("console_admin")))]
def settings():
    return {"t": "settings", "server_name": SERVER_NAME, "dmg": CFG["dmg"], "max": CFG["max"], "locked": CFG["locked"],
            "pvp": CFG["pvp"], "bots": CFG["bots"], "spawn_allowed": CFG["spawn_allowed"],
            "max_bots": CFG["max_bots"], "bot_damage": CFG["bot_damage"],
            "spawn_cooldown": CFG["spawn_cooldown"],
            "resources": dict(CFG["resources"]), "n": len(PLAYERS)}
def push_roster():
    with LOCK:
        recipients = list(PLAYERS.values())
    for viewer in recipients:
        psend(viewer, {"t": "roster", "players": roster(viewer)})
    broadcast(settings())


# ------------------------------------------------------------------ bots serveur (etat et IA autoritaires)
def bot_snapshot():
    with LOCK:
        return [{"id": b["id"], "name": b["name"], "p": list(b["p"]), "yaw": b["yaw"],
                 "health": b["health"], "shield": b["shield"]} for b in BOTS.values()]

def push_bots():
    broadcast({"t": "bots", "items": bot_snapshot()})

def try_spawn_bot(owner=None):
    with LOCK:
        if not CFG["bots"]: return None
        if len(BOTS) >= int(CFG["max_bots"]): return None
        state = (owner or {}).get("state") or {}
        origin = state.get("p") or [0.0, 0.0, 0.0]
        try: ox, oz = float(origin[0]), float(origin[2])
        except Exception: ox, oz = 0.0, 0.0
        n = NEXT_BOT[0]; NEXT_BOT[0] += 1
        angle = random.random() * math.tau if hasattr(math, "tau") else random.random() * 6.28318
        bid = "bot-%d" % n
        # Un bot ne doit jamais apparaitre dans la zone protegee de la Base Admin.
        bx, bz = 30.0, 70.0
        for _ in range(24):
            candidate_angle = random.random() * (math.tau if hasattr(math, "tau") else 6.28318)
            radius = random.uniform(9, 20)
            candidate = (ox + math.cos(candidate_angle) * radius,
                         oz + math.sin(candidate_angle) * radius)
            if not is_in_admin_base((candidate[0], 0.0, candidate[1])):
                bx, bz = candidate
                angle = candidate_angle
                break
        BOTS[bid] = {"id": bid, "name": "Bot-%02d" % n, "p": [bx, 0.0, bz],
                     "center": [bx, bz], "angle": angle, "yaw": angle,
                     "health": 100.0, "shield": 50.0, "next_shot": time.time() + 1.0}
    ev("BOT spawn %s" % bid); push_bots()
    return bid

def bot_take_damage(attacker, bot_id, raw_damage):
    try: dmg = max(1.0, min(50.0, float(raw_damage)))
    except Exception: dmg = 20.0
    with LOCK:
        b = BOTS.get(str(bot_id))
        if not b: return
        shield_before = b["shield"]
        shield_dmg = min(shield_before, dmg)
        b["shield"] = max(0.0, shield_before - shield_dmg)
        health_dmg = max(0.0, dmg - shield_dmg)
        b["health"] = max(0.0, b["health"] - health_dmg)
        killed = b["health"] <= 0
        data = {"id": b["id"], "name": b["name"], "p": list(b["p"]), "yaw": b["yaw"],
                "health": b["health"], "shield": b["shield"]}
        if killed:
            BOTS.pop(b["id"], None)
            attacker["kills"] += 1
    psend(attacker, {"t": "hit_confirm", "to": data["name"], "dmg": dmg,
                     "shield_dmg": shield_dmg, "health_dmg": health_dmg,
                     "kind": "shield" if shield_dmg > 0 else "health", "eliminated": killed})
    if killed:
        ev("%s a elimine %s" % (attacker["name"], data["name"]))
        broadcast({"t": "bot_kill", "id": data["id"], "killer": attacker["name"],
                   "killer_id": attacker["id"], "victim": data["name"]})
        push_roster()
    else:
        broadcast({"t": "bot_update", "bot": data})

def kill_all_bots():
    with LOCK:
        ids = list(BOTS.keys()); BOTS.clear()
    push_bots(); broadcast({"t": "bots_clear"}); ev("Tous les bots elimines (%d)" % len(ids))
    return "Bots supprimes : %d" % len(ids)

def bot_loop():
    last_push = 0.0
    while True:
        time.sleep(0.12)
        now_t = time.time()
        with LOCK:
            if not CFG["bots"]:
                if BOTS: BOTS.clear()
                should_push = now_t - last_push > 0.5
                bots_now = []
            else:
                live = [(i, p) for i, p in PLAYERS.items()
                        if p.get("state") and p["state"].get("p") and not p["state"].get("dead")
                        and not player_in_admin_base(p)]
                for b in BOTS.values():
                    if not live: continue
                    target_id, target = min(live, key=lambda ip: (ip[1]["state"]["p"][0]-b["p"][0])**2 +
                                                               (ip[1]["state"]["p"][2]-b["p"][2])**2)
                    tx, tz = target["state"]["p"][0], target["state"]["p"][2]
                    dx, dz = tx - b["p"][0], tz - b["p"][2]
                    dist = (dx*dx + dz*dz) ** 0.5
                    if dist > 0.001:
                        b["yaw"] = __import__("math").atan2(dx, dz)
                        if dist > 7.0:
                            step = min(0.18, dist - 7.0)
                            b["p"][0] += dx / dist * step
                            b["p"][2] += dz / dist * step
                    if dist < 32 and now_t >= b["next_shot"] and not target["god"]:
                        b["next_shot"] = now_t + 0.8
                        psend(target, {"t": "hit", "from": "bot", "dmg": CFG["bot_damage"]})
                should_push = now_t - last_push > 0.24
                bots_now = list(BOTS.values())
        if should_push:
            last_push = now_t
            push_bots()

def dname(p): return p["base"]

NAME_RX = re.compile(r"^[A-Za-z0-9_\-]{2,16}$")
def check_name(name, me=None):
    name = re.sub(r"\s+", " ", str(name or "")).strip()
    if not NAME_RX.match(name): return None, "Pseudo invalide (2-16 caracteres : lettres, chiffres, _ ou -)"
    with LOCK:
        for i, p in PLAYERS.items():
            if i != me and p["base"].lower() == name.lower(): return None, "Ce pseudo est deja pris sur ce serveur"
    return name, None

def try_join(conn, ip, m):
    token = str(m.get("token", ""))[:64]
    if len(token) < 8: return None, ("badname", "Navigateur non supporte (identifiant manquant)", False)
    reg = NAMES.get(token)
    base, err = (reg, None) if reg else check_name(m.get("name"))
    with LOCK:
        if is_banned(ip, token, base or ""):
            reason = next((str(b.get("reason")) for b in BANS
                           if (b.get("ip") and b.get("ip") == ip) or
                              (b.get("token") and b.get("token") == token) or
                              (b.get("name") and base and b.get("name", "").lower() == base.lower())),
                          "Tu es banni de ce serveur.")
            return None, ("denied", reason, True)
        if CFG["locked"]: return None, ("denied", "Serveur verrouille par l'admin.", False)
        old = next((q for q in PLAYERS.values() if q["token"] == token), None)
        if not old and len(PLAYERS) >= CFG["max"]: return None, ("denied", "Serveur plein (%d/%d)." % (len(PLAYERS), CFG["max"]), False)
        if err: return None, ("badname", err, False)
        for t2, n2 in NAMES.items():
            if t2 != token and n2.lower() == base.lower(): return None, ("badname", "Ce pseudo est deja pris sur ce serveur", False)
        if old:
            PLAYERS.pop(old["id"], None); threading.Timer(0.1, old["c"].close).start()
        if not reg: NAMES[token] = base; save_names()
        pid = NEXT_ID[0]; NEXT_ID[0] += 1
        p = {"c": conn, "base": base, "name": base, "ip": ip, "token": token, "kills": 0, "deaths": 0,
             "state": None, "admin": token in ADMINS, "god": False, "frozen": False,
             "vanish": False, "ghost": False, "freecam": False,
             "last_by": None, "last_t": 0, "fails": 0, "id": pid, "chat": collections.deque(maxlen=6),
             "console_admin": False, "console_auth_at": 0.0}
        PLAYERS[pid] = p
    return p, None


def ws_session(h):
    ip = real_ip(h)
    key = h.headers.get("Sec-WebSocket-Key", "")
    acc = base64.b64encode(hashlib.sha1(key.encode() + MAGIC).digest()).decode()
    h.wfile.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % acc).encode())
    h.wfile.flush()
    try:
        h.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        h.connection.settimeout(45)
    except Exception: pass
    conn = Conn(h); p = None; bad = 0
    try:
        for kind, d in read_frames(h.rfile):
            if kind == "ping": conn.pong(d); continue
            try: m = json.loads(d.decode())
            except Exception: continue
            t = m.get("t")
            if p is None:
                if t != "hello": continue
                p, err = try_join(conn, ip, m)
                if err:
                    conn.send({"t": err[0], "reason": err[1], "ban": err[2]})
                    if err[0] == "denied": break
                    bad += 1
                    if bad > 30: break
                    continue
                ev("+ %s (#%d) rejoint [%s]" % (p["name"], p["id"], ip))
                conn.send({"t": "welcome", "id": p["id"], "name": p["name"], "admin": p["admin"],
                            "instance": INSTANCE_ID, "server_name": SERVER_NAME,
                            "players": roster(p), "settings": settings()})
                with LOCK: others = [(i, q) for i, q in PLAYERS.items() if i != p["id"] and q["state"]]
                for i, other in others:
                    if other.get("ghost") and not p.get("admin"):
                        continue
                    conn.send(dict(other["state"], t="state", id=i, hidden=player_hidden(other)))
                conn.send({"t": "bots", "items": bot_snapshot()})
                conn.send({"t": "resources", "data": dict(CFG["resources"])})
                with LOCK: world_item = dict(WORLD_WEAPON) if WORLD_WEAPON else None
                conn.send({"t": "weapon_world", "item": world_item})
                push_roster()
                continue
            handle(p, m)
    except Exception:
        pass
    finally:
        if p is not None:
            with LOCK: PLAYERS.pop(p["id"], None)
            ev("- %s (#%d) parti" % (p["name"], p["id"]))
            broadcast({"t": "leave", "id": p["id"]}); push_roster()
        try: conn.close()
        except Exception: pass


# ------------------------------------------------------------------ CMD integre au jeu (authentification serveur)
CONSOLE_MENU = [
    "1  Liste des joueurs", "2  Limite de joueurs", "3  Bannir un joueur",
    "4  Debannir (liste des bans)", "5  Expulser un joueur (kick)",
    "6  Message a tous", "7  Verrouiller / ouvrir le serveur",
    "8  Multiplicateur de degats", "9  Reset des scores",
    "10 Promouvoir admin", "11 Retirer admin", "12 Infos du serveur",
    "13 Activer / desactiver le PVP", "14 Activer / desactiver les bots",
    "15 Autoriser / interdire le spawn de bots aux joueurs", "16 Supprimer tous les bots",
    "17 Delai de spawn des bots", "18 Rappels en jeu", "19 Signalements joueurs",
    "20 Renommer le serveur", "21 Bannir une adresse IP", "22 Mute un joueur",
    "23 Liste / retirer les mutes", "24 Renommer un joueur"
]


# code admin : 843795961739098579718621335191790044513062906690866504752112
# Empreinte SHA-256 du code administrateur de 60 chiffres.
# Le code en clair n'est pas integre au JavaScript du jeu.
CONSOLE_CODE_SHA256 = "9954d5f88fac3534fd95a8e7ddab742aa5d6fbd072a026723a9a871c7a7df017"



def console_dashboard_output():
    """Construit le meme tableau de bord texte que la console native Windows."""
    with LOCK:
        player_count = len(PLAYERS)
        player_limit = int(CFG.get("max", 16))
        ban_count = len(BANS)
        mute_count = len(MUTES)
        damage = float(CFG.get("dmg", 1.0))
        locked = bool(CFG.get("locked"))
        pvp = bool(CFG.get("pvp"))
        bots = bool(CFG.get("bots"))
        server_name = str(SERVER_NAME or "WARZONE RENDER V2")
        tunnel_url = str(TUNNEL.get("url") or "")
        tunnel_state = str(TUNNEL.get("state") or "indisponible")

    green = "\x1b[92m"
    red = "\x1b[91m"
    yellow = "\x1b[93m"
    gray = "\x1b[90m"
    bold = "\x1b[1m"
    reset = "\x1b[0m"
    width = 78
    divider = gray + "-" * width + reset
    lines = [
        green + "=" * width + reset,
        green + "   W A R Z O N E   F P S" + reset + bold + "   -   SERVEUR v3.9.1" + reset,
        green + "=" * width + reset,
        "  " + yellow + server_name + reset,
        "",
        "  Joueurs " + green + ("%d/%d" % (player_count, player_limit)) + reset
        + "    Bannis " + yellow + str(ban_count) + reset
        + "    Mutes " + yellow + str(mute_count) + reset
        + "    Degats x%.2f" % damage
        + "    Serveur " + (red + "VERROUILLE" if locked else green + "ouvert") + reset
        + "    PVP " + (green + "ON" if pvp else red + "OFF") + reset
        + "    Bots " + (green + "ON" if bots else red + "OFF") + reset,
        "  " + bold + "Lien amis (internet) : " + reset
        + (green + (tunnel_url + "/autre/index.html" if tunnel_url else "pas de lien - " + tunnel_state) + reset),
        "",
        divider,
    ]
    menu = [
        ("0", "Rafraichir"), ("1", "Liste des joueurs"),
        ("2", "Limite de joueurs"), ("3", "Bannir un joueur"),
        ("4", "Debannir (liste bans)"), ("5", "Expulser (kick)"),
        ("6", "Message a tous"), ("7", "Verrouiller serveur"),
        ("8", "Degats des joueurs"), ("9", "Reset scores"),
        ("10", "Promouvoir Admin"), ("11", "Roles & Revocations"),
        ("12", "Infos serveur"), ("13", "PVP ON/OFF"),
        ("14", "Bots ON/OFF"), ("15", "Droit de spawn ON/OFF"),
        ("16", "Kill all bots"), ("17", "Delai spawn bots non-admin"),
        ("18", "Rappels en jeu"), ("19", "Signalements joueurs"),
        ("20", "Renommer le serveur"), ("21", "Ban IP"),
        ("22", "Mute joueur"), ("23", "Liste / retirer les mutes"),
        ("24", "Renommer un joueur"), ("Q", "Quitter"),
    ]
    for index in range(0, len(menu), 2):
        left, right = menu[index], menu[index + 1]
        # Meme alignement que dashboard() dans la console CMD Windows.
        left_text = "  " + yellow + ("[" + left[0] + "]").ljust(6) + reset + left[1].ljust(30)
        right_text = yellow + ("[" + right[0] + "]").ljust(6) + reset + right[1].ljust(30)
        lines.append(left_text + right_text)
    lines.append(divider)
    return "\n".join(lines)

def console_authenticate(p, supplied):
    """Authentifie uniquement la console de cette connexion, sans promouvoir le joueur."""
    candidate = str(supplied or "")
    valid_format = bool(re.fullmatch(r"[0-9]{60}", candidate))
    candidate_digest = hashlib.sha256(candidate.encode("utf-8")).hexdigest() if valid_format else ""
    valid_code = valid_format and hmac.compare_digest(candidate_digest, CONSOLE_CODE_SHA256)

    ip = str(p.get("ip") or "unknown")
    now_t = time.time()
    state = ADMIN_LOGIN_STATE.get(ip, {"count": 0, "since": now_t, "blocked_until": 0.0})
    if state.get("blocked_until", 0) > now_t:
        left = int(state["blocked_until"] - now_t + 0.999)
        psend(p, {"t": "console_auth_res", "ok": False,
                  "msg": "Trop de tentatives. Reessaie dans %d seconde(s)." % left})
        return
    if now_t - state.get("since", now_t) > 600:
        state = {"count": 0, "since": now_t, "blocked_until": 0.0}
    if not valid_code:
        state["count"] = int(state.get("count", 0)) + 1
        state["since"] = state.get("since", now_t)
        if state["count"] >= 5:
            state["blocked_until"] = now_t + 900
            state["count"] = 0
            state["since"] = now_t
            msg = "Trop de codes incorrects : IP bloquee pendant 15 minutes."
        else:
            msg = "Code incorrect (%d/5)." % state["count"]
        ADMIN_LOGIN_STATE[ip] = state
        ev("Echec authentification console depuis %s" % ip)
        psend(p, {"t": "console_auth_res", "ok": False, "msg": msg})
        return

    ADMIN_LOGIN_STATE.pop(ip, None)
    p["console_admin"] = True
    p["console_auth_at"] = now_t
    ev("Console integree authentifiee par %s (#%s)" % (p.get("name", "?"), p.get("id", "?")))
    psend(p, {"t": "console_auth_res", "ok": True, "name": p.get("name", "Joueur"),
              "server": SERVER_NAME, "menu": CONSOLE_MENU})

def console_player_lines():
    rows = roster(None)
    if not rows:
        return "Aucun joueur connecte."
    lines = [" ID  PSEUDO             PV    K/D   ETAT"]
    for q in rows:
        flags = []
        if q.get("admin"): flags.append("ADMIN")
        if q.get("muted"): flags.append("MUTE")
        if q.get("god"): flags.append("DIEU")
        if q.get("frozen"): flags.append("FREEZE")
        if q.get("dead"): flags.append("MORT")
        lines.append("#{:<3} {:<18} {:>3}   {}/{}   {}".format(
            q.get("id"), q.get("name", "?"), q.get("hp", 0),
            q.get("kills", 0), q.get("deaths", 0), ", ".join(flags) or "-"))
    lines.append("\nJoueurs : %d/%d" % (len(rows), CFG.get("max", 16)))
    return "\n".join(lines)


def console_toggle(value, current):
    value = str(value or "toggle").lower()
    if value in ("on", "1", "oui", "o", "true", "activer"):
        return True
    if value in ("off", "0", "non", "n", "false", "desactiver"):
        return False
    if value in ("toggle", "switch", ""):
        return not bool(current)
    return None


def console_command(p, raw):
    """Execute une commande CMD apres controle d'autorisation cote serveur."""
    if not p.get("console_admin"):
        return "Acces refuse. Authentifie-toi avec ! suivi du code admin."
    raw = str(raw or "").strip()
    if not raw:
        return ""
    if len(raw) > 500:
        return "Commande trop longue (500 caracteres maximum)."
    parts = raw.split(None, 1)
    cmd = parts[0].lower()
    rest = parts[1].strip() if len(parts) > 1 else ""
    args = rest.split(None, 1)
    arg1 = args[0] if args else ""
    arg2 = args[1].strip() if len(args) > 1 else ""

    if cmd in ("0", "dashboard", "refresh", "rafraichir"):
        return console_dashboard_output()
    if cmd in ("help", "aide", "?"):
        return ("COMMANDES DIRECTES\n"
                "players | bans | limit <n> | ban <id> [motif] | unban <index|all>\n"
                "kick <id> [motif] | msg <texte> | lock [on|off|toggle] | dmg <x> | reset\n"
                "admin add|remove <id> | serverinfo | pvp|bots|spawn [on|off|toggle]\n"
                "killbots | botcooldown <secondes> | reminders\n"
                "reminder add <secondes> <texte> | reminder edit <id> <secondes> <texte>\n"
                "reminder delete <id> | reminder toggle <id>\n"
                "reports | report done <id|all> | servername <nom> | banip <ip> [motif]\n"
                "mute <id> [motif] | mutes | unmute <index|all> | rename <id> <pseudo>\n"
                "Les identifiants joueurs correspondent aux numeros affiches par PLAYERS.")
    if cmd in ("players", "player", "list", "1"):
        return console_player_lines()
    if cmd == "bans":
        if not BANS: return "Aucun ban enregistre."
        return "\n".join("[%d] %-20s IP=%s  %s  %s" %
                         (i, b.get("name", "?"), b.get("ip") or "-", b.get("when", ""), b.get("reason", ""))
                         for i, b in enumerate(BANS))
    if cmd in ("limit", "2"):
        return c_limit(arg1) if arg1 else "Usage : limit <nombre> (1 a 200)"
    if cmd in ("ban", "3"):
        if not arg1: return "Usage : ban <id_joueur> [motif]"
        return c_ban(arg1, arg2)
    if cmd in ("unban", "4"):
        if not arg1: return "Usage : unban <index|all>  (liste : bans)"
        if arg1.lower() == "all":
            n = len(BANS); BANS.clear(); save_bans(); ev("Tous les bans retires par CMD")
            return "%d ban(s) retire(s)." % n
        return c_unban(arg1)
    if cmd in ("kick", "5"):
        if not arg1: return "Usage : kick <id_joueur> [motif]"
        return c_kick(arg1, arg2)
    if cmd in ("msg", "message", "6"):
        return c_msg(rest) if rest else "Usage : msg <message a tous les joueurs>"
    if cmd in ("lock", "7"):
        value = console_toggle(arg1, CFG.get("locked"))
        if value is None: return "Valeur attendue : on, off ou toggle"
        return c_lock(value)
    if cmd in ("dmg", "damage", "8"):
        return c_dmg(arg1) if arg1 else "Usage : dmg <multiplicateur> (0 a 10)"
    if cmd in ("reset", "9"):
        return c_reset()
    if cmd == "admin":
        sub = arg1.lower(); spec = arg2.split(None, 1)[0] if arg2 else ""
        if sub not in ("add", "remove", "promote", "demote") or not spec:
            return "Usage : admin add|remove <id_joueur>"
        return c_admin_role(spec, sub in ("add", "promote"))
    if cmd in ("promote", "10"):
        return c_admin_role(arg1, True) if arg1 else "Usage : promote <id_joueur>"
    if cmd in ("demote", "11"):
        return c_admin_role(arg1, False) if arg1 else "Usage : demote <id_joueur>"
    if cmd in ("serverinfo", "info", "12"):
        evs = list(EVENTS)[-10:]
        return ("SERVEUR : %s\nINSTANCE : %s\nPORT : %s\nJOUEURS : %d/%d\n"
                "PVP : %s | BOTS : %s | SPAWN JOUEURS : %s | DEGATS : x%.2f\n"
                "ETAT : %s | LIMITE BOTS : %d | DELAI SPAWN : %d s\n\nDERNIERS EVENEMENTS\n%s" %
                (SERVER_NAME, INSTANCE_ID, PORT, len(PLAYERS), CFG["max"],
                 "ON" if CFG["pvp"] else "OFF", "ON" if CFG["bots"] else "OFF",
                 "ON" if CFG["spawn_allowed"] else "OFF", CFG["dmg"],
                 "VERROUILLE" if CFG["locked"] else "OUVERT", CFG["max_bots"], CFG["spawn_cooldown"],
                 "\n".join(evs) if evs else "Aucun evenement"))
    if cmd in ("pvp", "13"):
        value = console_toggle(arg1, CFG.get("pvp"))
        if value is None: return "Valeur attendue : on, off ou toggle"
        return c_pvp(value)
    if cmd in ("bots", "14"):
        value = console_toggle(arg1, CFG.get("bots"))
        if value is None: return "Valeur attendue : on, off ou toggle"
        return c_bots(value)
    if cmd in ("spawn", "spawn_allowed", "15"):
        value = console_toggle(arg1, CFG.get("spawn_allowed"))
        if value is None: return "Valeur attendue : on, off ou toggle"
        return c_spawn_allowed(value)
    if cmd in ("killbots", "16"):
        return kill_all_bots()
    if cmd in ("botcooldown", "spawncooldown", "17"):
        return c_bot_cooldown(arg1) if arg1 else "Usage : botcooldown <secondes>"
    if cmd in ("reminders", "rappels", "18"):
        if not REMINDERS: return "Aucun rappel configure.\nUtilise reminder add <secondes> <texte>."
        return "\n".join("#%d | %s | toutes les %d s | %s" %
                         (r["id"], r["text"].replace("\n", " / "), r["interval"],
                          "ACTIF" if r.get("active", True) else "PAUSE") for r in REMINDERS)
    if cmd == "reminder":
        subparts = rest.split(None, 2)
        if len(subparts) < 1: return "Usage : reminder add|edit|delete|toggle ..."
        sub = subparts[0].lower()
        if sub == "add":
            if len(subparts) < 3: return "Usage : reminder add <secondes> <texte>"
            try: interval = max(1, min(9999999999, int(subparts[1])))
            except Exception: return "Delai invalide (1 a 9999999999 secondes)."
            text_value = subparts[2].strip()[:800]
            if not text_value: return "Texte de rappel vide."
            with LOCK:
                rid = NEXT_REMINDER_ID[0]; NEXT_REMINDER_ID[0] += 1
                REMINDERS.append({"id": rid, "text": text_value, "interval": interval,
                                  "next_at": time.time() + interval, "active": True})
            save_reminders(); ev("Rappel #%d cree via CMD (%d s)" % (rid, interval))
            return "Rappel #%d cree." % rid
        if sub == "edit":
            sub2 = rest.split(None, 3)
            if len(sub2) < 4: return "Usage : reminder edit <id> <secondes> <texte>"
            try: rid, interval = int(sub2[1]), max(1, min(9999999999, int(sub2[2])))
            except Exception: return "ID ou delai invalide."
            item = next((r for r in REMINDERS if r["id"] == rid), None)
            if not item: return "Rappel introuvable."
            text_value = sub2[3].strip()[:800]
            if not text_value: return "Texte de rappel vide."
            item.update({"interval": interval, "text": text_value, "next_at": time.time() + interval})
            save_reminders(); ev("Rappel #%d modifie via CMD" % rid)
            return "Rappel #%d modifie." % rid
        if sub in ("delete", "del", "remove"):
            try: rid = int(subparts[1])
            except Exception: return "Usage : reminder delete <id>"
            before = len(REMINDERS); REMINDERS[:] = [r for r in REMINDERS if r["id"] != rid]
            if len(REMINDERS) == before: return "Rappel introuvable."
            save_reminders(); ev("Rappel #%d supprime via CMD" % rid)
            return "Rappel #%d supprime." % rid
        if sub in ("toggle", "pause", "resume"):
            try: rid = int(subparts[1])
            except Exception: return "Usage : reminder toggle <id>"
            item = next((r for r in REMINDERS if r["id"] == rid), None)
            if not item: return "Rappel introuvable."
            item["active"] = not bool(item.get("active", True))
            if item["active"]: item["next_at"] = time.time() + item["interval"]
            save_reminders(); ev("Rappel #%d %s via CMD" % (rid, "active" if item["active"] else "mis en pause"))
            return "Rappel #%d %s." % (rid, "actif" if item["active"] else "en pause")
        return "Sous-commandes : reminder add|edit|delete|toggle"
    if cmd in ("reports", "signalements", "19"):
        if not REPORTS: return "Aucun signalement."
        return "\n".join("#%s [%s] %s -> %s (%s) : %s" %
                         (r.get("id", 0), "TRAITE" if r.get("reviewed") else "NOUVEAU",
                          r.get("from", "?"), r.get("target", "?"), r.get("when", ""),
                          r.get("reason", "")) for r in REPORTS[-50:])
    if cmd == "report":
        subparts = rest.split(None, 1)
        if len(subparts) < 2 or subparts[0].lower() not in ("done", "traite", "review"):
            return "Usage : report done <id|all>"
        target = subparts[1].strip().lower()
        changed = 0
        if target == "all":
            for item in REPORTS:
                if not item.get("reviewed"): item["reviewed"] = True; changed += 1
        else:
            try: rid = int(target)
            except Exception: return "ID de signalement invalide."
            for item in REPORTS:
                if item.get("id") == rid:
                    if not item.get("reviewed"): item["reviewed"] = True; changed = 1
                    break
        save_reports()
        return "%d signalement(s) marque(s) comme traite(s)." % changed
    if cmd in ("servername", "serverrename", "20"):
        return c_rename_server(rest) if rest else "Usage : servername <nouveau nom>"
    if cmd in ("banip", "21"):
        if not arg1: return "Usage : banip <adresse_ip> [motif]"
        return c_ban_ip(arg1, arg2)
    if cmd in ("mute", "22"):
        if not arg1: return "Usage : mute <id_joueur> [motif]"
        return c_mute(arg1, arg2)
    if cmd in ("mutes", "23"):
        if not MUTES: return "Aucun joueur mute."
        return "\n".join("[%d] %-20s %s | %s" %
                         (i, m.get("name", "?"), m.get("when", ""), m.get("reason", ""))
                         for i, m in enumerate(MUTES))
    if cmd == "unmute":
        if not arg1: return "Usage : unmute <index|all>  (liste : mutes)"
        if arg1.lower() == "all":
            tokens = {m.get("token") for m in MUTES}
            n = len(MUTES); MUTES.clear()
        else:
            try: idx = int(arg1)
            except Exception: return "Index invalide : utilise mutes pour afficher la liste."
            if idx < 0 or idx >= len(MUTES): return "Index invalide : utilise mutes pour afficher la liste."
            tokens = {MUTES[idx].get("token")}; n = 1; MUTES.pop(idx)
        save_mutes()
        for q in list(PLAYERS.values()):
            if q.get("token") in tokens:
                psend(q, {"t": "sanction", "kind": "unmute", "reason": ""})
        push_roster()
        return "%d mute(s) retire(s)." % n
    if cmd in ("rename", "24"):
        sub = rest.split(None, 1)
        if len(sub) < 2: return "Usage : rename <id_joueur> <nouveau_pseudo>"
        return c_rename(sub[0], sub[1])
    if cmd == "logout":
        p["console_admin"] = False
        return "Session CMD fermee."
    return "Commande inconnue : %s. Tape HELP." % cmd

def handle(p, m):
    global WORLD_WEAPON
    t = m.get("t"); pid = p["id"]
    if t == "resource_token":
        token_value = issue_resource_upload_token(p)
        psend(p, {"t": "resource_token_res", "ok": bool(token_value), "token": token_value or "", "message": "" if token_value else "Import reservee aux administrateurs authentifies."})
        return
    if t == "console_auth":
        console_authenticate(p, m.get("code", "")); return
    if t == "console_ui":
        console_ui_handle(p, m)
        return
    if t == "console_exec":
        # Compatibilite avec les clients plus anciens.
        try:
            result = console_command(p, m.get("line", ""))
        except Exception as exc:
            result = "Erreur CMD : %s" % str(exc)[:240]
            ev("Erreur console web pour %s : %s" % (p.get("name", "?"), str(exc)[:120]))
        psend(p, {"t": "console_result", "output": result})
        return
    if t == "weapon_spawn":
        weapon = m.get("weapon")
        if weapon not in ("ak47", "m4"):
            psend(p, {"t": "weapon_action_res", "action": "spawn", "ok": False, "message": "Arme inconnue."})
            return
        try:
            raw_pos = m.get("p") or []
            if len(raw_pos) != 3: raise ValueError("position")
            pos = [max(-500.0, min(500.0, float(v))) for v in raw_pos]
            yaw = float(m.get("yaw", 0.0))
            if not math.isfinite(yaw): yaw = 0.0
            yaw = max(-100.0, min(100.0, yaw))
        except Exception:
            psend(p, {"t": "weapon_action_res", "action": "spawn", "ok": False, "message": "Position de spawn invalide."})
            return
        state_pos = (p.get("state") or {}).get("p") or []
        try:
            if len(state_pos) != 3: raise ValueError("position joueur absente")
            state_pos = [float(v) for v in state_pos]
            if not all(math.isfinite(v) for v in state_pos): raise ValueError("position joueur")
            dist = math.sqrt(sum((pos[i] - state_pos[i]) ** 2 for i in range(3)))
        except Exception:
            psend(p, {"t": "weapon_action_res", "action": "spawn", "ok": False, "message": "Position du joueur invalide."})
            return
        if dist > 9.0:
            psend(p, {"t": "weapon_action_res", "action": "spawn", "ok": False, "message": "Emplacement de spawn trop eloigne."})
            return
        with LOCK:
            if WORLD_WEAPON is not None:
                existing = dict(WORLD_WEAPON)
                ok = False
            else:
                WORLD_WEAPON = {"id": uuid.uuid4().hex[:12], "weapon": weapon, "p": pos, "yaw": yaw}
                existing = dict(WORLD_WEAPON)
                ok = True
        if not ok:
            psend(p, {"t": "weapon_action_res", "action": "spawn", "ok": False, "message": "Une arme est deja au sol. Ramassez-la avant d'en faire apparaitre une autre."})
            return
        broadcast({"t": "weapon_world", "item": existing})
        psend(p, {"t": "weapon_action_res", "action": "spawn", "ok": True, "message": "Arme apparue pour tous les joueurs."})
        return
    if t == "weapon_pickup":
        target_id = str(m.get("id", ""))
        with LOCK:
            item = dict(WORLD_WEAPON) if WORLD_WEAPON is not None else None
            state_pos = (p.get("state") or {}).get("p") or []
            if not item or str(item.get("id")) != target_id or len(state_pos) != 3:
                item = None
            else:
                try:
                    dist = math.sqrt(sum((float(state_pos[i]) - float(item["p"][i])) ** 2 for i in range(3)))
                except Exception: dist = 9999.0
                if dist > 3.8:
                    item = None
                else:
                    WORLD_WEAPON = None
        if not item:
            psend(p, {"t": "weapon_action_res", "action": "pickup", "ok": False, "message": "Arme indisponible ou trop eloignee."})
            return
        broadcast({"t": "weapon_picked", "id": item["id"], "player": pid, "weapon": item["weapon"]})
        psend(p, {"t": "weapon_action_res", "action": "pickup", "ok": True, "message": "Arme ramassee."})
        broadcast({"t": "weapon_world", "item": None})
        return
    if t == "state":
        s = {k: m[k] for k in ("p", "yaw", "pitch", "hp", "shield", "dead") if k in m}
        weapon_state = m.get("weapon")
        s["weapon"] = weapon_state if weapon_state in ("ak47", "m4") else None
        try:
            if "p" in s:
                pos = [max(-500.0, min(500.0, float(v))) for v in s["p"][:3]]
                if len(pos) != 3: return
                s["p"] = pos
            if "hp" in s: s["hp"] = max(0, min(100, float(s["hp"])))
            if "shield" in s: s["shield"] = max(0.0, min(150.0, float(s["shield"])))
        except Exception: return
        with LOCK: p["state"] = s
        for viewer in list(PLAYERS.values()):
            if viewer is p or (p.get("ghost") and not viewer.get("admin")):
                continue
            psend(viewer, dict(s, t="state", id=pid, hidden=player_hidden(p)))
    elif t == "shoot":
        if player_in_admin_base(p): return
        weapon = m.get("weapon") if m.get("weapon") in ("ak47", "m4") else "ak47"
        broadcast({"t": "shoot", "id": pid, "o": m.get("o"), "d": m.get("d"), "weapon": weapon}, skip=pid)
    elif t == "hit":
        if not CFG["pvp"] or player_in_admin_base(p): return
        with LOCK: tgt = PLAYERS.get(m.get("to"))
        if tgt and tgt is not p and not player_in_admin_base(tgt) and not tgt["god"] and not (tgt["state"] or {}).get("dead"):
            try: dmg = max(1.0, min(float(m.get("dmg", 20)), 50.0)) * CFG["dmg"]
            except Exception: dmg = 20.0
            tgt["last_by"] = pid; tgt["last_t"] = time.time()
            shield_before = max(0.0, min(150.0, float((tgt["state"] or {}).get("shield", 0) or 0)))
            shield_dmg = min(shield_before, dmg)
            health_dmg = max(0.0, dmg - shield_dmg)
            psend(tgt, {"t": "hit", "from": pid, "dmg": dmg})
            psend(p, {"t": "hit_confirm", "to": tgt["name"], "dmg": dmg,
                      "shield_dmg": shield_dmg, "health_dmg": health_dmg,
                      "kind": "shield" if shield_dmg > 0 else "health"})
    elif t == "bot_spawn":
        if not CFG["bots"]:
            psend(p, {"t": "admin_res", "msg": "Les bots sont desactives par le serveur."})
            return
        if not p["admin"] and not CFG["spawn_allowed"]:
            psend(p, {"t": "admin_res", "msg": "Le spawn de bots est desactive par le serveur."})
            return
        with LOCK:
            now_t = time.time()
            cooldown = max(0, int(CFG.get("spawn_cooldown", 15)))
            last_t = BOT_SPAWN_LAST.get(p["token"], 0.0)
            remaining = cooldown - (now_t - last_t)
            if not p["admin"] and remaining > 0:
                psend(p, {"t": "admin_res", "msg": "Prochain spawn de bot dans %d seconde(s)." % int(remaining + 0.999)})
                return
            # Bots LOCAUX : le serveur valide seulement les droits / le delai, puis autorise ce joueur
            # a creer un bot visible par lui seul (aucun bot partage n'est cree cote serveur).
            psend(p, {"t": "bot_spawn_ok"})
            if not p["admin"]:
                BOT_SPAWN_LAST[p["token"]] = now_t
        if not p["admin"]:
            psend(p, {"t": "admin_res", "msg": "Bot spawne. Prochain spawn possible dans %d seconde(s)." % cooldown})
    elif t == "bot_hit":
        if CFG["bots"] and not player_in_admin_base(p):
            bot_take_damage(p, m.get("id"), m.get("dmg", 20))
    elif t == "dead":
        if player_in_admin_base(p):
            return
        with LOCK:
            p["deaths"] += 1
            k = PLAYERS.get(p["last_by"]) if time.time() - p["last_t"] < 15 else None
            if k: k["kills"] += 1
            kn = k["name"] if k else None
            kid = k["id"] if k else None
        ev("%s a elimine %s" % (kn, p["name"]) if kn else "%s est mort" % p["name"])
        broadcast({"t": "killfeed", "killer": kn, "killer_id": kid, "victim": p["name"]})
        if k: psend(k, {"t": "eliminated", "victim": p["name"]})
        push_roster()
    elif t == "chat":
        chat(p, str(m.get("text", ""))[:200].strip())
    elif t == "admin":
        if not p["admin"]: psend(p, {"t": "admin_res", "msg": "Pas admin"}); return
        try: res = admin_exec(p, m)
        except Exception as e: res = "Erreur : %s" % e
        if res: psend(p, {"t": "admin_res", "msg": res})

# ------------------------------------------------------------------ commandes (console + en jeu)
def targets(spec):
    with LOCK:
        if spec == "all": return list(PLAYERS.items())
        try: i = int(spec)
        except Exception: return []
        return [(i, PLAYERS[i])] if i in PLAYERS else []
def pl(spec):
    r = targets(spec); return r
def c_kick(pid, reason=""):
    r = targets(pid)
    if not r: return "Joueur introuvable"
    _, p = r[0]
    reason = (str(reason or "").strip()[:180] or "Expulse par l'administrateur.")
    psend(p, {"t": "kicked", "reason": reason})
    ev("KICK %s (#%s) : %s" % (p["name"], pid, reason))
    threading.Timer(0.3, p["c"].close).start(); return "%s expulse" % p["name"]
def c_ban(pid, reason=""):
    r = targets(pid)
    if not r: return "Joueur introuvable"
    _, p = r[0]
    reason = (str(reason or "").strip()[:180] or "Banni de ce serveur.")
    BANS.append({"name": p["base"], "ip": None if p["ip"] in LOOPBACK else p["ip"],
                 "token": p["token"], "when": now(), "reason": reason}); save_bans()
    psend(p, {"t": "kicked", "reason": reason, "ban": True}); ev("BAN %s (#%s) : %s" % (p["name"], pid, reason))
    threading.Timer(0.3, p["c"].close).start(); return "%s banni" % p["name"]
def c_ban_ip(ip, reason=""):
    try: ip = str(ipaddress.ip_address(str(ip).strip()))
    except Exception: return "Adresse IP invalide"
    reason = (str(reason or "").strip()[:180] or "Adresse IP bannie de ce serveur.")
    if any(b.get("ip") == ip for b in BANS):
        return "Cette adresse IP est deja bannie"
    BANS.append({"name": "IP " + ip, "ip": ip, "token": None, "when": now(), "reason": reason})
    save_bans()
    matched = [q for q in list(PLAYERS.values()) if q.get("ip") == ip]
    for q in matched:
        psend(q, {"t": "kicked", "reason": reason, "ban": True})
        threading.Timer(0.3, q["c"].close).start()
    ev("BAN IP %s : %s" % (ip, reason))
    return "IP %s bannie (%d session(s) fermee(s))" % (ip, len(matched))
def c_mute(pid, reason=""):
    r = targets(pid)
    if not r: return "Joueur introuvable"
    _, p = r[0]
    if is_muted(p)[0]: return "%s est deja mute" % p["name"]
    reason = (str(reason or "").strip()[:180] or "Mute par l'administrateur.")
    MUTES.append({"name": p["base"], "token": p["token"], "when": now(), "reason": reason})
    save_mutes(); psend(p, {"t": "sanction", "kind": "mute", "reason": reason})
    ev("MUTE %s (#%s) : %s" % (p["name"], pid, reason))
    push_roster(); return "%s mute" % p["name"]
def c_unmute(pid):
    r = targets(pid)
    if not r: return "Joueur introuvable"
    _, p = r[0]
    before = len(MUTES)
    MUTES[:] = [m for m in MUTES if m.get("token") != p.get("token")]
    if len(MUTES) == before: return "%s n'etait pas mute" % p["name"]
    save_mutes(); psend(p, {"t": "sanction", "kind": "unmute", "reason": ""})
    ev("UNMUTE %s (#%s)" % (p["name"], pid)); push_roster()
    return "%s peut a nouveau parler" % p["name"]
def c_unban(i):
    try: b = BANS.pop(int(i))
    except Exception: return "Numero de ban invalide"
    save_bans(); ev("UNBAN %s" % b["name"]); return "%s debanni" % b["name"]
def c_limit(n):
    try: n = max(1, min(200, int(n)))
    except Exception: return "Nombre invalide"
    CFG["max"] = n; push_roster(); ev("Limite = %d" % n); return "Limite de joueurs = %d" % n
def c_msg(text):
    text = str(text)[:160]; broadcast({"t": "msg", "text": text}); ev("MSG : " + text); return "Message envoye"
def act(spec, a, label, **kw):
    r = targets(spec)
    for _, p in r: psend(p, dict({"t": "do", "a": a}, **kw))
    if r: ev("%s -> %s" % (label, ", ".join(p["name"] for _, p in r)))
    return "%s : %d joueur(s)" % (label, len(r)) if r else "Joueur introuvable"
def c_give(spec, item, amount=None):
    if item not in ITEMS: return "Objet inconnu"
    defaults = {"ammo": 90, "plate": 3, "stim": 2, "weapon": 1, "health": 100, "kit": 1}
    try:
        amount = defaults[item] if amount is None else int(amount)
        if amount < 1 or amount > 9999: return "Quantite invalide (1 a 9999)"
    except (TypeError, ValueError):
        return "Quantite invalide (1 a 9999)"
    return act(spec, "give", "GIVE %s x%d" % (item, amount), item=item, amount=amount)
def c_heal(spec): return act(spec, "heal", "SOIN")
def c_kill(spec):
    selected = targets(spec)
    allowed = [(i, p) for i, p in selected if not player_in_admin_base(p)]
    if not allowed:
        return "Aucun joueur eliminable (zone Base Admin protegee ou cible introuvable)."
    for _, p in allowed:
        psend(p, {"t": "do", "a": "kill"})
    ev("KILL -> %s" % ", ".join(p["name"] for _, p in allowed))
    return "KILL : %d joueur(s)" % len(allowed)
def c_revive(spec): return act(spec, "revive", "REVIVE")
def c_launch(spec): return act(spec, "launch", "LANCER")
def c_freeze(spec, on):
    for _, p in targets(spec): p["frozen"] = bool(on)
    push_roster(); return act(spec, "freeze", "FREEZE" if on else "UNFREEZE", on=bool(on))
def c_god(spec, on):
    for _, p in targets(spec): p["god"] = bool(on)
    push_roster(); return act(spec, "god", "DIEU on" if on else "DIEU off", on=bool(on))
def c_tp(spec, to):
    d = targets(to)
    if not d: return "Destination introuvable"
    did, dp = d[0]; pos = (dp["state"] or {}).get("p")
    if not pos: return "Position de la destination inconnue"
    n = 0
    for i, p in targets(spec):
        if i == did: continue
        psend(p, {"t": "do", "a": "tp", "p": [pos[0] + random.uniform(-1.5, 1.5), pos[1] + 0.3, pos[2] + random.uniform(-1.5, 1.5)]}); n += 1
    ev("TP %d joueur(s) -> %s" % (n, dp["name"])); return "%d joueur(s) teleporte(s) vers %s" % (n, dp["name"])
def c_dmg(x):
    try: x = max(0.0, min(10.0, float(str(x).replace(",", "."))))
    except Exception: return "Valeur invalide"
    CFG["dmg"] = x; push_roster(); ev("Degats x%.2f" % x); return "Multiplicateur de degats = x%.2f" % x
def c_pvp(on):
    CFG["pvp"] = bool(on); broadcast(settings()); ev("PVP " + ("ON" if on else "OFF"))
    return "PVP " + ("active" if on else "desactive")
def c_bots(on):
    CFG["bots"] = bool(on)
    if not on:
        with LOCK: BOTS.clear()
        push_bots()
    broadcast(settings()); ev("Bots " + ("ON" if on else "OFF"))
    return "Bots " + ("actives" if on else "desactives")
def c_spawn_allowed(on):
    CFG["spawn_allowed"] = bool(on); broadcast(settings())
    ev("Spawn joueurs " + ("autorise" if on else "interdit"))
    return "Spawn des joueurs " + ("autorise" if on else "interdit")
def c_bot_limit(value):
    try: value = max(0, min(64, int(value)))
    except Exception: return "Nombre invalide"
    CFG["max_bots"] = value
    with LOCK:
        while len(BOTS) > value: BOTS.pop(next(iter(BOTS)))
    push_bots(); broadcast(settings()); return "Limite de bots = %d" % value
def c_bot_damage(value):
    try: value = max(0.0, min(50.0, float(str(value).replace(",", "."))))
    except Exception: return "Valeur invalide"
    CFG["bot_damage"] = value; broadcast(settings()); return "Degats des bots = %.1f" % value

def c_bot_cooldown(value):
    try: value = max(0, min(3600, int(value)))
    except Exception: return "Delai invalide (0 a 3600 secondes)"
    CFG["spawn_cooldown"] = value
    broadcast(settings())
    ev("Delai spawn bots non-admin = %d s" % value)
    return "Delai de spawn des joueurs non-admin = %d seconde(s)" % value
def c_resources(data):
    if not isinstance(data, dict): return "Ressources invalides"
    cleaned = {}
    for cat in ("shaders", "packs", "mods"):
        values = data.get(cat, [])
        if not isinstance(values, list): return "Liste %s invalide" % cat
        cleaned[cat] = [str(x)[:100] for x in values[:100]
                        if re.match(r"^[A-Za-z0-9_. -]+$", str(x)) and ".." not in str(x)]
    CFG["resources"] = cleaned
    save_resource_state()
    broadcast({"t": "resources", "data": dict(cleaned)})
    ev("Ressources synchronisees")
    return "Ressources synchronisees"
def c_admin_role(pid, on):
    r = targets(pid)
    if not r: return "Joueur introuvable"
    _, q = r[0]
    with LOCK:
        q["admin"] = bool(on)
        if on: ADMINS.add(q["token"])
        else: ADMINS.discard(q["token"])
    psend(q, {"t": "role", "admin": bool(on)})
    push_roster()
    ev("%s %s admin" % (q["name"], "promu" if on else "retire"))
    return "%s %s admin" % (q["name"], "est maintenant" if on else "n'est plus")

def c_lock(on):
    CFG["locked"] = bool(on); push_roster(); ev("Serveur " + ("verrouille" if on else "ouvert")); return "Serveur " + ("verrouille" if on else "ouvert")
def c_reset():
    with LOCK:
        for p in PLAYERS.values(): p["kills"] = 0; p["deaths"] = 0
    push_roster(); ev("Scores remis a zero"); return "Scores remis a zero"
def c_rename_server(new_name):
    global SERVER_NAME
    clean = re.sub(r"\s+", " ", str(new_name or "")).strip()[:48]
    if len(clean) < 3:
        return "Nom serveur trop court (3 caracteres minimum)"
    if not re.match(r"^[A-Za-z0-9 _.-]+$", clean):
        return "Nom serveur invalide (lettres, chiffres, espace, . _ -)"
    SERVER_NAME = clean
    save_server_meta()
    broadcast(settings())
    broadcast({"t": "server_renamed", "name": SERVER_NAME})
    ev("Serveur renomme : " + SERVER_NAME)
    return "Serveur renomme en : " + SERVER_NAME

def c_rename(pid, new):
    r = targets(pid)
    if not r: return "Joueur introuvable"
    _, p = r[0]; name, err = check_name(new, me=p["id"])
    if err: return err
    old = p["name"]; p["base"] = name; p["name"] = name; NAMES[p["token"]] = name; save_names(); push_roster(); ev("RENAME %s -> %s" % (old, name)); return "%s renomme en %s" % (old, name)


def console_ui_snapshot():
    """Donnees d'administration visibles uniquement par une session console authentifiee."""
    with LOCK:
        players = []
        for pid, player in sorted(PLAYERS.items()):
            state = player.get("state") or {}
            players.append({
                "id": int(pid), "name": str(player.get("name", "?")),
                "ip": str(player.get("ip") or "-"),
                "hp": int(state.get("hp", 100) or 0),
                "kills": int(player.get("kills", 0)), "deaths": int(player.get("deaths", 0)),
                "admin": bool(player.get("admin")), "muted": bool(is_muted(player)[0]),
                "god": bool(player.get("god")), "vanish": bool(player.get("vanish")),
                "ghost": bool(player.get("ghost")), "freecam": bool(player.get("freecam")),
                "frozen": bool(player.get("frozen")),
                "dead": bool((player.get("state") or {}).get("dead")),
            })
        bans = [{"index": i, "name": str(item.get("name", "?")),
                 "ip": str(item.get("ip") or "-"), "when": str(item.get("when", "")),
                 "reason": str(item.get("reason", ""))}
                for i, item in enumerate(BANS)]
        mutes = [{"index": i, "name": str(item.get("name", "?")),
                  "when": str(item.get("when", "")), "reason": str(item.get("reason", ""))}
                 for i, item in enumerate(MUTES)]
        reminders = [{"id": int(item.get("id", 0)), "text": str(item.get("text", "")),
                      "interval": int(item.get("interval", 60)),
                      "active": bool(item.get("active", True))}
                     for item in REMINDERS]
        reports = [{"id": int(item.get("id", 0)), "from": str(item.get("from", "?")),
                    "target": str(item.get("target", "?")), "when": str(item.get("when", "")),
                    "reason": str(item.get("reason", "")), "reviewed": bool(item.get("reviewed"))}
                   for item in REPORTS[-100:]]
        cfg = dict(CFG)
        cfg["resources"] = dict(CFG.get("resources", {}))
        server = {
            "name": str(SERVER_NAME), "instance": str(INSTANCE_ID), "port": int(PORT),
            "url": str(TUNNEL.get("url") or ""), "tunnel_state": str(TUNNEL.get("state") or "indisponible"),
            "lan_ip": lan_ip(), "local_url": "http://localhost:%d/autre/index.html" % PORT,
            "players": len(PLAYERS), "bans": len(BANS), "mutes": len(MUTES),
            "bots_count": len(BOTS), "events": list(EVENTS)[-20:],
        }
    return {"players": players, "bans": bans, "mutes": mutes,
            "reminders": reminders, "reports": reports, "cfg": cfg, "server": server}


def console_ui_handle(p, message):
    """API structurée du tableau de bord : toutes les mutations restent autoritaires côté serveur."""
    if not p.get("console_admin"):
        psend(p, {"t": "console_ui_res", "ok": False,
                  "message": "Acces refuse : authentifie la console avec ton code admin."})
        return
    action = str(message.get("action") or "snapshot")[:40]
    data = message.get("data") if isinstance(message.get("data"), dict) else {}
    result = ""
    ok = True
    try:
        if action == "snapshot":
            pass
        elif action == "set_resources":
            result = c_resources(data)
        elif action == "resource_reset":
            broadcast({"t": "resource_reset", "seconds": 10})
            ev("Redemarrage synchronise des ressources demande par %s" % p.get("name", "admin"))
            result = "Rechargement synchronise annonce a tous les joueurs (10 secondes)."
        elif action == "set_limit":
            result = c_limit(data.get("value"))
        elif action == "ban_player":
            result = c_ban(data.get("id"), data.get("reason", ""))
        elif action == "unban_one":
            result = c_unban(data.get("index"))
        elif action == "unban_all":
            with LOCK:
                count = len(BANS)
                BANS.clear()
                save_bans()
            ev("Tous les bans retires depuis le panneau integre")
            result = "%d ban(s) retire(s)." % count
        elif action == "kick_player":
            result = c_kick(data.get("id"), data.get("reason", ""))
        elif action == "message_all":
            text_value = str(data.get("text") or "").strip()
            result = c_msg(text_value) if text_value else "Le message est vide."
        elif action == "toggle_lock":
            result = c_lock(not bool(CFG.get("locked")))
        elif action == "set_damage":
            result = c_dmg(data.get("value"))
        elif action == "reset_scores":
            result = c_reset()
        elif action == "promote_admin":
            result = c_admin_role(data.get("id"), True)
        elif action == "demote_admin":
            result = c_admin_role(data.get("id"), False)
        elif action == "toggle_pvp":
            result = c_pvp(not bool(CFG.get("pvp")))
        elif action == "toggle_bots":
            result = c_bots(not bool(CFG.get("bots")))
        elif action == "toggle_spawn":
            result = c_spawn_allowed(not bool(CFG.get("spawn_allowed")))
        elif action == "kill_all_bots":
            result = kill_all_bots()
        elif action == "set_bot_cooldown":
            result = c_bot_cooldown(data.get("value"))
        elif action == "rename_server":
            result = c_rename_server(data.get("name", ""))
        elif action == "ban_ip":
            result = c_ban_ip(data.get("ip", ""), data.get("reason", ""))
        elif action == "mute_player":
            result = c_mute(data.get("id"), data.get("reason", ""))
        elif action == "unmute_one":
            try:
                index = int(data.get("index"))
                item = MUTES[index]
            except (TypeError, ValueError, IndexError):
                result = "Numero de mute invalide."
            else:
                token_value = item.get("token")
                MUTES.pop(index)
                save_mutes()
                for player in list(PLAYERS.values()):
                    if player.get("token") == token_value:
                        psend(player, {"t": "sanction", "kind": "unmute", "reason": ""})
                push_roster()
                result = "Mute retire pour %s." % item.get("name", "ce joueur")
        elif action == "unmute_all":
            tokens = {item.get("token") for item in MUTES}
            count = len(MUTES)
            MUTES.clear()
            save_mutes()
            for player in list(PLAYERS.values()):
                if player.get("token") in tokens:
                    psend(player, {"t": "sanction", "kind": "unmute", "reason": ""})
            push_roster()
            result = "%d mute(s) retire(s)." % count
        elif action == "rename_player":
            result = c_rename(data.get("id"), data.get("name", ""))
        elif action == "reminder_add":
            text_value = str(data.get("text") or "").strip()[:800]
            try: interval = int(data.get("interval"))
            except (TypeError, ValueError): interval = 0
            if not text_value:
                result = "Le texte du rappel est vide."
            elif not 1 <= interval <= 9999999999:
                result = "Delai invalide (1 a 9999999999 secondes)."
            else:
                with LOCK:
                    rid = NEXT_REMINDER_ID[0]; NEXT_REMINDER_ID[0] += 1
                    REMINDERS.append({"id": rid, "text": text_value, "interval": interval,
                                      "next_at": time.time() + interval, "active": True})
                save_reminders(); ev("Rappel #%d cree via le panneau integre" % rid)
                result = "Rappel #%d cree." % rid
        elif action == "reminder_edit":
            try: rid, interval = int(data.get("id")), int(data.get("interval"))
            except (TypeError, ValueError): rid, interval = 0, 0
            item = next((r for r in REMINDERS if r.get("id") == rid), None)
            text_value = str(data.get("text") or "").strip()[:800]
            if not item:
                result = "Rappel introuvable."
            elif not 1 <= interval <= 9999999999:
                result = "Delai invalide (1 a 9999999999 secondes)."
            elif not text_value:
                result = "Le texte du rappel est vide."
            else:
                item.update({"interval": interval, "text": text_value, "next_at": time.time() + interval})
                save_reminders(); ev("Rappel #%d modifie via le panneau integre" % rid)
                result = "Rappel #%d modifie." % rid
        elif action == "reminder_delete":
            try: rid = int(data.get("id"))
            except (TypeError, ValueError): rid = -1
            before = len(REMINDERS)
            REMINDERS[:] = [r for r in REMINDERS if r.get("id") != rid]
            if len(REMINDERS) == before:
                result = "Rappel introuvable."
            else:
                save_reminders(); ev("Rappel #%d supprime via le panneau integre" % rid)
                result = "Rappel #%d supprime." % rid
        elif action == "reminder_toggle":
            try: rid = int(data.get("id"))
            except (TypeError, ValueError): rid = -1
            item = next((r for r in REMINDERS if r.get("id") == rid), None)
            if not item:
                result = "Rappel introuvable."
            else:
                item["active"] = not bool(item.get("active", True))
                if item["active"]: item["next_at"] = time.time() + item["interval"]
                save_reminders(); ev("Rappel #%d %s via panneau integre" % (rid, "active" if item["active"] else "mis en pause"))
                result = "Rappel #%d %s." % (rid, "actif" if item["active"] else "en pause")
        elif action == "report_review":
            target = str(data.get("id", "")).strip().lower()
            changed = 0
            if target == "all":
                for item in REPORTS:
                    if not item.get("reviewed"):
                        item["reviewed"] = True; changed += 1
            else:
                try: rid = int(target)
                except ValueError: rid = -1
                for item in REPORTS:
                    if item.get("id") == rid and not item.get("reviewed"):
                        item["reviewed"] = True; changed = 1; break
            save_reports()
            result = "%d signalement(s) marque(s) comme traite(s)." % changed
        else:
            ok = False
            result = "Action inconnue."
    except Exception as exc:
        ok = False
        result = "Erreur pendant l'action : %s" % str(exc)[:180]
        ev("Erreur panneau integre (%s) : %s" % (action, str(exc)[:120]))
    psend(p, {"t": "console_ui_res", "ok": ok, "action": action,
              "message": result, "snapshot": console_ui_snapshot()})


def c_bring_base(spec, exclude_id=None):
    moved = []
    for pid, target in targets(spec):
        if exclude_id is not None and pid == exclude_id:
            continue
        safe_pos = [random.uniform(-3.5, 3.5), 0.0, 70.0 + random.uniform(-3.5, 3.5)]
        if target.get("state") is None:
            target["state"] = {"p": safe_pos}
        else:
            target["state"]["p"] = safe_pos
        psend(target, {"t": "do", "a": "tp", "p": safe_pos})
        moved.append(target["name"])
    if moved:
        ev("BRING Base Admin -> %s" % ", ".join(moved))
    return "Joueur(s) amene(s) a la Base Admin : %d" % len(moved)


def admin_exec(p, m):
    c = m.get("cmd"); i = m.get("id")
    if i != "all":
        try: i = int(i) if i is not None else None
        except Exception: i = None
    me = p["id"]
    if c == "list":
        psend(p, {"t": "alist", "players": roster(p), "bans": [b["name"] for b in BANS], "settings": settings()}); return None
    if c == "bring": return c_bring_base(i, exclude_id=me)
    if c == "goto": return c_tp(me, i)
    if c == "tp": return c_tp(i, m.get("to"))
    if c == "give": return c_give(i, m.get("item"), m.get("amount"))
    if c == "heal": return c_heal(i)
    if c == "kill": return c_kill(i)
    if c == "revive": return c_revive(i)
    if c == "launch": return c_launch(i)
    if c == "freeze": return c_freeze(i, m.get("on"))
    if c == "god": return c_god(i, m.get("on"))
    if c == "reset": return c_reset()
    if c == "msg": return c_msg(m.get("text", ""))
    if c == "pvp": return c_pvp(m.get("on"))
    if c == "bots": return c_bots(m.get("on"))
    if c == "spawn_allowed": return c_spawn_allowed(m.get("on"))
    if c == "killbots": return kill_all_bots()
    if c == "bot_limit": return c_bot_limit(m.get("n"))
    if c == "bot_damage": return c_bot_damage(m.get("x"))
    if c in ("bot_cooldown", "spawncooldown"): return c_bot_cooldown(m.get("n"))
    if c == "spawn_bot":
        return "Bot spawne : %s" % (try_spawn_bot(p) or "limite atteinte/desactive")
    if c == "resources": return c_resources(m.get("data"))
    if c == "resource_reset":
        broadcast({"t": "resource_reset", "seconds": 10})
        ev("Redemarrage de ressources demande par %s" % p["name"])
        return "Redemarrage annonce aux joueurs (10 secondes)"
    return "Commande inconnue"

# ------------------------------------------------------------------ chat + commandes
def sysmsg(p, text): psend(p, {"t": "chat", "kind": "sys", "text": text})
def admins(): 
    with LOCK: return [q for q in PLAYERS.values() if q["admin"]]
def find_player(tok):
    tok = tok.lstrip("#")
    with LOCK:
        if tok.isdigit() and int(tok) in PLAYERS: return PLAYERS[int(tok)]
        ex = [q for q in PLAYERS.values() if q["base"].lower() == tok.lower()]
        if ex: return ex[0]
        pre = [q for q in PLAYERS.values() if q["base"].lower().startswith(tok.lower())]
        return pre[0] if len(pre) == 1 and tok else None
def spec_of(p, tok, allow_all=True):
    if tok.lower() in ("all", "tous") and allow_all: return "all"
    q = find_player(tok)
    return q["id"] if q else None

# Commandes utilisables dans le chat : uniquement les actions de jeu.
ADMIN_CMDS = (
    "all", "god", "godmod", "tp", "bring", "give", "heal", "kill", "revive",
    "freeze", "unfreeze", "launch", "vanish", "ghost", "freecam", "tpb"
)
# Les operations de gestion du serveur restent dans la console CMD du serveur.
SERVER_ONLY_CHAT_CMDS = {
    "ban", "unban", "kick", "rename", "lock", "limit", "dmg", "pvp", "bots",
    "spawn_allowed", "killbots", "bot_limit", "bot_damage", "bot_cooldown",
    "spawncooldown", "spawn_bot", "reset", "resource_reset", "resources", "players",
    "banip", "mute", "unmute", "serverrename", "rename_server", "renameserver"
}
PLAYER_COMMANDS_TXT = ("Commandes disponibles : /all, /commands, /cmds ou /? = afficher cette liste | "
                       "/mp nom_admin message = message prive a un admin | "
                       "/report nom raison = signaler un joueur aux admins | "
                       "/help message = contacter les admins | message sans / = chat public.")
HELP_TXT = PLAYER_COMMANDS_TXT
HELP_ADM = ("Admin chat : /all message | /god joueur|all [on|off] | /tp joueur [destination] | "
            "/bring joueur|all (Base Admin) | /tpb | /give joueur|all objet [quantite] | "
            "/heal /kill /revive /launch /freeze /unfreeze joueur|all | /vanish | /ghost | /freecam. "
            "Ban, mute, kick, rename et reglages serveur : console CMD uniquement.")


def submit_report(p, rest):
    args = rest.split(None, 1)
    if len(args) < 2 or not args[0].strip() or not args[1].strip():
        sysmsg(p, "Utilisation : /report nom_du_joueur raison_du_signalement")
        return
    target = re.sub(r"[^A-Za-z0-9_ -]", "", args[0]).strip()[:32]
    reason = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", args[1]).strip()[:300]
    if not target or len(reason) < 3:
        sysmsg(p, "Indique un joueur et une raison precise (3 caracteres minimum).")
        return
    with LOCK:
        rid = max([int(r.get("id", 0)) for r in REPORTS] or [0]) + 1
        item = {"id": rid, "from": p["name"], "target": target, "reason": reason,
                "when": now(), "reviewed": False}
        REPORTS.append(item)
        del REPORTS[:-500]
    save_reports()
    for admin in admins():
        psend(admin, {"t": "chat", "kind": "report", "from": p["name"],
                      "to": target, "text": reason})
    sysmsg(p, "Signalement envoye. Un administrateur le consultera.")
    ev("REPORT #%d : %s signale %s" % (rid, p["name"], target))


def chat(p, text):
    if not text: return
    now_t = time.time(); dq = p["chat"]
    if not p["admin"] and len(dq) == dq.maxlen and now_t - dq[0] < 4:
        sysmsg(p, "Doucement : trop de messages."); return
    dq.append(now_t)
    if not text.startswith("/"):
        muted, mute_reason = is_muted(p)
        if muted:
            sysmsg(p, "Tu es mute sur ce serveur." + (" Motif : " + mute_reason if mute_reason else "")); return
        broadcast({"t": "chat", "kind": "pub", "from": p["name"], "admin": p["admin"], "text": text}); return

    parts = text[1:].split(None, 1)
    cmd = parts[0].lower() if parts else ""
    rest = parts[1].strip() if len(parts) > 1 else ""
    muted, mute_reason = is_muted(p)
    if muted and cmd != "report":
        sysmsg(p, "Tu es mute sur ce serveur." + (" Motif : " + mute_reason if mute_reason else "")); return
    if cmd == "report":
        submit_report(p, rest); return
    if cmd in SERVER_ONLY_CHAT_CMDS:
        sysmsg(p, "Cette commande est disponible uniquement dans la console CMD du serveur.")
        return
    if cmd == "all" and not p["admin"]:
        sysmsg(p, PLAYER_COMMANDS_TXT); return
    if cmd in ADMIN_CMDS and not p["admin"]:
        sysmsg(p, "Commande reservee aux admins."); return
    if cmd == "help":
        if not rest:
            sysmsg(p, PLAYER_COMMANDS_TXT + (" | " + HELP_ADM if p["admin"] else "")); return
        ad = [q for q in admins() if q is not p]
        psend(p, {"t": "chat", "kind": "help_out", "text": rest})
        if not ad:
            sysmsg(p, "Aucun admin en ligne pour l'instant."); return
        for q in ad: psend(q, {"t": "chat", "kind": "help", "from": p["name"], "text": rest})
        ev("AIDE de %s : %s" % (p["name"], rest[:60])); return
    if cmd in ("mp", "msg", "w", "tell"):
        a = rest.split(None, 1)
        if len(a) < 2: sysmsg(p, "Utilisation : /mp nom message"); return
        q = find_player(a[0])
        if not q: sysmsg(p, "Joueur introuvable : %s" % a[0]); return
        if q is p: sysmsg(p, "Tu ne peux pas t'ecrire a toi-meme."); return
        if not p["admin"] and not q["admin"]:
            sysmsg(p, "La commande /mp des joueurs est reservee aux messages vers les admins. Utilise /help pour contacter l'equipe."); return
        psend(q, {"t": "chat", "kind": "mp", "from": p["name"], "to": q["name"], "text": a[1]})
        psend(p, {"t": "chat", "kind": "mp_out", "from": p["name"], "to": q["name"], "text": a[1]})
        for ad in admins():
            if ad is not p and ad is not q:
                psend(ad, {"t": "chat", "kind": "spy", "from": p["name"], "to": q["name"], "text": a[1]})
        return
    if cmd in ("commands", "cmds", "?"):
        sysmsg(p, PLAYER_COMMANDS_TXT + (" | " + HELP_ADM if p["admin"] else "")); return
    if cmd in ("vanish", "ghost", "freecam"):
        if not p["admin"]:
            sysmsg(p, "Commande reservee aux admins."); return
        p[cmd] = not bool(p.get(cmd))
        if p[cmd] and cmd == "freecam":
            # Freecam rend egalement le modele invisible, sans activer le masquage de roster Ghost.
            pass
        sync_player_visibility(p)
        sysmsg(p, "%s %s" % (cmd.capitalize(), "active" if p[cmd] else "desactive"))
        ev("%s %s pour %s" % (cmd.upper(), "ON" if p[cmd] else "OFF", p["name"]))
        return
    if cmd == "tpb":
        if not p["admin"]:
            sysmsg(p, "Commande reservee aux admins."); return
        if p.get("state") is None: p["state"] = {"p": [0.0, 0.0, 70.0]}
        else: p["state"]["p"] = [0.0, 0.0, 70.0]
        psend(p, {"t": "do", "a": "tp", "p": [0.0, 0.0, 70.0]})
        sysmsg(p, "Teleporte vers la Base Admin. Zone protegee.")
        return
    if not p["admin"] or cmd not in ADMIN_CMDS:
        sysmsg(p, "Commande inconnue. " + HELP_TXT); return

    a = rest.split()
    def tgt(i=0, allow_all=True):
        if len(a) <= i: return None
        return spec_of(p, a[i], allow_all)
    def need(sp):
        if sp is None:
            sysmsg(p, "Joueur introuvable (ou manquant). Exemple : /%s nom" % cmd); return False
        return True
    def onoff(current, label):
        if not a: return not bool(current)
        v = a[0].lower()
        if v in ("on", "1", "true", "oui", "o"): return True
        if v in ("off", "0", "false", "non", "n"): return False
        sysmsg(p, "Utilisation : /%s on|off" % label); return None

    if cmd == "all":
        if not rest: sysmsg(p, "Utilisation : /all message"); return
        sysmsg(p, c_msg(rest)); return
    sp = tgt(0)
    if cmd in ("god", "godmod"):
        if not need(sp): return
        if len(a) > 1 and a[1].lower() in ("on", "off"):
            on = a[1].lower() == "on"
        else:
            q0 = PLAYERS.get(sp) if sp != "all" else None
            on = (not q0["god"]) if q0 else True
        sysmsg(p, c_god(sp, on)); return
    if cmd == "tp":
        if not need(sp) or sp == "all": return
        dest = tgt(1, False)
        sysmsg(p, c_tp(sp, dest) if dest is not None else c_tp(p["id"], sp)); return
    if cmd == "bring":
        if not need(sp): return
        sysmsg(p, c_bring_base(sp, exclude_id=p["id"])); return
    if cmd == "give":
        if not need(sp): return
        it = a[1].lower() if len(a) > 1 else ""
        alias = {"munitions": "ammo", "plaques": "plate", "plaque": "plate",
                 "stimulant": "stim", "arme": "weapon", "sante": "health", "vie": "health"}
        it = alias.get(it, it)
        amount = a[2] if len(a) > 2 else None
        sysmsg(p, c_give(sp, it, amount) if it in ITEMS else "Objet : " + ", ".join(ITEMS)); return
    if not need(sp): return
    if cmd == "heal": sysmsg(p, c_heal(sp))
    elif cmd == "kill": sysmsg(p, c_kill(sp))
    elif cmd == "revive": sysmsg(p, c_revive(sp))
    elif cmd == "launch": sysmsg(p, c_launch(sp))
    elif cmd == "freeze": sysmsg(p, c_freeze(sp, not (len(a) > 1 and a[1].lower() == "off")))
    elif cmd == "unfreeze": sysmsg(p, c_freeze(sp, False))

# ------------------------------------------------------------------ HTTP
BLOCK = (".py", ".json", ".bat", ".exe", ".part", ".pyc")
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def end_headers(self):
        self.send_header("Cache-Control", "no-store"); super().end_headers()
    def _json_response(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != "/_resource_upload":
            self.send_error(404); return
        token_value = self.headers.get("X-WZ-Upload-Token", "")
        if not resource_upload_authorized(token_value):
            self._json_response(403, {"ok": False, "message": "Session admin expiree ou invalide. Reconnecte-toi au centre admin."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._json_response(400, {"ok": False, "message": "Aucun fichier recu."}); return
        if length > RESOURCE_UPLOAD_MAX_BYTES:
            self._json_response(413, {"ok": False, "message": "Fichier trop volumineux (32 Mo maximum)."}); return
        category = self.headers.get("X-WZ-Category", "")
        filename = self.headers.get("X-WZ-Filename", "fichier")
        try:
            payload = self.rfile.read(length)
            if len(payload) != length:
                raise ValueError("Transfert incomplet.")
            result = store_uploaded_resource(category, filename, payload)
            self._json_response(200, dict({"ok": True}, **result))
        except (ValueError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
            self._json_response(400, {"ok": False, "message": str(exc)[:240]})
        except Exception as exc:
            ev("Erreur import ressource : %s" % str(exc)[:140])
            self._json_response(500, {"ok": False, "message": "Erreur serveur pendant l'import du fichier."})

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/_instance":
            b = json.dumps({"id": INSTANCE_ID}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        if path == "/ws" and "websocket" in self.headers.get("Upgrade", "").lower():
            ws_session(self); self.close_connection = True; return
        if path.lower().endswith(BLOCK) and not path.startswith(("/mods/", "/texturepacks/")):
            self.send_error(404); return
        if self.path.startswith("/_ls/"):
            parts = self.path[5:].split("?")[0].strip("/").split("/")
            ok = parts[0] in ALLOWED and ".." not in parts
            full = os.path.join(ROOT, *parts); out = []
            if ok and os.path.isdir(full):
                for n in sorted(os.listdir(full)): out.append({"name": n, "dir": os.path.isdir(os.path.join(full, n))})
            b = json.dumps(out).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        super().do_GET()
    def log_message(self, *a): pass

class Srv(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]; s.close(); return ip
    except Exception: return "127.0.0.1"
