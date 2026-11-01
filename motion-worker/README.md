
# Cineflow Motion Worker

Prototype isolé du moteur de mouvement de Cineflow.

## Objectif

Créer un moteur Python indépendant de l'API Node.js existante, afin de préparer un système d'animation vidéo sans modifier le fonctionnement actuel de Cineflow.

## État du prototype

- API Python avec FastAPI.
- Routes de santé et de génération prototype.
- Aucun moteur vidéo installé.
- Aucun modèle vidéo connecté.
- Génération vidéo réelle désactivée.
- Aucune vérification GPU/CUDA implémentée.

## Routes disponibles

- `GET /` : informations sur le service.
- `GET /health` : vérifier l'état du service.
- `POST /generate` : recevoir une demande de génération sans produire de vidéo réelle.

## Installation

```bash
python -m venv .venv
pip install -r requirements.txt
```

## Démarrage

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

## Documentation API

Après le démarrage :

- `/docs` : documentation interactive.
- `/openapi.json` : schéma OpenAPI.

## Règles de sécurité du projet

- Ne pas modifier `server.js`.
- Ne pas remplacer Magic Hour, AIVeed ou Veo.
- Ne pas lancer de génération vidéo réelle à ce stade.
- Ne pas déployer avant validation.
- Garder ce prototype isolé dans `motion-worker/`.

