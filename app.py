"""
Diriva — Backend de saisie manuelle de CV
==========================================
Flask + SQLite, avec un vrai schéma relationnel normalisé : une table SQL par
élément du modèle Diriva (T_individualHuman, T_trajectory, T_position,
T_institution, etc. — 21 tables pour LesBiographies/Who's Who, 19 pour
LinkedIn qui n'a pas la parenté), fidèle aux schémas d'extraction JSON
d'origine.

Une base par source, dans son propre fichier .db (lesbiographies.db /
linkedin.db / whoswho.db), rangés dans DATA_DIR (voir config.py) —
typiquement un dossier SharePoint/OneDrive synchronisé, pour que deux
machines partagent les mêmes fichiers.

Deux tables additionnelles, propres à cet outil (absentes des schémas
d'origine, qui décrivent une extraction automatique et non une saisie
manuelle) :
  - app_individual_meta : qui a créé/modifié chaque fiche, et quand.
  - history             : journal détaillé (qui a changé quoi, à chaque
                           enregistrement).

Lancer en local :  python app.py   (puis ouvrir http://127.0.0.1:5000)
Voir README.md pour la configuration du dossier partagé.
"""

import json
import os
import re
import sqlite3
import threading
import unicodedata
from collections import Counter
from datetime import date, datetime

from flask import Flask, abort, g, jsonify, render_template, request

from config import DATA_DIR

# ============================================================
# Configuration — interface unique (fusion des anciennes sources)
# ============================================================
# L'application gérait auparavant une base par source (LinkedIn, Who's Who,
# LesBiographies), avec un formulaire différent pour chacune. Elle gère
# désormais UNE SEULE base, avec TOUS les champs réunis dans un même
# formulaire ; la source d'origine de chaque information (identité, chaque
# étape de carrière, chaque formation, chaque distinction, chaque proche,
# chaque document source) est indiquée par un champ "source de la saisie"
# au sein même de la section concernée, plutôt que par le choix d'une base
# au départ.
#
# CFG regroupe les réglages auparavant différents entre sources (jour/mois
# de naissance, parenté) : comme le formulaire réunit maintenant tous les
# champs, les deux sont toujours actifs.
CFG = {"key": "diriva", "label": "Diriva", "hasDayMonth": True, "hasRelatives": True}

# Liste de départ des "sources de saisie" proposées dans les champs source de
# chaque section — complétée librement par les utilisateurs (comme pour les
# postes, institutions, etc.), voir upsert_by_name / referentials.
DATA_SOURCE_TYPES_SEED = ["LinkedIn", "Who's Who in France", "LesBiographies"]

# Fichier unique, dans DATA_DIR — typiquement un dossier SharePoint/OneDrive
# synchronisé, pour que vos deux machines partagent les mêmes fichiers. Voir
# config.py et README.md.
DATA_DIR = os.path.abspath(DATA_DIR)
DB_FILE = os.path.join(DATA_DIR, "gentlemen.db")


def db_path():
    return DB_FILE


# Verrou global : évite qu'une saisie simultanée, DANS UN MÊME PROCESSUS, ne
# fasse perdre les modifications de l'un ou l'autre. Ce verrou ne protège pas
# contre deux processus distincts (vous et votre encadrant, chacun sur sa
# machine) qui écriraient en même temps sur le fichier synchronisé — voir la
# section « Règles d'usage » du README pour la discipline à suivre.
LOCK = threading.Lock()

app = Flask(__name__)

