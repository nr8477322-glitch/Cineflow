"""Pipeline local de Cineflow Motion.

Aucun service externe d'animation.
Le modèle vidéo sera exécuté localement sur notre serveur GPU.
"""

import os
import shutil
from pathlib import Path


MODEL_DIR = Path(
    os.getenv(
        "CINEFLOW_MOTION_MODEL_DIR",
        "models/wan2.2-ti2v-5b",
    )
)


class MotionPipelineError(Exception):
    """Erreur du pipeline local."""


def get_engine_status():
    """Vérifie les ressources et la présence du modèle."""
    try:
        import torch
    except ImportError:
        torch_available = False
        cuda_available = False
        gpu_name = None
    else:
        torch_available = True
        cuda_available = torch.cuda.is_available()
        gpu_name = torch.cuda.get_device_name(0) if cuda_available else None

    model_exists = MODEL_DIR.exists()
    ffmpeg_available = shutil.which("ffmpeg") is not None

    return {
        "engine": "cineflow-motion-local",
        "model": "Wan2.2-TI2V-5B",
        "model_path": str(MODEL_DIR),
        "model_available": model_exists,
        "pytorch_available": torch_available,
        "cuda_available": cuda_available,
        "gpu_name": gpu_name,
        "ffmpeg_available": ffmpeg_available,
        "ready": (
            model_exists
            and torch_available
            and cuda_available
            and ffmpeg_available
        ),
    }


def generate_video(
    image_url: str,
    prompt: str,
    duration_seconds: int,
    aspect_ratio: str,
):
    """Point d'entrée réservé à la future inférence locale."""
    status = get_engine_status()

    if not status["ready"]:
        missing = [
            name
            for name, available in [
                ("modèle vidéo", status["model_available"]),
                ("PyTorch", status["pytorch_available"]),
                ("GPU CUDA", status["cuda_available"]),
                ("FFmpeg", status["ffmpeg_available"]),
            ]
            if not available
        ]

        raise MotionPipelineError(
            "Moteur local non prêt. Éléments manquants : "
            + ", ".join(missing)
        )

    raise MotionPipelineError(
        "Infrastructure détectée, mais le chargeur Wan 2.2 "
        "et l'inférence locale restent à intégrer."
    )
