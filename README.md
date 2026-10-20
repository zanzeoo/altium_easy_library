# Bibliothèque Altium auto-hébergée

Application web pour gérer une bibliothèque de composants Altium partagée par l'équipe :
exploration paramétrique, ajout par glisser-déposer, circuit de validation, notifications internes,
historique. Altium lit la bibliothèque comme une **Database Library (DbLib)** via ODBC.

```
 Postes Windows (Altium 26)                       Serveur interne (Docker)
┌──────────────────────────┐   ODBC 5432    ┌───────────────────────────────────────┐
│ Bibliotheque.DbLib ──────┼───────────────►│ db      PostgreSQL 17                 │
│                          │  (lecture seule)│         vues « altium.* » par catégorie│
│ \\serveur\altium-lib ────┼───────────────►│ samba   partage SMB en lecture seule  │
│  (SchLib / PcbLib)       │   SMB 445      │                ▲                      │
│ Navigateur ──────────────┼───────────────►│ app     FastAPI + altium_monkey       │
└──────────────────────────┘   HTTP 8080    │         import, rendu SVG, git        │
                                            └───────────────────────────────────────┘
```

## Contenu

| Dossier | Rôle |
|---|---|
| `app/` | Application (Python 3.12, FastAPI, altium_monkey) et interface web (`app/app/static`) |
| `app/app/static/locales/` | Fichiers de langue `fr.json` et `en.json` |
| `samba/` | Partage réseau en lecture seule des fichiers SchLib/PcbLib |
| `docker-compose.yml` | Les trois services : `db`, `app`, `samba` |
| `.env.example` | Toute la configuration, à copier en `.env` |

## Installation sur le serveur

Prérequis : un serveur Linux **x86_64** avec Docker et Docker Compose. altium_monkey s'appuie sur
un module (`wn-geometer`) publié uniquement pour x86_64 ; un Raspberry Pi ne convient pas.

```bash
git clone … altium-lib && cd altium-lib     # ou décompresser l'archive
cp .env.example .env
nano .env                                    # remplacer toutes les valeurs « changez-moi »
docker compose up -d --build
docker compose logs -f app                   # « Vues Altium prêtes : … » = tout est en place
```

Puis ouvrir `http://serveur:8080` et se connecter avec `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
L'administrateur n'est créé qu'au premier démarrage, quand la base est vide.

Valeurs importantes du `.env` :

- `PUBLIC_URL` : adresse de l'application vue des postes. Elle sert aux liens datasheet dans Altium.
- `ODBC_HOST` : nom du serveur tel qu'il apparaîtra dans la chaîne de connexion.
- `ALTIUM_RO_PASSWORD` : mot de passe du compte lecture seule utilisé par Altium.
- `SMB_PASSWORD` : mot de passe du partage réseau (utilisateur `SMB_USER`).
- `ALTIUM_LANG` : langue des noms de tables et colonnes dans Altium (`fr` ou `en`).
- `MOUSER_API_KEY` (facultatif) : active le bouton « Compléter via Mouser ».

Ports ouverts : 8080 (web), 5432 (PostgreSQL, pour ODBC), 445 (SMB). Si le serveur a déjà un
partage Windows/Samba sur le port 445, changez `SMB_PORT` ou utilisez votre partage existant
(voir plus bas).

## Premiers pas dans l'application

1. **Équipe** (menu utilisateur, en haut à droite) : l'administrateur crée les comptes avec un
   **rôle** (administrateur, bibliothécaire, concepteur) et des **titres** (Auteur, Valideur,
   Qualité, Achats). Seuls bibliothécaires et administrateurs valident ; les titres servent à
   proposer les bons destinataires.
2. **Configurer Altium** (menu utilisateur, réservé aux bibliothécaires) : la chaîne de connexion
   ODBC prête à copier, les tables visibles par Altium, et le dépôt du fichier `.DbLib`.
3. **Ajouter un composant** : glisser l'archive du fabricant (`.zip`), un `.IntLib`, ou des fichiers
   `.SchLib` / `.PcbLib` / `.step` / `.pdf`. Le serveur les analyse, propose le symbole, l'empreinte
   associée et les paramètres trouvés (MPN, fabricant, distributeurs, lien datasheet), vérifie la
   concordance broches/pads, puis crée le composant en **brouillon**.

## Configuration d'Altium (une seule fois)

Sur **chaque poste** :

1. Installer le pilote ODBC PostgreSQL 64 bits ([psqlODBC](https://www.postgresql.org/ftp/odbc/releases/),
   pilote « PostgreSQL Unicode(x64) »).
2. Pouvoir ouvrir `\\serveur\altium-lib` avec le compte `SMB_USER` (l'enregistrer dans le
   gestionnaire d'identifiants Windows).
   L'identifiant doit être préfixé par le serveur, sinon Windows envoie le nom du compte
   Microsoft ou du domaine et Samba refuse la connexion :

   ```cmd
   net use * /delete /y
   net use Z: \\serveur\altium-lib /user:serveur\altium VOTRE_SMB_PASSWORD /persistent:yes
   ```

   Dans la fenêtre d'identification de l'Explorateur, saisir de même `serveur\altium`
   (*Autres choix › Utiliser un autre compte*).

Par **un bibliothécaire**, une fois :

1. Dans Altium : *File » New » Library » Database Library*.
2. *Use Connection String* : coller la chaîne affichée dans « Configurer Altium ».
3. *Options* : guillemet double `"` comme caractère de citation gauche et droit.
4. Pour chaque table : champ clé **Part Number**. Altium reconnaît seul `Library Ref`,
   `Library Path`, `Footprint Ref` et `Footprint Path`.