def get_conn():
    conn = g.get("conn")
    if conn is None:
        conn = sqlite3.connect(db_path(), timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.conn = conn
    return conn
 
 
@app.teardown_appcontext
def close_conns(exc):
    conn = g.pop("conn", None)
    if conn:
        conn.close()
 
 
def q(conn, sql, params=()):
    return [dict(r) for r in conn.execute(sql, params).fetchall()]
 
 
def q1(conn, sql, params=()):
    r = conn.execute(sql, params).fetchone()
    return dict(r) if r else None
 
 
# ============================================================
# Schéma SQL — une vraie table par élément du modèle Diriva
# ============================================================
# Champs et clés (composites comprises) fidèles aux fichiers schema_*.json
# fournis. Les colonnes non renseignées par le formulaire (ex. T_institutionPlace,
# qui suppose une adresse d'institution non collectée ici) existent bien comme
# tables réelles, mais restent vides tant que l'interface ne les alimente pas.
 
def schema_statements(cfg):
    stmts = []
 
    day_month_cols = ""
    if cfg["hasDayMonth"]:
        day_month_cols = "IND_birthDay INTEGER,\n  IND_birthMonth INTEGER,\n  "
 
    stmts.append(f"""
        CREATE TABLE IF NOT EXISTS T_individualHuman (
          IND_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          IND_birthName TEXT NOT NULL,
          IND_marriedName TEXT,
          IND_commonName TEXT,
          IND_usualFirstname TEXT NOT NULL,
          IND_OtherFirstname TEXT,
          IND_birthSex INTEGER,
          IND_gender TEXT,
          {day_month_cols}IND_birthYear INTEGER,
          IND_FK_birthPlace INTEGER REFERENCES T_municipality(MUN_PK),
          IND_remarks TEXT,
          IND_Hobby TEXT,
          IND_dataSource TEXT,
          IND_fieldSources TEXT,
          PRO_PK INTEGER REFERENCES T_profession(PRO_PK),
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_profession (
          PRO_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          PRO_description TEXT,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_country (
          COU_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          COU_countryName TEXT NOT NULL,
          COU_uri TEXT,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_municipality (
          MUN_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          MUN_municipalityName TEXT,
          MUN_uri TEXT,
          MUN_region TEXT,
          MUN_country TEXT,
          MUN_departement TEXT,
          MUN_remarks TEXT,
          MUN_zipCode TEXT,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_institutionType (
          IST_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          IST_description TEXT NOT NULL,
          IST_remarks TEXT,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_institution (
          INS_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          INS_completeName TEXT,
          INS_usualName TEXT,
          INS_remarks TEXT,
          IST_PK INTEGER REFERENCES T_institutionType(IST_PK),
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_institutionPlace (
          MUN_PK INTEGER NOT NULL REFERENCES T_municipality(MUN_PK),
          INS_PK INTEGER NOT NULL REFERENCES T_institution(INS_PK),
          ISP_street TEXT,
          ISP_streetNumber TEXT,
          ISP_startYear INTEGER,
          ISP_endYear INTEGER,
          provenance TEXT,
          PRIMARY KEY (MUN_PK, INS_PK)
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_position (
          POS_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          POS_name TEXT,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_arena (
          ARE_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          ARE_completeName TEXT NOT NULL,
          ARE_shortName TEXT,
          ARE_remarks TEXT,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_eventType (
          EVT_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          EVT_description TEXT NOT NULL,
          EVT_remarks TEXT,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_event (
          EVE_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          EVE_description TEXT NOT NULL,
          EVE_remarks TEXT,
          EVE_nature INTEGER NOT NULL,
          EVT_PK INTEGER REFERENCES T_eventType(EVT_PK),
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_trajectory (
          ARE_PK INTEGER NOT NULL REFERENCES T_arena(ARE_PK),
          POS_PK INTEGER NOT NULL REFERENCES T_position(POS_PK),
          EVE_PK INTEGER NOT NULL REFERENCES T_event(EVE_PK),
          INS_PK INTEGER NOT NULL REFERENCES T_institution(INS_PK),
          IND_PK INTEGER NOT NULL REFERENCES T_individualHuman(IND_PK),
          TRA_seq INTEGER NOT NULL,
          TRA_eventIdx INTEGER NOT NULL,
          TRA_positionDetails TEXT,
          TRA_remarks TEXT,
          TRA_DateDay INTEGER,
          TRA_DateMonth INTEGER,
          TRA_DateYear INTEGER,
          TRA_workPlace TEXT,
          TRA_principal INTEGER,
          TRA_dataSource TEXT,
          provenance TEXT,
          PRIMARY KEY (IND_PK, TRA_seq, TRA_eventIdx)
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_diploma (
          DIP_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          DIP_degree TEXT NOT NULL,
          DIP_remarks TEXT,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_discipline (
          DIS_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          DIS_description TEXT NOT NULL,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_grade (
          GRA_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          GRA_description TEXT,
          GRA_remarks TEXT,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_education (
          DIS_PK INTEGER REFERENCES T_discipline(DIS_PK),
          INS_PK INTEGER REFERENCES T_institution(INS_PK),
          DIP_PK INTEGER REFERENCES T_diploma(DIP_PK),
          GRA_PK INTEGER REFERENCES T_grade(GRA_PK),
          IND_PK INTEGER NOT NULL REFERENCES T_individualHuman(IND_PK),
          EDU_startYear INTEGER,
          EDU_endYear INTEGER,
          EDU_initial INTEGER,
          EDU_remarks TEXT,
          EDU_dataSource TEXT,
          provenance TEXT,
          PRIMARY KEY (DIS_PK, INS_PK, DIP_PK, GRA_PK, IND_PK)
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_source (
          SOU_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          SOU_name TEXT,
          SOU_location TEXT,
          SOU_FK_sourceType INTEGER,
          SOU_remarks TEXT,
          SOU_Filename TEXT,
          SOU_sourceTypeLabel TEXT,
          STY_PK INTEGER,
          provenance TEXT
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_sourceIndividual (
          IND_PK INTEGER NOT NULL REFERENCES T_individualHuman(IND_PK),
          SOU_PK INTEGER NOT NULL REFERENCES T_source(SOU_PK),
          PRIMARY KEY (IND_PK, SOU_PK)
        )
    """)
 
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_Distinctions (
          DST_PK INTEGER PRIMARY KEY AUTOINCREMENT,
          DST_Year INTEGER,
          IND_PK INTEGER NOT NULL REFERENCES T_individualHuman(IND_PK),
          DST_Description TEXT,
          DST_Remarks TEXT,
          DST_dataSource TEXT,
          provenance TEXT
        )
    """)
 
    if cfg["hasRelatives"]:
        stmts.append("""
            CREATE TABLE IF NOT EXISTS T_RelativeType (
              RET_PK INTEGER PRIMARY KEY AUTOINCREMENT,
              RET_Description TEXT NOT NULL,
              RET_Remarks TEXT,
              provenance TEXT
            )
        """)
        stmts.append("""
            CREATE TABLE IF NOT EXISTS T_Relatives (
              IND_PK1 INTEGER NOT NULL REFERENCES T_individualHuman(IND_PK),
              IND_PK2 INTEGER NOT NULL REFERENCES T_individualHuman(IND_PK),
              RET_PK INTEGER NOT NULL REFERENCES T_RelativeType(RET_PK),
              REL_dataSource TEXT,
              provenance TEXT,
              PRIMARY KEY (IND_PK1, IND_PK2, RET_PK)
            )
        """)

    # Nationalité(s) : une personne peut avoir plusieurs nationalités (table
    # de liaison IND_PK/COU_PK), avec éventuellement l'année d'obtention et
    # de perte — voir schema_lesbiographies.json (T_nationality).
    stmts.append("""
        CREATE TABLE IF NOT EXISTS T_nationality (
          IND_PK INTEGER NOT NULL REFERENCES T_individualHuman(IND_PK),
          COU_PK INTEGER NOT NULL REFERENCES T_country(COU_PK),
          NAT_dateObtentionYear INTEGER,
          NAT_dateLossYear INTEGER,
          NAT_dataSource TEXT,
          provenance TEXT,
          PRIMARY KEY (IND_PK, COU_PK)
        )
    """)
 
    # --- Tables propres à cet outil (hors schémas d'origine) ---
    stmts.append("""
        CREATE TABLE IF NOT EXISTS app_individual_meta (
          IND_PK INTEGER PRIMARY KEY REFERENCES T_individualHuman(IND_PK),
          added_by TEXT,
          added_at TEXT,
          updated_by TEXT,
          updated_at TEXT
        )
    """)
    stmts.append("""
        CREATE TABLE IF NOT EXISTS history (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          ind_pk          INTEGER,
          changed_by      TEXT,
          changed_at      TEXT,
          change_type     TEXT,
          individual_name TEXT,
          summary         TEXT,
          details         TEXT
        )
    """)
 
    return stmts
 
 
def seed_fixed_referentials(conn, cfg):
    """Référentiels fixes du modèle (voir règles des schémas d'extraction),
    insérés une seule fois avec des PK explicites."""
    if q1(conn, "SELECT EVT_PK FROM T_eventType WHERE EVT_PK=1") is None:
        conn.executemany(
            "INSERT INTO T_eventType (EVT_PK, EVT_description) VALUES (?,?)",
            [(1, "Début"), (2, "Fin"), (3, "En cours")],
        )
    if q1(conn, "SELECT EVE_PK FROM T_event WHERE EVE_PK=1") is None:
        conn.executemany(
            "INSERT INTO T_event (EVE_PK, EVE_description, EVE_nature, EVT_PK) VALUES (?,?,?,?)",
            [(1, "Début", 1, 1), (2, "Fin", 0, 2), (3, "En cours", 1, 3)],
        )
    if q1(conn, "SELECT IST_PK FROM T_institutionType WHERE IST_PK=1") is None:
        conn.executemany(
            "INSERT INTO T_institutionType (IST_PK, IST_description) VALUES (?,?)",
            [(1, "Entreprise"), (2, "École / Université"), (3, "Association / Entité honorifique")],
        )
    if q1(conn, "SELECT ARE_PK FROM T_arena WHERE ARE_PK=1") is None:
        conn.executemany(
            "INSERT INTO T_arena (ARE_PK, ARE_completeName, ARE_shortName) VALUES (?,?,?)",
            [(1, "Fonction Exécutive", "FE"), (2, "Conseil d'Administration", "CA"),
             (3, "Comité Exécutif", "COMEX"), (4, "Cabinet", "Cabinet")],
        )
    if cfg["hasRelatives"] and q1(conn, "SELECT RET_PK FROM T_RelativeType WHERE RET_PK=1") is None:
        conn.executemany(
            "INSERT INTO T_RelativeType (RET_PK, RET_Description) VALUES (?,?)",
            [(1, "Père"), (2, "Mère"), (3, "Conjoint(e)")],
        )
 
 
def migrate_trajectory_table(conn):
    """Bases créées avant l'ajout de TRA_seq : l'ancienne clé composite
    (ARE_PK, POS_PK, EVE_PK, INS_PK, IND_PK) empêchait d'enregistrer deux
    passages distincts sur le même poste dans la même institution (ex. la
    personne quitte puis revient). On migre vers TRA_seq, qui lève cette
    limite, en préservant toutes les lignes existantes."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(T_trajectory)").fetchall()]
    if not cols or "TRA_seq" in cols:
        return  # table absente (installation neuve) ou déjà à jour
    conn.execute("ALTER TABLE T_trajectory RENAME TO T_trajectory_old")
    conn.execute("""
        CREATE TABLE T_trajectory (
          ARE_PK INTEGER NOT NULL REFERENCES T_arena(ARE_PK),
          POS_PK INTEGER NOT NULL REFERENCES T_position(POS_PK),
          EVE_PK INTEGER NOT NULL REFERENCES T_event(EVE_PK),
          INS_PK INTEGER NOT NULL REFERENCES T_institution(INS_PK),
          IND_PK INTEGER NOT NULL REFERENCES T_individualHuman(IND_PK),
          TRA_seq INTEGER NOT NULL,
          TRA_positionDetails TEXT,
          TRA_DateDay INTEGER,
          TRA_DateMonth INTEGER,
          TRA_DateYear INTEGER,
          TRA_workPlace TEXT,
          TRA_principal INTEGER,
          provenance TEXT,
          PRIMARY KEY (IND_PK, TRA_seq, EVE_PK)
        )
    """)
    old_rows = conn.execute("SELECT rowid, * FROM T_trajectory_old ORDER BY IND_PK, rowid").fetchall()
    seq_by_group = {}
    next_seq_by_ind = {}
    for row in old_rows:
        group_key = (row["IND_PK"], row["ARE_PK"], row["POS_PK"], row["INS_PK"])
        if group_key not in seq_by_group:
            seq_by_group[group_key] = next_seq_by_ind.get(row["IND_PK"], 0)
            next_seq_by_ind[row["IND_PK"]] = seq_by_group[group_key] + 1
        conn.execute(
            "INSERT INTO T_trajectory (ARE_PK, POS_PK, EVE_PK, INS_PK, IND_PK, TRA_seq, "
            "TRA_positionDetails, TRA_DateDay, TRA_DateMonth, TRA_DateYear, TRA_workPlace, "
            "TRA_principal, provenance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (row["ARE_PK"], row["POS_PK"], row["EVE_PK"], row["INS_PK"], row["IND_PK"],
             seq_by_group[group_key], row["TRA_positionDetails"], row["TRA_DateDay"],
             row["TRA_DateMonth"], row["TRA_DateYear"], row["TRA_workPlace"],
             row["TRA_principal"], row["provenance"]),
        )
    conn.execute("DROP TABLE T_trajectory_old")
 
 
def migrate_trajectory_remarks(conn):
    """Bases créées avant l'ajout de TRA_remarks : simple ajout de colonne
    (pas de recréation de table nécessaire, contrairement à TRA_seq)."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(T_trajectory)").fetchall()]
    if cols and "TRA_remarks" not in cols:
        conn.execute("ALTER TABLE T_trajectory ADD COLUMN TRA_remarks TEXT")
 
 
def migrate_trajectory_event_fields(conn):
    """Bases créées avant l'ajout du champ « événement » libre et de la
    distinction explicite début/fin (TRA_slot). Pour les lignes déjà
    existantes, TRA_slot est reconstruit à partir de l'ancienne règle fixe
    (EVE_PK=1 => Nomination => début ; EVE_PK=2 ou 3 => fin), ce qui
    préserve la lecture des trajectoires déjà saisies."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(T_trajectory)").fetchall()]
    if not cols:
        return
    changed = False
    if "TRA_eventLabel" not in cols:
        conn.execute("ALTER TABLE T_trajectory ADD COLUMN TRA_eventLabel TEXT")
        changed = True
    if "TRA_slot" not in cols:
        conn.execute("ALTER TABLE T_trajectory ADD COLUMN TRA_slot TEXT")
        changed = True
    if changed:
        conn.execute("UPDATE T_trajectory SET TRA_slot = CASE WHEN EVE_PK = 1 THEN 'start' ELSE 'end' END "
                      "WHERE TRA_slot IS NULL")
 
 
