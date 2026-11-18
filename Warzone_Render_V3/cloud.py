# Lanceur pour hebergement (Render). Aucune console, aucun tunnel.
import os, sys, time, threading
os.environ["WZ_NOTUNNEL"] = "1"
os.environ["NO_BROWSER"] = "1"
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "autre"))
os.chdir(os.path.join(HERE, "autre"))
import serve

def main():
    serve.load_server_meta(); serve.load_bans(); serve.load_mutes()
    serve.load_names(); serve.load_reports(); serve.load_reminders(); serve.load_resource_state()
    srv = serve.Srv(("0.0.0.0", serve.PORT), serve.H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=serve.bot_loop, daemon=True).start()
    threading.Thread(target=serve.reminder_loop, daemon=True).start()
    serve.ev("Serveur demarre (cloud)")
    print("Serveur pret sur le port %d" % serve.PORT, flush=True)
    while True:
        time.sleep(3600)

if __name__ == "__main__":
    main()
