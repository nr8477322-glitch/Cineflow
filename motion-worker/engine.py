
import os
import urllib.request
import urllib.error
import json


class MotionEngineError(Exception):
    pass


def generate_video(image_url: str, prompt: str, duration_seconds: int, aspect_ratio: str):
    """
    Adaptateur Cineflow Motion.
    Transmet une demande à un moteur vidéo externe configuré.
    """

    engine_url = os.getenv("MOTION_ENGINE_URL")

    if not engine_url:
        raise MotionEngineError(
            "Aucun moteur vidéo n'est configuré. "
            "Définir MOTION_ENGINE_URL avant la génération."
        )

    payload = {
        "image_url": image_url,
        "prompt": prompt,
        "duration_seconds": duration_seconds,
        "aspect_ratio": aspect_ratio
    }

    data = json.dumps(payload).encode("utf-8")

    request = urllib.request.Request(
        engine_url.rstrip("/") + "/generate",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
            return result

    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise MotionEngineError(
            f"Échec de communication avec le moteur vidéo : {exc}"
        ) from exc