def migrate_event_type_labels(conn):
    """T_eventType passe de 2 valeurs fixes (Nomination / Prise de poste,
    Fin / Départ) à 3 (Début, Fin, En cours). Les EVT_PK 1 et 2 sont
    renommés sur place (aucune ligne T_event ni T_trajectory ne référence un
    EVT_PK différent, donc rien d'autre ne bouge) ; EVT_PK=3 est ajouté."""
    row = q1(conn, "SELECT EVT_description FROM T_eventType WHERE EVT_PK=1")
    if row and row["EVT_description"] == "Nomination / Prise de poste":
        conn.execute("UPDATE T_eventType SET EVT_description='Début' WHERE EVT_PK=1")
        conn.execute("UPDATE T_eventType SET EVT_description='Fin' WHERE EVT_PK=2")
    if q1(conn, "SELECT EVT_PK FROM T_eventType WHERE EVT_PK=3") is None:
        conn.execute("INSERT INTO T_eventType (EVT_PK, EVT_description) VALUES (3, 'En cours')")
 
 
def migrate_event_defaults(conn):
    """T_event : les 3 lignes fixes historiques (Nomination / dernière date
    connue / Départ) sont renommées pour coller au nouveau référentiel
    (Début / En cours / Fin) — SANS changer leur EVE_PK, pour préserver
    exactement les trajectoires déjà enregistrées qui les référencent."""
    row = q1(conn, "SELECT EVE_description FROM T_event WHERE EVE_PK=1")
    if row and row["EVE_description"] == "Nomination":
        conn.execute("UPDATE T_event SET EVE_description='Début', EVT_PK=1 WHERE EVE_PK=1")
        conn.execute("UPDATE T_event SET EVE_description='En cours', EVT_PK=3 WHERE EVE_PK=2")
        conn.execute("UPDATE T_event SET EVE_description='Fin', EVT_PK=2 WHERE EVE_PK=3")
 
 
def migrate_trajectory_primary_key(conn):
    """La clé primaire de T_trajectory s'appuyait sur EVE_PK pour distinguer
    la ligne « début » de la ligne « fin » d'une même étape — fragile, car
    une collision devenait possible si la même nature d'événement (ou le
    même texte libre) était choisie pour les deux. On bascule sur TRA_slot
    ('start'/'end'), qui ne dépend d'aucun choix métier et élimine
    totalement ce risque.
 
    Autoréparation : si un lancement précédent a été interrompu en plein
    milieu de cette migration (crash, coupure, deux processus démarrés en
    même temps...), une table de sauvegarde T_trajectory_pkmig peut déjà
    exister avec les données d'origine intactes. On repart proprement de
    cette sauvegarde au lieu de planter en essayant de la recréer."""
    backup = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='T_trajectory_pkmig'").fetchone()
    if backup is None:
        row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='T_trajectory'").fetchone()
        if not row or "TRA_slot)" in row[0] or "TRA_eventIdx)" in row[0]:
            return  # déjà à jour (ou déjà passé à l'étape suivante), ou table pas encore créée
        conn.execute("ALTER TABLE T_trajectory RENAME TO T_trajectory_pkmig")
    else:
        conn.execute("DROP TABLE IF EXISTS T_trajectory")  # reprise : table neuve incomplète, sans risque à jeter
    conn.execute("""
        CREATE TABLE T_trajectory (
          ARE_PK INTEGER NOT NULL REFERENCES T_arena(ARE_PK),
          POS_PK INTEGER NOT NULL REFERENCES T_position(POS_PK),
          EVE_PK INTEGER NOT NULL REFERENCES T_event(EVE_PK),
          INS_PK INTEGER NOT NULL REFERENCES T_institution(INS_PK),
          IND_PK INTEGER NOT NULL REFERENCES T_individualHuman(IND_PK),
          TRA_seq INTEGER NOT NULL,
          TRA_slot TEXT NOT NULL,
          TRA_positionDetails TEXT,
          TRA_remarks TEXT,
          TRA_eventLabel TEXT,
          TRA_DateDay INTEGER,
          TRA_DateMonth INTEGER,
          TRA_DateYear INTEGER,
          TRA_workPlace TEXT,
          TRA_principal INTEGER,
          provenance TEXT,
          PRIMARY KEY (IND_PK, TRA_seq, TRA_slot)
        )
    """)
    conn.execute("""
        INSERT OR IGNORE INTO T_trajectory (ARE_PK,POS_PK,EVE_PK,INS_PK,IND_PK,TRA_seq,TRA_slot,
            TRA_positionDetails,TRA_remarks,TRA_eventLabel,TRA_DateDay,TRA_DateMonth,TRA_DateYear,
            TRA_workPlace,TRA_principal,provenance)
        SELECT ARE_PK,POS_PK,EVE_PK,INS_PK,IND_PK,TRA_seq,
               COALESCE(TRA_slot, CASE WHEN EVE_PK=1 THEN 'start' ELSE 'end' END),
               TRA_positionDetails,TRA_remarks,TRA_eventLabel,TRA_DateDay,TRA_DateMonth,TRA_DateYear,
               TRA_workPlace,TRA_principal,provenance
        FROM T_trajectory_pkmig
    """)
    conn.execute("DROP TABLE T_trajectory_pkmig")
 
 
def migrate_trajectory_event_index(conn):
    """La distinction début/fin (TRA_slot: 'start'/'end', 2 valeurs
    possibles seulement) devient un index numérique (TRA_eventIdx),
    pour permettre un nombre quelconque d'événements par étape de
    carrière (début, une ou plusieurs mises à jour « en cours », fin...).
 
    Autoréparation : même principe que migrate_trajectory_primary_key — si
    un lancement précédent a été interrompu en cours de route, on repart de
    la sauvegarde déjà présente plutôt que de planter."""
    backup = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='T_trajectory_idxmig'").fetchone()
    if backup is None:
        row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='T_trajectory'").fetchone()
        if not row or "TRA_eventIdx" in row[0]:
            return  # déjà à jour, ou table pas encore créée
        conn.execute("ALTER TABLE T_trajectory RENAME TO T_trajectory_idxmig")
    else:
        conn.execute("DROP TABLE IF EXISTS T_trajectory")
    conn.execute("""
        CREATE TABLE T_trajectory (
          ARE_PK INTEGER NOT NULL REFERENCES T_arena(ARE_PK),
          POS_PK INTEGER NOT NULL REFERENCES T_position(POS_PK),
          EVE_PK INTEGER NOT NULL REFERENCES T_event(EVE_PK),
          INS_PK INTEGER NOT NULL REFERENCES T_institution(INS_PK),
          IND_PK INTEGER NOT NULL REFERENCES T_individualHuman(IND_PK),
          TRA_seq INTEGER NOT NULL,
          TRA_eventIdx INTEGER NOT NULL,
          TRA_positionDetails TEXT,
          TRA_remarks TEXT,
          TRA_DateDay INTEGER,
          TRA_DateMonth INTEGER,
          TRA_DateYear INTEGER,
          TRA_workPlace TEXT,
          TRA_principal INTEGER,
          provenance TEXT,
          PRIMARY KEY (IND_PK, TRA_seq, TRA_eventIdx)
        )
    """)
    conn.execute("""
        INSERT OR IGNORE INTO T_trajectory (ARE_PK,POS_PK,EVE_PK,INS_PK,IND_PK,TRA_seq,TRA_eventIdx,
            TRA_positionDetails,TRA_remarks,TRA_DateDay,TRA_DateMonth,TRA_DateYear,
            TRA_workPlace,TRA_principal,provenance)
        SELECT ARE_PK,POS_PK,EVE_PK,INS_PK,IND_PK,TRA_seq,
               CASE WHEN TRA_slot='start' THEN 0 ELSE 1 END,
               TRA_positionDetails,TRA_remarks,TRA_DateDay,TRA_DateMonth,TRA_DateYear,
               TRA_workPlace,TRA_principal,provenance
        FROM T_trajectory_idxmig
    """)
    conn.execute("DROP TABLE T_trajectory_idxmig")
 
 
def ensure_column(conn, table, column, decltype):
    """Ajoute une colonne à une table existante si elle n'y est pas déjà —
    utilisé pour les colonnes *_dataSource, introduites après la fusion des
    trois bases en une seule interface. Sans effet si la table n'existe pas
    encore (elle sera créée directement avec la colonne par schema_statements)
    ou si la colonne y figure déjà."""
    cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if cols and column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decltype}")


def migrate_add_data_source_columns(conn):
    """Fusion des trois bases sources en une seule interface : chaque section
    (identité, étape de carrière, formation, distinction, proche, document
    source) gagne un champ libre indiquant de quelle source provient la
    saisie. Idempotent : sans effet sur une base déjà à jour."""
    ensure_column(conn, "T_individualHuman", "IND_dataSource", "TEXT")
    ensure_column(conn, "T_individualHuman", "IND_fieldSources", "TEXT")
    ensure_column(conn, "T_trajectory", "TRA_dataSource", "TEXT")
    ensure_column(conn, "T_education", "EDU_dataSource", "TEXT")
    ensure_column(conn, "T_Distinctions", "DST_dataSource", "TEXT")
    ensure_column(conn, "T_Relatives", "REL_dataSource", "TEXT")
    ensure_column(conn, "T_source", "SOU_sourceTypeLabel", "TEXT")


