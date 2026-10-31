Cineflow Motion Worker

Prototype isolé du moteur de mouvement de Cineflow.

Objectif

Créer un moteur Python indépendant de l'API Node.js existante, afin de préparer un système d'animation vidéo sans modifier le fonctionnement actuel de Cineflow.

État du prototype

- API Python à préparer.
- Vérification de disponibilité GPU/CUDA.
- Contrat de génération vidéo à définir.
- Modèle vidéo non installé.
- Génération vidéo désactivée pour le moment.

Routes prévues

- "GET /health" : vérifier l'état du service et la disponibilité CUDA.
- "POST /v1/jobs" : préparer une demande de génération, sans lancer de génération réelle tant que le moteur n'est pas validé.

Lancement local

python -m venv .venv
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000

Règles de sécurité du projet

- Ne pas modifier "server.js".
- Ne pas remplacer Magic Hour, AIVeed ou Veo.
- Ne pas lancer de génération vidéo réelle à ce stade.
- Ne pas déployer avant validation.
- Garder ce prototype isolé dans "motion-worker/".