5. *Symbol & Model Search Path* : `\\serveur\altium-lib`, avec la recherche dans les sous-dossiers.
6. Enregistrer le `.DbLib`, puis le déposer via « Configurer Altium » : il est placé à la racine du
   partage. Chaque poste l'ajoute ensuite depuis `\\serveur\altium-lib\Bibliotheque.DbLib`
   (*Components » ⋮ » File-based Libraries Preferences*).

Ce que voit Altium : une table par catégorie (ex. `Condensateurs`), avec seulement les composants
**validés** et non archivés. Une modification en attente n'apparaît qu'une fois acceptée. Côté
schémas existants : *Tools » Update Parameters From Database* et *Update From Libraries*.

Une nouvelle catégorie créée dans l'application devient une nouvelle table : la rafraîchir ou l'activer
dans le `.DbLib`.

## Cycle de vie d'un composant

| Action | Qui | Effet |
|---|---|---|
| Ajouter | tout le monde | brouillon, invisible dans Altium ; demande de validation possible |
| Valider | bibliothécaire | visible dans Altium ; l'auteur est notifié |
| Modifier un brouillon | auteur ou bibliothécaire | appliqué directement |
| Modifier un composant validé | auteur ou bibliothécaire | **proposition** ; Altium garde l'ancienne version jusqu'à acceptation |
| Supprimer | auteur ou bibliothécaire, brouillon seulement | définitif |
| Archiver / restaurer | bibliothécaire | retiré d'Altium, les designs existants gardent leurs liens |

Chaque action est tracée dans l'historique du composant, et chaque écriture de fichier fait l'objet
d'un commit git signé par son auteur dans le volume de la bibliothèque.

## Données et sauvegarde

| Volume | Contenu |
|---|---|
| `pgdata` | base PostgreSQL (composants, utilisateurs, historique, notifications) |
| `libdata` | `/data/lib` (SchLib/PcbLib, `.DbLib`, dépôt git), `/data/datasheets` (PDF), `/data/work` (temporaire) |

Sauvegarde minimale :

```bash
docker compose exec -T db pg_dump -U altium altiumlib > sauvegarde_$(date +%F).sql
docker run --rm -v altium-lib_libdata:/data -v "$PWD":/out debian:trixie-slim \
  tar czf /out/libdata_$(date +%F).tgz -C /data lib datasheets
```

Arborescence des fichiers dans le partage :

```
\\serveur\altium-lib\
  Bibliotheque.DbLib
  lib\cap\LIB-000001\LIB-000001.SchLib
  lib\cap\LIB-000001\C0603_0.90MM_MD.PcbLib      (STEP intégré)
```

Le symbole est renommé avec la référence interne (`LIB-000001`) ; ses paramètres et son lien
d'empreinte d'origine sont retirés, car ils viennent de la base.

## Utiliser un partage existant (NAS) au lieu de Samba

Supprimer le service `samba` du `docker-compose.yml` et monter le volume `libdata` sur un dossier
du NAS (montage NFS/CIFS sur le serveur, puis `- /mnt/nas/altium:/data` pour le service `app`).
Les postes accèdent alors au NAS en lecture seule.

## Mise à jour

```bash
git pull            # ou nouvelle archive
docker compose up -d --build
```

Le schéma de la base et les vues Altium sont mis à jour automatiquement au démarrage.

## Développement local

```bash
cd app
pip install -r requirements.txt
export DATABASE_URL=postgresql://user:pass@localhost:5432/altiumlib DATA_DIR=./data \
       ADMIN_EMAIL=moi@exemple.fr ADMIN_PASSWORD=motdepasse ALTIUM_RO_PASSWORD=lecture SECRET_KEY=dev
uvicorn app.main:app --reload --port 8080
```

Documentation de l'API : `http://localhost:8080/api/docs`.

## Limites connues de cette version

- Import d'un IntLib ou d'une grosse bibliothèque : un composant à la fois. Pour le suivant, on redépose
  le fichier et on le choisit dans la liste. L'import par lot n'est pas encore fait.
- Pas d'export IntLib, pas d'export KiCad.
- Enrichissement automatique : Mouser uniquement (clé API gratuite).
- Une empreinte est copiée dans le dossier de chaque composant (pas de partage d'empreintes entre
  composants).
- Les archives SamacSys / Ultra Librarian qui ne contiennent qu'un script d'import Altium (pas de
  `.SchLib`/`.PcbLib`) doivent d'abord être ouvertes dans Altium et enregistrées en SchLib/PcbLib.
- Sous Linux, l'aperçu des symboles utilise des polices de substitution intégrées à altium_monkey.

## Licences

altium_monkey est sous licence **AGPL-3.0**. Pour un usage interne, il suffit que le code de cette
application reste accessible aux personnes qui l'utilisent (par exemple dans un dépôt interne).