def init_db():
    """Initialise/migre le fichier .db unique, sous un vrai verrou d'écriture
    SQLite (BEGIN IMMEDIATE). Si une autre machine est en train de migrer ce
    même fichier partagé (SharePoint/OneDrive) au même moment, ce verrou fait
    ATTENDRE cette exécution-ci plutôt que de risquer de corrompre les
    données en migrant les deux en parallèle — c'est la cause des erreurs de
    table de secours dupliquée rencontrées précédemment."""
    cfg = CFG
    conn = sqlite3.connect(db_path(), timeout=60)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None  # transactions gérées explicitement ci-dessous
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("BEGIN IMMEDIATE")
    try:
        migrate_trajectory_table(conn)
        migrate_trajectory_remarks(conn)
        migrate_trajectory_event_fields(conn)
        migrate_trajectory_primary_key(conn)
        migrate_trajectory_event_index(conn)
        for stmt in schema_statements(cfg):
            conn.execute(stmt)
        migrate_add_data_source_columns(conn)
        seed_fixed_referentials(conn, cfg)
        migrate_event_type_labels(conn)
        migrate_event_defaults(conn)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
 
 
def init_all():
    os.makedirs(DATA_DIR, exist_ok=True)
    init_db()
 
 
init_all()
 
 
# ============================================================
# Petits outils
# ============================================================
 
def now_iso():
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"
 
 
def nz(v):
    if v is None:
        return None
    if isinstance(v, str) and v.strip() == "":
        return None
    return v
 
 
def nz_lower(v):
    if not v:
        return None
    v = v.strip()
    return v.lower() if v else None
 
 
def to_int(v):
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (ValueError, TypeError):
        return None
 
 
def normalize_name(s):
    s = s or ""
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("-", " ").replace("'", " ")
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s
 
 
def slugify(s):
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", "_", s.strip())
 
 
def provenance_json(user):
    return json.dumps({"source": "saisie_manuelle", "entered_by": user, "entered_at": now_iso()},
                       ensure_ascii=False)
 
 
# ============================================================
# Référentiels — recherche ou création (dédoublonnage)
# ============================================================
 
def upsert_by_name(conn, table, pk_field, name_field, name, user, extra_cols=None, create_if_missing=True):
    clean = (name or "").strip()
    if not clean:
        return None
    row = q1(conn, f"SELECT {pk_field} FROM {table} WHERE lower({name_field})=lower(?)", (clean,))
    if row:
        return row[pk_field]
    if not create_if_missing:
        return None  # saisie encore incomplète (auto-save) : on ne pollue pas le référentiel partagé
    cols = [name_field, "provenance"]
    vals = [clean, provenance_json(user)]
    if extra_cols:
        cols = list(extra_cols.keys()) + cols
        vals = list(extra_cols.values()) + vals
    placeholders = ", ".join("?" for _ in vals)
    cur = conn.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders})", vals)
    return cur.lastrowid
 
 
def upsert_position(conn, name, user, create_if_missing=True):
    return upsert_by_name(conn, "T_position", "POS_PK", "POS_name", name, user, create_if_missing=create_if_missing)
 
 
def upsert_arena(conn, name, user, create_if_missing=True):
    return upsert_by_name(conn, "T_arena", "ARE_PK", "ARE_completeName", name or "Fonction Exécutive", user,
                           create_if_missing=create_if_missing)
 
 
def upsert_profession(conn, name, user, create_if_missing=True):
    return upsert_by_name(conn, "T_profession", "PRO_PK", "PRO_description", name, user,
                           create_if_missing=create_if_missing)
 
 
def upsert_diploma(conn, name, user, create_if_missing=True):
    return upsert_by_name(conn, "T_diploma", "DIP_PK", "DIP_degree", name, user, create_if_missing=create_if_missing)
 
 
def upsert_discipline(conn, name, user, create_if_missing=True):
    return upsert_by_name(conn, "T_discipline", "DIS_PK", "DIS_description", name, user,
                           create_if_missing=create_if_missing)
 
 
def upsert_grade(conn, name, user, create_if_missing=True):
    return upsert_by_name(conn, "T_grade", "GRA_PK", "GRA_description", name, user,
                           create_if_missing=create_if_missing)
 
 
def upsert_relative_type(conn, name, user, create_if_missing=True):
    return upsert_by_name(conn, "T_RelativeType", "RET_PK", "RET_Description", name, user,
                           create_if_missing=create_if_missing)
 
 
def upsert_event(conn, description, evt_pk, user, create_if_missing=True):
    """T_event : table dynamique (comme les postes ou institutions), pas
    limitée à 3 valeurs fixes — seul T_eventType (Début/Fin/En cours) l'est.
    Si l'utilisateur ne saisit pas de texte libre, on réutilise le libellé
    de la nature comme valeur par défaut (dédoublonné, comme le reste)."""
    evt_row = q1(conn, "SELECT EVT_description FROM T_eventType WHERE EVT_PK=?", (evt_pk,))
    default_label = evt_row["EVT_description"] if evt_row else "Événement"
    clean = (description or "").strip() or default_label
    row = q1(conn, "SELECT EVE_PK FROM T_event WHERE lower(EVE_description)=lower(?) AND EVT_PK=?",
             (clean, evt_pk))
    if row:
        return row["EVE_PK"]
    if not create_if_missing:
        return None
    nature = 1 if evt_pk in (1, 3) else 0  # Début / En cours = intervalle ouvert ; Fin = fermé
    cur = conn.execute("INSERT INTO T_event (EVE_description, EVE_nature, EVT_PK, provenance) VALUES (?,?,?,?)",
                        (clean, nature, evt_pk, provenance_json(user)))
    return cur.lastrowid
 
 
def upsert_institution(conn, name, user, type_pk=1, remarks=None, create_if_missing=True):
    clean = (name or "").strip()
    if not clean:
        return None
    row = q1(conn, "SELECT INS_PK FROM T_institution WHERE lower(INS_completeName)=lower(?)", (clean,))
    if row:
        if remarks and remarks.strip():
            conn.execute("UPDATE T_institution SET INS_remarks=? WHERE INS_PK=?",
                         (remarks.strip(), row["INS_PK"]))
        return row["INS_PK"]
    if not create_if_missing:
        return None
    cur = conn.execute(
        "INSERT INTO T_institution (INS_completeName, IST_PK, INS_remarks, provenance) VALUES (?,?,?,?)",
        (clean, type_pk or 1, nz(remarks), provenance_json(user)),
    )
    return cur.lastrowid
 
 
def upsert_country(conn, name, user, create_if_missing=True):
    clean = (name or "").strip()
    if not clean:
        return None
    row = q1(conn, "SELECT COU_PK FROM T_country WHERE lower(COU_countryName)=lower(?)", (clean,))
    if row:
        return row["COU_PK"]
    if not create_if_missing:
        return None
    cur = conn.execute("INSERT INTO T_country (COU_countryName, provenance) VALUES (?,?)",
                        (clean, provenance_json(user)))
    return cur.lastrowid
 
 
def upsert_municipality(conn, cfg, name, country_name, user, create_if_missing=True):
    clean = (name or "").strip()
    if not clean:
        return None
    row = q1(conn, "SELECT MUN_PK FROM T_municipality WHERE lower(MUN_municipalityName)=lower(?)", (clean,))
    if row:
        return row["MUN_PK"]
    if not create_if_missing:
        return None
    uri = f"{cfg['key']}:lieu:{slugify(clean)}"
    cur = conn.execute(
        "INSERT INTO T_municipality (MUN_municipalityName, MUN_uri, MUN_country, provenance) VALUES (?,?,?,?)",
        (clean, uri, country_name or None, provenance_json(user)),
    )
    return cur.lastrowid
 
 
def upsert_institution_place(conn, cfg, ins_pk, city, country, street, street_number, start_year, end_year, user,
                              create_if_missing=True):
    """Adresse d'une institution (T_institutionPlace, clé composite MUN_PK+INS_PK).
    N'écrit rien si aucune ville n'est renseignée."""
    if not ins_pk or not (city or "").strip():
        return
    mun_pk = upsert_municipality(conn, cfg, city, country, user, create_if_missing=create_if_missing)
    if not mun_pk:
        return
    conn.execute(
        "INSERT INTO T_institutionPlace (MUN_PK, INS_PK, ISP_street, ISP_streetNumber, ISP_startYear, "
        "ISP_endYear, provenance) VALUES (?,?,?,?,?,?,?) "
        "ON CONFLICT(MUN_PK, INS_PK) DO UPDATE SET ISP_street=excluded.ISP_street, "
        "ISP_streetNumber=excluded.ISP_streetNumber, ISP_startYear=excluded.ISP_startYear, "
        "ISP_endYear=excluded.ISP_endYear, provenance=excluded.provenance",
        (mun_pk, ins_pk, nz(street), nz(street_number), to_int(start_year), to_int(end_year),
         provenance_json(user)),
    )
 
 
# ============================================================
# Reconstruction d'une fiche complète (pour édition et pour le diff)
# ============================================================
 
def get_institution_place(conn, ins_pk):
    if not ins_pk:
        return {"city": "", "country": "", "street": "", "streetNumber": ""}
    row = q1(conn, """
        SELECT mu.MUN_municipalityName as city, mu.MUN_country as country,
               ip.ISP_street as street, ip.ISP_streetNumber as streetNumber
        FROM T_institutionPlace ip JOIN T_municipality mu ON mu.MUN_PK = ip.MUN_PK
        WHERE ip.INS_PK=?
    """, (ins_pk,))
    return row or {"city": "", "country": "", "street": "", "streetNumber": ""}
 
 
