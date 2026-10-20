-- Schéma de la bibliothèque Altium (idempotent : exécuté à chaque démarrage)

CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  full_name     text NOT NULL,
  short_name    text NOT NULL,
  email         text NOT NULL UNIQUE,
  role          text NOT NULL CHECK (role IN ('admin','librarian','designer')),
  titles        text[] NOT NULL DEFAULT '{}',
  color         text NOT NULL DEFAULT '#3d5a99',
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id     text PRIMARY KEY,
  labels jsonb NOT NULL,               -- {"fr": "...", "en": "..."}
  sort   int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id         text PRIMARY KEY,
  group_id   text NOT NULL REFERENCES groups(id),
  labels     jsonb NOT NULL,           -- {"fr": "...", "en": "..."}
  params     jsonb NOT NULL DEFAULT '[]',  -- [{"k","labels":{fr,en},"u","si"}]
  view_name  text NOT NULL UNIQUE,     -- nom de la table vue par Altium
  sort       int NOT NULL DEFAULT 0,
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS part_seq START 1;

CREATE TABLE IF NOT EXISTS parts (
  id              text PRIMARY KEY,               -- LIB-000123, clé stable de la DbLib
  cat             text NOT NULL REFERENCES categories(id),
  mpn             text NOT NULL,
  mfr             text NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  comment         text NOT NULL DEFAULT '',
  package         text NOT NULL DEFAULT '',
  mount           text NOT NULL DEFAULT 'smd' CHECK (mount IN ('smd','tht')),
  tmin            double precision,
  tmax            double precision,
  lifecycle       text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','nrnd','obsolete')),
  params          jsonb NOT NULL DEFAULT '{}',    -- valeurs brutes (nombres SI ou texte)
  params_display  jsonb NOT NULL DEFAULT '{}',    -- valeurs mises en forme pour Altium
  suppliers       jsonb NOT NULL DEFAULT '[]',    -- [["Mouser","595-..."], ...]
  alternates      jsonb NOT NULL DEFAULT '[]',    -- [["Samsung","CL10..."], ...]
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','valid','archived')),
  symbol_ref      text,
  symbol_file     text,                            -- chemin relatif au partage (lib/...)
  footprint_ref   text,
  footprint_file  text,
  pins            int,
  pads            int,
  has_3d          boolean NOT NULL DEFAULT false,
  datasheet_sha   text,
  datasheet_name  text,
  datasheet_url   text,
  pending         jsonb,                           -- modification proposée en attente
  created_by      text NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  validated_by    text REFERENCES users(id),
  validated_at    timestamptz,
  archived_by     text REFERENCES users(id),
  archived_at     timestamptz,
  archive_reason  text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS parts_mpn_uniq ON parts (lower(mpn));
CREATE INDEX IF NOT EXISTS parts_cat_idx ON parts (cat);

CREATE TABLE IF NOT EXISTS history (
  id      bigserial PRIMARY KEY,
  part_id text NOT NULL,
  action  text NOT NULL,       -- ask, info, edit, propose, applied, rejected, archived, restored
  user_id text NOT NULL REFERENCES users(id),
  data    jsonb NOT NULL DEFAULT '{}',
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS history_part_idx ON history (part_id);

CREATE TABLE IF NOT EXISTS notifications (
  id        bigserial PRIMARY KEY,
  from_user text NOT NULL REFERENCES users(id),
  to_user   text NOT NULL REFERENCES users(id),
  part_id   text NOT NULL,
  part_mpn  text NOT NULL DEFAULT '',
  kind      text NOT NULL,     -- validate, info, validated, change, changeOk, changeKo, archived, deleted
  message   text NOT NULL DEFAULT '',
  read      boolean NOT NULL DEFAULT false,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_to_idx ON notifications (to_user, read);

CREATE TABLE IF NOT EXISTS datasheets (
  sha         text PRIMARY KEY,
  filename    text NOT NULL,
  size        bigint NOT NULL,
  uploaded_by text REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE SCHEMA IF NOT EXISTS altium;

-- Marqueurs des opérations de maintenance déjà effectuées
CREATE TABLE IF NOT EXISTS app_meta (
  key   text PRIMARY KEY,
  value text NOT NULL,
  at    timestamptz NOT NULL DEFAULT now()
);
