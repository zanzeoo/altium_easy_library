"""Point d'entrée : FastAPI, initialisation de la base, des vues Altium et du dépôt git."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import auth, db, gitrepo, maintenance, views
from .api import r

STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.open_pool()
    db.init_schema()
    db.seed()
    auth.ensure_admin()
    with db.tx() as c:
        names = views.regenerate(c)
    print(f"Vues Altium prêtes : {', '.join(names)}")
    gitrepo.init()
    maintenance.run_all()
    yield
    if db.pool:
        db.pool.close()


app = FastAPI(title="Bibliothèque Altium", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.include_router(r)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/health")
def health():
    db.one("SELECT 1 AS ok")
    return {"ok": True}