def get_individual_bundle(conn, cfg, pk):
    if pk is None:
        return None
    ind = q1(conn, "SELECT * FROM T_individualHuman WHERE IND_PK=?", (pk,))
    if not ind:
        return None
 
    f = {
        "pk": pk,
        "birthName": ind.get("IND_birthName") or "",
        "usualFirstname": ind.get("IND_usualFirstname") or "",
        "otherFirstname": ind.get("IND_OtherFirstname") or "",
        "marriedName": ind.get("IND_marriedName") or "",
        "commonName": ind.get("IND_commonName") or "",
        "genre": ind.get("IND_gender") or (
            "Mme" if ind.get("IND_birthSex") == 1 else
            "M" if ind.get("IND_birthSex") == 0 else ""
        ),
        "birthDay": ind.get("IND_birthDay") or "",
        "birthMonth": ind.get("IND_birthMonth") or "",
        "birthYear": ind.get("IND_birthYear") or "",
        "birthPlace": "", "birthCountry": "",
        "profession": "", "hobby": ind.get("IND_Hobby") or "", "remarks": ind.get("IND_remarks") or "",
        "fieldSources": {},
        "sources": [],
        "trajectories": [], "educations": [], "distinctions": [], "relatives": [],
    }
    try:
        f["fieldSources"] = json.loads(ind.get("IND_fieldSources") or "{}")
    except (TypeError, ValueError):
        f["fieldSources"] = {}
 
    if ind.get("IND_FK_birthPlace"):
        mun = q1(conn, "SELECT * FROM T_municipality WHERE MUN_PK=?", (ind["IND_FK_birthPlace"],))
        if mun:
            f["birthPlace"] = mun.get("MUN_municipalityName") or ""
            f["birthCountry"] = mun.get("MUN_country") or "" 
    if ind.get("PRO_PK"):
        prof = q1(conn, "SELECT * FROM T_profession WHERE PRO_PK=?", (ind["PRO_PK"],))
        if prof:
            f["profession"] = prof.get("PRO_description") or ""
 
    links = q(conn, "SELECT * FROM T_sourceIndividual WHERE IND_PK=?", (pk,))
    sources = []
    for link in links:
        sou = q1(conn, "SELECT * FROM T_source WHERE SOU_PK=?", (link["SOU_PK"],))
        if sou:
            sources.append({
                "sourceType": sou.get("SOU_sourceTypeLabel") or "",
                "filename": sou.get("SOU_Filename") or "",
                "name": sou.get("SOU_name") or "",
                "remarks": sou.get("SOU_remarks") or "",
            })
    f["sources"] = sources
 
    traj_rows = q(conn, "SELECT * FROM T_trajectory WHERE IND_PK=?", (pk,))
    groups = {}
    for t in traj_rows:
        groups.setdefault(t["TRA_seq"], []).append(t)
    trajectories = []
 
    def event_info(row):
        ev = q1(conn, "SELECT * FROM T_event WHERE EVE_PK=?", (row["EVE_PK"],))
        return {"nature": str(ev["EVT_PK"]) if ev else "", "event": (ev.get("EVE_description") or "") if ev else ""}
 
    for seq_key in sorted(groups.keys()):
        rows = sorted(groups[seq_key], key=lambda r: r.get("TRA_eventIdx") or 0)
        ref = rows[0]
        pos = q1(conn, "SELECT * FROM T_position WHERE POS_PK=?", (ref["POS_PK"],))
        ins = q1(conn, "SELECT * FROM T_institution WHERE INS_PK=?", (ref["INS_PK"],))
        are = q1(conn, "SELECT * FROM T_arena WHERE ARE_PK=?", (ref["ARE_PK"],))
        place = get_institution_place(conn, ref["INS_PK"])
        events = []
        for r in rows:
            info = event_info(r)
            events.append({
                "day": r.get("TRA_DateDay") or "", "month": r.get("TRA_DateMonth") or "",
                "year": r.get("TRA_DateYear") or "", "nature": info["nature"] or "1", "event": info["event"],
                "dataSource": r.get("TRA_dataSource") or "",
            })
        trajectories.append({
            "position": pos["POS_name"] if pos else "",
            "institution": ins["INS_completeName"] if ins else "",
            "institutionType": ins["IST_PK"] if ins else 1,
            "institutionCity": place["city"] or "", "institutionCountry": place["country"] or "",
            "institutionStreet": place["street"] or "",
            "institutionStreetNumber": place["streetNumber"] or "",
            "institutionRemarks": (ins.get("INS_remarks") or "") if ins else "",
            "arena": are["ARE_completeName"] if are else "Fonction Exécutive",
            "positionDetails": ref.get("TRA_positionDetails") or "",
            "remarks": ref.get("TRA_remarks") or "",
            "workPlace": ref.get("TRA_workPlace") or "",
            "principal": ref.get("TRA_principal") == 1,
            "events": events,
        })
    f["trajectories"] = trajectories
 
    edu_rows = q(conn, "SELECT * FROM T_education WHERE IND_PK=?", (pk,))
    educations = []
    for e in edu_rows:
        ins = q1(conn, "SELECT * FROM T_institution WHERE INS_PK=?", (e.get("INS_PK"),)) if e.get("INS_PK") else None
        dip = q1(conn, "SELECT * FROM T_diploma WHERE DIP_PK=?", (e.get("DIP_PK"),)) if e.get("DIP_PK") else None
        dis = q1(conn, "SELECT * FROM T_discipline WHERE DIS_PK=?", (e.get("DIS_PK"),)) if e.get("DIS_PK") else None
        gra = q1(conn, "SELECT * FROM T_grade WHERE GRA_PK=?", (e.get("GRA_PK"),)) if e.get("GRA_PK") else None
        place = get_institution_place(conn, e.get("INS_PK"))
        educations.append({
            "school": ins["INS_completeName"] if ins else "",
            "schoolCity": place["city"] or "", "schoolCountry": place["country"] or "",
            "schoolStreet": place["street"] or "", "schoolStreetNumber": place["streetNumber"] or "",
            "schoolRemarks": (ins.get("INS_remarks") or "") if ins else "",
            "diploma": dip["DIP_degree"] if dip else "",
            "discipline": dis["DIS_description"] if dis else "",
            "grade": gra["GRA_description"] if gra else "",
            "startYear": e.get("EDU_startYear") or "", "endYear": e.get("EDU_endYear") or "",
            "initial": bool(e.get("EDU_initial")), "remarks": e.get("EDU_remarks") or "",
            "dataSource": e.get("EDU_dataSource") or "",
        })
    f["educations"] = educations
 
    dist_rows = q(conn, "SELECT * FROM T_Distinctions WHERE IND_PK=?", (pk,))
    f["distinctions"] = [
        {"year": d.get("DST_Year") or "", "description": d.get("DST_Description") or "",
         "remarks": d.get("DST_Remarks") or "", "dataSource": d.get("DST_dataSource") or ""} for d in dist_rows
    ]
 
    if cfg["hasRelatives"]:
        rel_rows = q(conn, "SELECT * FROM T_Relatives WHERE IND_PK1=?", (pk,))
        relatives = []
        for r in rel_rows:
            rel_ind = q1(conn, "SELECT * FROM T_individualHuman WHERE IND_PK=?", (r["IND_PK2"],))
            rel_type = q1(conn, "SELECT * FROM T_RelativeType WHERE RET_PK=?", (r["RET_PK"],))
            rel_prof = None
            if rel_ind and rel_ind.get("PRO_PK"):
                rel_prof = q1(conn, "SELECT * FROM T_profession WHERE PRO_PK=?", (rel_ind["PRO_PK"],))
            relatives.append({
                "pk": rel_ind["IND_PK"] if rel_ind else None,
                "firstname": rel_ind.get("IND_usualFirstname") if rel_ind else "",
                "lastname": rel_ind.get("IND_birthName") if rel_ind else "",
                "relationType": rel_type.get("RET_Description") if rel_type else "",
                "profession": rel_prof.get("PRO_description") if rel_prof else "",
                "dataSource": r.get("REL_dataSource") or "",
            })
        f["relatives"] = relatives
 

    nat_rows = []
    if conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='T_nationality'"
    ).fetchone():
        nat_rows = q(conn, "SELECT * FROM T_nationality WHERE IND_PK=?", (pk,))
    nationalities = []
    for n in nat_rows:
        cou = q1(conn, "SELECT * FROM T_country WHERE COU_PK=?", (n.get("COU_PK"),))
        nationalities.append({
            "country": cou.get("COU_countryName") if cou else "",
            "obtentionYear": n.get("NAT_dateObtentionYear") or "",
            "lossYear": n.get("NAT_dateLossYear") or "",
            "dataSource": n.get("NAT_dataSource") or "",
        })
    f["nationalities"] = nationalities

    return f
 
 
# ============================================================
# Enregistrement d'une fiche (création ou modification)
# ============================================================
 
