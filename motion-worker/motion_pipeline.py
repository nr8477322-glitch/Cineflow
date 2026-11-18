
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

REQUIRED_MODEL_FILES = (
    "config.json",
    "diffusion_pytorch_model.safetensors.index.json",
    "diffusion_pytorch_model-00001-of-00003.safetensors",
    "diffusion_pytorch_model-00002-of-00003.safetensors",
    "diffusion_pytorch_model-00003-of-00003.safetensors",
    "Wan2.2_VAE.pth",
    "models_t5_umt5-xxl-enc-bf16.pth",
)


class MotionPipelineError(Exception):
    """Erreur du pipeline local."""


def get_engine_status():
    """Vérifie les ressources et les fichiers du modèle."""
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

    missing_model_files = [
        filename
        for filename in REQUIRED_MODEL_FILES
        if not (MODEL_DIR / filename).is_file()
        or (MODEL_DIR / filename).stat().st_size == 0
    ]

    model_exists = MODEL_DIR.is_dir() and not missing_model_files
    ffmpeg_available = shutil.which("ffmpeg") is not None

    return {
        "engine": "cineflow-motion-local",
        "model": "Wan2.2-TI2V-5B",
        "model_path": str(MODEL_DIR),
        "model_available": model_exists,
        "missing_model_files": missing_model_files,
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
                ("fichiers du modèle Wan incomplets", status["model_available"]),
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