def save_individual(conn, cfg, user, editing_pk, form, silent=False):
    old_bundle = get_individual_bundle(conn, cfg, editing_pk) if editing_pk else None
    prov = provenance_json(user)
    cim = not silent  # create_if_missing : l'auto-save ne crée jamais de nouvelle valeur de référentiel
 
    municipality_pk = upsert_municipality(conn, cfg, form.get("birthPlace"), form.get("birthCountry"), user,
                                           create_if_missing=cim) if form.get("birthPlace") else None
    # NB : le pays de naissance reste en texte libre dans MUN_country (voir
    # upsert_municipality). On ne crée plus d'entrée T_country pour lui —
    # ce référentiel est désormais réservé à la ou aux nationalité(s),
    # conformément au schéma d'extraction (schema_lesbiographies.json).
    profession_pk = upsert_profession(conn, form.get("profession"), user, create_if_missing=cim) \
        if form.get("profession") else None
 
    fields = {
        "IND_birthName": (form.get("birthName") or "").strip().lower(),
        "IND_marriedName": nz_lower(form.get("marriedName")),
        "IND_commonName": nz_lower(form.get("commonName")),
        "IND_usualFirstname": (form.get("usualFirstname") or "").strip().lower(),
        "IND_OtherFirstname": nz_lower(form.get("otherFirstname")),
        "IND_birthSex": 1 if form.get("genre") == "Mme" else (0 if form.get("genre") == "M" else None),
        "IND_gender": form.get("genre") or None,
        "IND_FK_birthPlace": municipality_pk,
        "IND_remarks": nz(form.get("remarks")),
        "IND_Hobby": nz(form.get("hobby")),
        "IND_fieldSources": json.dumps(form.get("fieldSources") or {}, ensure_ascii=False),
        "PRO_PK": profession_pk,
    }
    if cfg["hasDayMonth"]:
        fields["IND_birthDay"] = to_int(form.get("birthDay"))
        fields["IND_birthMonth"] = to_int(form.get("birthMonth"))
    fields["IND_birthYear"] = to_int(form.get("birthYear"))
    fields["provenance"] = prov
 
    if editing_pk:
        set_clause = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE T_individualHuman SET {set_clause} WHERE IND_PK=?",
                     (*fields.values(), editing_pk))
        ind_pk = editing_pk
        conn.execute("UPDATE app_individual_meta SET updated_by=?, updated_at=? WHERE IND_PK=?",
                     (user, now_iso(), ind_pk))
    else:
        cols = ", ".join(fields.keys())
        placeholders = ", ".join("?" for _ in fields)
        cur = conn.execute(f"INSERT INTO T_individualHuman ({cols}) VALUES ({placeholders})",
                            tuple(fields.values()))
        ind_pk = cur.lastrowid
        conn.execute("INSERT INTO app_individual_meta (IND_PK, added_by, added_at) VALUES (?,?,?)",
                      (ind_pk, user, now_iso()))
 
    # --- Sources du CV (documents) : plusieurs sources possibles désormais
    # (ex. un profil LinkedIn ET une notice Who's Who pour la même personne).
    # On retire les anciens documents-sources et on reconstruit, comme pour
    # les autres sections répétables (parcours, formation...).
    old_source_pks = [r["SOU_PK"] for r in q(conn, "SELECT * FROM T_sourceIndividual WHERE IND_PK=?", (ind_pk,))]
    conn.execute("DELETE FROM T_sourceIndividual WHERE IND_PK=?", (ind_pk,))
    for spk in old_source_pks:
        conn.execute("DELETE FROM T_source WHERE SOU_PK=?", (spk,))
    for s in form.get("sources") or []:
        filename = (s.get("filename") or "").strip()
        if not filename:
            continue
        auto_name = (s.get("name") or "").strip() or (
            f"{form.get('usualFirstname', '')} {form.get('birthName', '')}"
            f"{(' ' + str(form.get('birthYear'))) if form.get('birthYear') else ''}"
        ).strip()
        cur = conn.execute(
            "INSERT INTO T_source (SOU_name, SOU_remarks, SOU_Filename, SOU_sourceTypeLabel, provenance) "
            "VALUES (?,?,?,?,?)",
            (auto_name, nz(s.get("remarks")), filename, nz((s.get("sourceType") or "").strip()), prov),
        )
        sou_pk = cur.lastrowid
        conn.execute("INSERT INTO T_sourceIndividual (IND_PK, SOU_PK) VALUES (?,?)", (ind_pk, sou_pk))

    # --- Nationalité(s) : plusieurs possibles, on retire l'ancien et on reconstruit ---
    conn.execute("DELETE FROM T_nationality WHERE IND_PK=?", (ind_pk,))
    for n in form.get("nationalities") or []:
        country_name = (n.get("country") or "").strip()
        if not country_name:
            continue
        cou_pk = upsert_country(conn, country_name, user, create_if_missing=cim)
        if cou_pk is None:
            continue  # référentiel pas encore stabilisé (auto-save)
        conn.execute(
            "INSERT OR IGNORE INTO T_nationality (IND_PK, COU_PK, NAT_dateObtentionYear, NAT_dateLossYear, "
            "NAT_dataSource, provenance) VALUES (?,?,?,?,?,?)",
            (ind_pk, cou_pk, to_int(n.get("obtentionYear")), to_int(n.get("lossYear")),
             nz(n.get("dataSource")), prov),
        )
 
    # --- Parcours professionnel : on retire l'ancien, on reconstruit ---
    conn.execute("DELETE FROM T_trajectory WHERE IND_PK=?", (ind_pk,))
    seq = 0
    for t in form.get("trajectories") or []:
        if not t.get("position") and not t.get("institution"):
            continue
        pos_pk = upsert_position(conn, t.get("position"), user, create_if_missing=cim)
        ins_pk = upsert_institution(conn, t.get("institution"), user, t.get("institutionType") or 1,
                                     remarks=t.get("institutionRemarks"), create_if_missing=cim)
        are_pk = upsert_arena(conn, t.get("arena") or "Fonction Exécutive", user, create_if_missing=cim)
        if pos_pk is None or ins_pk is None or are_pk is None:
            continue  # référentiel pas encore stabilisé (auto-save) : on ne persiste pas cette étape pour l'instant
        principal = 1 if t.get("principal") else 2
        events = t.get("events") or []
        years = [to_int(e.get("year")) for e in events if to_int(e.get("year"))]
        upsert_institution_place(conn, cfg, ins_pk, t.get("institutionCity"), t.get("institutionCountry"),
                                  t.get("institutionStreet"), t.get("institutionStreetNumber"),
                                  min(years) if years else None, max(years) if years else None, user,
                                  create_if_missing=cim)
 
        for evidx, ev in enumerate(events):
            has_info = ev.get("day") or ev.get("month") or ev.get("year") or (ev.get("event") or "").strip()
            if evidx > 0 and not has_info:
                continue  # ligne additionnelle laissée vide : on l'ignore
            evt_pk = to_int(ev.get("nature")) or 1
            eve_pk = upsert_event(conn, ev.get("event"), evt_pk, user, create_if_missing=cim)
            if eve_pk is None:
                continue  # texte d'événement encore incomplet (auto-save) : on n'écrit pas cette ligne pour l'instant
            conn.execute(
                "INSERT INTO T_trajectory (ARE_PK, POS_PK, EVE_PK, INS_PK, IND_PK, TRA_seq, TRA_eventIdx, "
                "TRA_positionDetails, TRA_remarks, TRA_DateDay, TRA_DateMonth, TRA_DateYear, "
                "TRA_workPlace, TRA_principal, TRA_dataSource, provenance) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (are_pk, pos_pk, eve_pk, ins_pk, ind_pk, seq, evidx, nz(t.get("positionDetails")),
                 nz(t.get("remarks")), to_int(ev.get("day")), to_int(ev.get("month")), to_int(ev.get("year")),
                 nz(t.get("workPlace")), principal, nz(ev.get("dataSource")), prov),
            )
        seq += 1
 
    # --- Formation ---
    conn.execute("DELETE FROM T_education WHERE IND_PK=?", (ind_pk,))
    for e in form.get("educations") or []:
        if not e.get("school") and not e.get("diploma"):
            continue
        school_ins_pk = upsert_institution(conn, e.get("school"), user, 2, remarks=e.get("schoolRemarks"),
                                            create_if_missing=cim) if e.get("school") else None
        upsert_institution_place(conn, cfg, school_ins_pk, e.get("schoolCity"), e.get("schoolCountry"),
                                  e.get("schoolStreet"), e.get("schoolStreetNumber"),
                                  e.get("startYear"), e.get("endYear"), user, create_if_missing=cim)
        conn.execute(
            "INSERT INTO T_education (DIS_PK, INS_PK, DIP_PK, GRA_PK, IND_PK, EDU_startYear, EDU_endYear, "
            "EDU_initial, EDU_remarks, EDU_dataSource, provenance) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (upsert_discipline(conn, e.get("discipline"), user, create_if_missing=cim)
             if e.get("discipline") else None,
             school_ins_pk,
             upsert_diploma(conn, e.get("diploma"), user, create_if_missing=cim) if e.get("diploma") else None,
             upsert_grade(conn, e.get("grade"), user, create_if_missing=cim) if e.get("grade") else None,
             ind_pk, to_int(e.get("startYear")), to_int(e.get("endYear")),
             1 if e.get("initial") else 0, nz(e.get("remarks")), nz(e.get("dataSource")), prov),
        )
 
    # --- Distinctions ---
    conn.execute("DELETE FROM T_Distinctions WHERE IND_PK=?", (ind_pk,))
    for d in form.get("distinctions") or []:
        if not d.get("description"):
            continue
        conn.execute(
            "INSERT INTO T_Distinctions (DST_Year, IND_PK, DST_Description, DST_Remarks, DST_dataSource, "
            "provenance) VALUES (?,?,?,?,?,?)",
            (to_int(d.get("year")), ind_pk, d.get("description"), nz(d.get("remarks")),
             nz(d.get("dataSource")), prov),
        )
 
    # --- Parenté ---
    if cfg["hasRelatives"]:
        old_rel_pks = [r["IND_PK2"] for r in q(conn, "SELECT * FROM T_Relatives WHERE IND_PK1=?", (ind_pk,))]
        conn.execute("DELETE FROM T_Relatives WHERE IND_PK1=?", (ind_pk,))
        kept_pks = []
        for r in form.get("relatives") or []:
            if not r.get("firstname") and not r.get("lastname"):
                continue
            rel_pk = r.get("pk")
            rel_prof_pk = upsert_profession(conn, r.get("profession"), user, create_if_missing=cim) \
                if r.get("profession") else None
            if rel_pk:
                conn.execute(
                    "UPDATE T_individualHuman SET IND_birthName=?, IND_usualFirstname=?, PRO_PK=? WHERE IND_PK=?",
                    ((r.get("lastname") or "").strip().lower(), (r.get("firstname") or "").strip().lower(),
                     rel_prof_pk, rel_pk),
                )
            else:
                cur = conn.execute(
                    "INSERT INTO T_individualHuman (IND_birthName, IND_usualFirstname, PRO_PK, provenance) "
                    "VALUES (?,?,?,?)",
                    ((r.get("lastname") or "").strip().lower(), (r.get("firstname") or "").strip().lower(),
                     rel_prof_pk, prov),
                )
                rel_pk = cur.lastrowid
                # Pas d'entrée app_individual_meta pour ces fiches "proches" : elles
                # n'apparaissent jamais dans le tableau de bord principal.
            kept_pks.append(rel_pk)
            ret_pk = upsert_relative_type(conn, r.get("relationType") or "Non précisé", user, create_if_missing=cim)
            if ret_pk is not None:
                conn.execute(
                    "INSERT INTO T_Relatives (IND_PK1, IND_PK2, RET_PK, REL_dataSource, provenance) "
                    "VALUES (?,?,?,?,?)",
                    (ind_pk, rel_pk, ret_pk, nz(r.get("dataSource")), prov))
        for removed_pk in [pk for pk in old_rel_pks if pk not in kept_pks]:
            conn.execute("DELETE FROM T_individualHuman WHERE IND_PK=?", (removed_pk,))
 
    new_bundle = get_individual_bundle(conn, cfg, ind_pk)
    return ind_pk, old_bundle, new_bundle
 
 
def delete_individual(conn, cfg, pk):
    conn.execute("DELETE FROM T_trajectory WHERE IND_PK=?", (pk,))
    conn.execute("DELETE FROM T_education WHERE IND_PK=?", (pk,))
    conn.execute("DELETE FROM T_Distinctions WHERE IND_PK=?", (pk,))
    if cfg["hasRelatives"]:
        removed = [r["IND_PK2"] for r in q(conn, "SELECT * FROM T_Relatives WHERE IND_PK1=?", (pk,))]
        conn.execute("DELETE FROM T_Relatives WHERE IND_PK1=?", (pk,))
        # Cette fiche pourrait aussi être référencée comme "proche" ailleurs
        # (ex. citée comme conjoint d'une autre fiche) : on retire ces liens
        # avant de la supprimer elle-même, pour ne jamais laisser de référence
        # cassée.
        conn.execute("DELETE FROM T_Relatives WHERE IND_PK2=?", (pk,))
        for rpk in removed:
            conn.execute("DELETE FROM T_individualHuman WHERE IND_PK=?", (rpk,))
    conn.execute("DELETE FROM T_sourceIndividual WHERE IND_PK=?", (pk,))
    for spk in [r["SOU_PK"] for r in q(conn, "SELECT * FROM T_source WHERE SOU_PK NOT IN "
                                              "(SELECT SOU_PK FROM T_sourceIndividual)")]:
        conn.execute("DELETE FROM T_source WHERE SOU_PK=?", (spk,))
    conn.execute("DELETE FROM app_individual_meta WHERE IND_PK=?", (pk,))
    conn.execute("DELETE FROM T_individualHuman WHERE IND_PK=?", (pk,))
 
 
# ============================================================
# Journal d'historique — calcul des différences champ par champ
# ============================================================
 
FIELDS_IDENTITY = [
    ("birthName", "Nom de naissance"), ("usualFirstname", "Prénom usuel"),
    ("otherFirstname", "Autres prénoms"), ("marriedName", "Nom d'usage marital"),
    ("commonName", "Nom d'usage affiché"), ("genre", "Genre"),
    ("birthDay", "Jour de naissance"), ("birthMonth", "Mois de naissance"),
    ("birthYear", "Année de naissance"), ("birthPlace", "Lieu de naissance"),
    ("birthCountry", "Pays de naissance"), ("profession", "Profession"),
    ("hobby", "Centres d'intérêt"), ("remarks", "Remarques"),
]
 
 
def diff_identity(old, new):
    changes = []
    for key, label in FIELDS_IDENTITY:
        ov = "" if not old else ("" if old.get(key) is None else str(old.get(key)))
        nv = "" if not new else ("" if new.get(key) is None else str(new.get(key)))
        if ov != nv:
            changes.append({"type": "field", "label": label, "old": ov or "—", "new": nv or "—"})
    return changes
 
 
def _traj_sig(t):
    events = t.get("events") or []
    first_year = events[0].get("year") if events else ""
    return (f"{(t.get('position') or '').strip().lower()}|{(t.get('institution') or '').strip().lower()}"
            f"|{(t.get('arena') or '').strip().lower()}|{first_year}")
 
 
def _traj_label(t):
    events = t.get("events") or []
    years = [str(e.get("year")) for e in events if e.get("year")]
    period = f"{years[0]}–{years[-1]}" if len(years) >= 2 else (years[0] if years else "?")
    return f"{t.get('position', '')} — {t.get('institution', '')} ({period})"
 
 
def _edu_sig(e):
    return f"{(e.get('school') or '').strip().lower()}|{(e.get('diploma') or '').strip().lower()}"
 
 
def _edu_label(e):
    return f"{e.get('diploma', '')} — {e.get('school', '')}"
 
 
def _dist_sig(d):
    return f"{d.get('year') or ''}|{(d.get('description') or '').strip().lower()}"
 
 
def _dist_label(d):
    return f"{d.get('description', '')} ({d.get('year')})" if d.get("year") else d.get("description", "")
 
 
def _rel_sig(r):
    return f"{(r.get('firstname') or '').strip().lower()}|{(r.get('lastname') or '').strip().lower()}"
 
 
def _rel_label(r):
    return f"{r.get('relationType', '')} : {r.get('firstname', '')} {r.get('lastname', '')}"


def _src_sig(s):
    return f"{(s.get('sourceType') or '').strip().lower()}|{(s.get('filename') or '').strip().lower()}"


def _src_label(s):
    return f"{s.get('sourceType', '')} — {s.get('filename', '')}"


def _nat_sig(n):
    return (n.get('country') or '').strip().lower()


def _nat_label(n):
    years = ''
    if n.get('obtentionYear') or n.get('lossYear'):
        years = f" ({n.get('obtentionYear','') or '?'}–{n.get('lossYear','') or ''})"
    return f"{n.get('country', '')}{years}"


def list_diff(old_list, new_list, sig_fn, label_fn):
    old_map = {sig_fn(x): x for x in (old_list or [])}
    new_map = {sig_fn(x): x for x in (new_list or [])}
    added = [label_fn(new_map[k]) for k in new_map if k not in old_map]
    removed = [label_fn(old_map[k]) for k in old_map if k not in new_map]
    modified = [label_fn(new_map[k]) for k in (set(old_map) & set(new_map)) if old_map[k] != new_map[k]]
    return added, removed, modified
 
 
def compute_diff(old, new):
    changes = diff_identity(old, new)
    sections = [
        ("Étape de carrière", "trajectories", _traj_sig, _traj_label),
        ("Formation", "educations", _edu_sig, _edu_label),
        ("Distinction", "distinctions", _dist_sig, _dist_label),
        ("Proche", "relatives", _rel_sig, _rel_label),
        ("Document source", "sources", _src_sig, _src_label),
        ("Nationalité", "nationalities", _nat_sig, _nat_label),
    ]
    for label, field, sig_fn, label_fn in sections:
        added, removed, modified = list_diff(
            (old or {}).get(field), (new or {}).get(field), sig_fn, label_fn)
        changes += [{"type": "ajout", "label": label, "value": v} for v in added]
        changes += [{"type": "suppression", "label": label, "value": v} for v in removed]
        changes += [{"type": "modification", "label": label, "value": v} for v in modified]
    return changes
 
 
def summarize(changes):
    if not changes:
        return "Aucun changement de contenu"
    c = Counter(ch["type"] for ch in changes)
    parts = []
    if c.get("field"):
        parts.append(f"{c['field']} champ(s) d'identité modifié(s)")
    if c.get("ajout"):
        parts.append(f"{c['ajout']} élément(s) ajouté(s)")
    if c.get("suppression"):
        parts.append(f"{c['suppression']} élément(s) supprimé(s)")
    if c.get("modification"):
        parts.append(f"{c['modification']} élément(s) modifié(s)")
    return " · ".join(parts)
 
 
def log_history(conn, ind_pk, user, change_type, individual_name, summary, details):
    conn.execute(
        "INSERT INTO history (ind_pk, changed_by, changed_at, change_type, individual_name, summary, details) "
        "VALUES (?,?,?,?,?,?,?)",
        (ind_pk, user, now_iso(), change_type, individual_name, summary,
         json.dumps(details, ensure_ascii=False)),
    )
 
 
def find_name_matches(conn, common_name, usual_firstname, exclude_pk=None):
    """Fiches (vraies, hors proches créés pour la parenté) dont l'identité
    (nom d'usage affiché — ou nom de naissance en repli pour les fiches
    saisies avant que ce champ devienne obligatoire) et le prénom
    correspondent, dans la même source."""
    key = normalize_name((common_name or "") + " " + (usual_firstname or ""))
    matches = []
    if not key.strip():
        return matches
    rows = q(conn, """
        SELECT ih.IND_PK as pk, ih.IND_usualFirstname as firstname,
               COALESCE(NULLIF(ih.IND_commonName, ''), ih.IND_birthName) as lastname
        FROM T_individualHuman ih
        JOIN app_individual_meta m ON m.IND_PK = ih.IND_PK
    """)
    for r in rows:
        if exclude_pk and r["pk"] == exclude_pk:
            continue
        k = normalize_name((r.get("lastname") or "") + " " + (r.get("firstname") or ""))
        if k == key:
            matches.append(r)
    return matches
 
 
# ============================================================
# Routes
# ============================================================
 
def _traj_content_key(t):
    """Signature complète d'une étape de carrière (contenu + événements).
    Deux étapes avec cette même signature sont un doublon très probablement
    accidentel — contrairement à deux étapes qui partagent juste le poste et
    l'institution mais avec des événements différents (passages distincts,
    légitimes)."""
    events_key = tuple(
        (to_int(e.get("day")), to_int(e.get("month")), to_int(e.get("year")), to_int(e.get("nature")),
         (e.get("event") or "").strip().lower())
        for e in (t.get("events") or [])
    )
    return (
        (t.get("position") or "").strip().lower(),
        (t.get("institution") or "").strip().lower(),
        (t.get("arena") or "").strip().lower(),
        events_key,
    )
 
 
def find_duplicate_trajectories(trajectories):
    seen = set()
    duplicates = []
    for t in trajectories or []:
        if not t.get("position") and not t.get("institution"):
            continue
        key = _traj_content_key(t)
        if key in seen:
            duplicates.append(t)
        else:
            seen.add(key)
    return duplicates
 
 
@app.route("/")
def index():
    return render_template("index.html", data_source_types=DATA_SOURCE_TYPES_SEED)
 
 
@app.route("/api/individuals")
def api_individuals():
    conn = get_conn()
    rows = q(conn, """
        SELECT ih.IND_PK as pk, ih.IND_birthName as birthName, ih.IND_usualFirstname as usualFirstname,
               ih.IND_commonName as commonName,
               pr.PRO_description as profession,
               m.added_by as addedBy, m.added_at as addedAt,
               m.updated_by as updatedBy, m.updated_at as updatedAt
        FROM T_individualHuman ih
        JOIN app_individual_meta m ON m.IND_PK = ih.IND_PK
        LEFT JOIN T_profession pr ON pr.PRO_PK = ih.PRO_PK
    """)
    rows.sort(key=lambda x: x.get("updatedAt") or x.get("addedAt") or "", reverse=True)
    return jsonify(rows)
 
 
@app.route("/api/individual/<int:pk>")
def api_get_individual(pk):
    conn = get_conn()
    bundle = get_individual_bundle(conn, CFG, pk)
    if not bundle:
        abort(404, description="Fiche introuvable")
    return jsonify(bundle)
 
 
@app.route("/api/referentials")
def api_referentials():
    conn = get_conn()
 
    def col(table, field):
        rows = conn.execute(
            f"SELECT DISTINCT {field} FROM {table} "
            f"WHERE {field} IS NOT NULL AND {field} != '' ORDER BY {field}"
        ).fetchall()
        return [r[0] for r in rows]
 
    # Sources de saisie (LinkedIn, Who's Who, LesBiographies...) : la liste de
    # départ, complétée par toute valeur déjà utilisée quelque part dans la
    # base (identité — par champ, étapes de carrière, formation, distinctions,
    # proches, documents source) — comme pour les autres référentiels, on peut
    # en ajouter de nouvelles simplement en les tapant dans le formulaire.
    data_sources = set(DATA_SOURCE_TYPES_SEED)
    for table, field in [
        ("T_trajectory", "TRA_dataSource"),
        ("T_education", "EDU_dataSource"), ("T_Distinctions", "DST_dataSource"),
        ("T_Relatives", "REL_dataSource"), ("T_source", "SOU_sourceTypeLabel"),
        ("T_nationality", "NAT_dataSource"),
    ]:
        data_sources.update(col(table, field))
    for row in conn.execute(
        "SELECT IND_fieldSources FROM T_individualHuman "
        "WHERE IND_fieldSources IS NOT NULL AND IND_fieldSources != ''"
    ).fetchall():
        try:
            for v in json.loads(row[0] or "{}").values():
                if v:
                    data_sources.add(v)
        except (TypeError, ValueError):
            pass
 
    return jsonify({
        "positions": col("T_position", "POS_name"),
        "institutions": col("T_institution", "INS_completeName"),
        "arenas": col("T_arena", "ARE_completeName"),
        "professions": col("T_profession", "PRO_description"),
        "municipalities": col("T_municipality", "MUN_municipalityName"),
        "countries": col("T_country", "COU_countryName"),
        "birthCountries": sorted(set(col("T_country", "COU_countryName")) | set(col("T_municipality", "MUN_country")),
                                  key=lambda s: s.lower()),
        "diplomas": col("T_diploma", "DIP_degree"),
        "disciplines": col("T_discipline", "DIS_description"),
        "grades": col("T_grade", "GRA_description"),
        "relativeTypes": col("T_RelativeType", "RET_Description"),
        "events": col("T_event", "EVE_description"),
        "dataSources": sorted(data_sources, key=lambda s: s.lower()),
    })
 
 
@app.route("/api/check-duplicates")
def api_check_dup():
    conn = get_conn()
    exclude = request.args.get("exclude", type=int)
    matches = find_name_matches(conn, request.args.get("commonName", ""),
                                 request.args.get("usualFirstname", ""), exclude)
    return jsonify(matches)
 
 
@app.route("/api/individual", methods=["POST"])
def api_save_individual():
    body = request.get_json(force=True)
    user = (body.get("user") or "").strip() or "Anonyme"
    editing_pk = body.get("editingPK")
    form = body.get("form") or {}
    silent = bool(body.get("silent"))  # sauvegarde automatique : pas d'entrée dans le journal
    has_source = any((s.get("filename") or "").strip() for s in (form.get("sources") or []))
    if not (form.get("commonName") or "").strip() or not (form.get("usualFirstname") or "").strip() \
            or not form.get("genre") or not has_source:
        return jsonify({"ok": False, "error": "Merci de renseigner au minimum le nom d'usage affiché, le prénom, "
                                                "le genre et le nom d'au moins un fichier source."}), 400
 
    if find_duplicate_trajectories(form.get("trajectories")):
        return jsonify({
            "ok": False,
            "error": "Deux étapes de carrière identiques (même poste, même institution, même arène et mêmes "
                     "dates) ont été détectées. Si la personne a occupé ce poste à deux périodes différentes, "
                     "différenciez au moins la date de début ; sinon, retirez le doublon.",
        }), 400
 
    with LOCK:
        conn = get_conn()
        try:
            dup_matches = find_name_matches(conn, form.get("commonName"), form.get("usualFirstname"), editing_pk)
            if dup_matches:
                return jsonify({
                    "ok": False,
                    "error": "Une fiche existe déjà pour ce nom. Modifiez la fiche existante plutôt que d'en "
                             "créer une nouvelle.",
                    "duplicates": dup_matches,
                }), 409
            ind_pk, old_bundle, new_bundle = save_individual(conn, CFG, user, editing_pk, form, silent=silent)
            if not silent:
                name = f"{new_bundle['usualFirstname']} {new_bundle['birthName']}".strip()
                if old_bundle is None:
                    log_history(conn, ind_pk, user, "création", name, f"Création de la fiche « {name} »", [])
                else:
                    changes = compute_diff(old_bundle, new_bundle)
                    if changes:
                        log_history(conn, ind_pk, user, "modification", name, summarize(changes), changes)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
 
    return jsonify({"ok": True, "pk": ind_pk})
 
 
@app.route("/api/individual/<int:pk>", methods=["DELETE"])
def api_delete_individual(pk):
    body = request.get_json(silent=True) or {}
    user = (body.get("user") or "").strip() or "Anonyme"
 
    with LOCK:
        conn = get_conn()
        try:
            bundle = get_individual_bundle(conn, CFG, pk)
            if not bundle:
                return jsonify({"ok": False, "error": "Introuvable"}), 404
            delete_individual(conn, CFG, pk)
            name = f"{bundle['usualFirstname']} {bundle['birthName']}".strip()
            log_history(conn, pk, user, "suppression", name, f"Suppression de la fiche « {name} »", [])
            conn.commit()
        except Exception:
            conn.rollback()
            raise
 
    return jsonify({"ok": True})
 
 
@app.route("/api/history")
def api_history():
    conn = get_conn()
    ind_pk = request.args.get("ind_pk", type=int)
    if ind_pk:
        rows = conn.execute(
            "SELECT * FROM history WHERE ind_pk=? ORDER BY id DESC",
            (ind_pk,)).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM history ORDER BY id DESC LIMIT 300").fetchall()
    out = [{
        "id": r["id"], "indPK": r["ind_pk"], "changedBy": r["changed_by"], "changedAt": r["changed_at"],
        "changeType": r["change_type"], "individualName": r["individual_name"], "summary": r["summary"],
        "details": json.loads(r["details"]) if r["details"] else [],
    } for r in rows]
    return jsonify(out)
 
 
if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)