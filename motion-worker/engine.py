
import json
import os
import urllib.request
import urllib.error


class MotionEngineError(Exception):
    pass


def generate_video(
    image_url: str,
    prompt: str,
    duration_seconds: int,
    aspect_ratio: str
):
    """Transmet une demande au moteur vidéo externe."""

    engine_url = os.getenv("MOTION_ENGINE_URL")

    if not engine_url:
        raise MotionEngineError(
            "MOTION_ENGINE_URL n'est pas configurée."
        )

    if not engine_url.startswith(("https://", "http://")):
        raise MotionEngineError(
            "MOTION_ENGINE_URL doit être une URL HTTP ou HTTPS."
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
            result = json.loads(
                response.read().decode("utf-8")
            )

            if not isinstance(result, dict):
                raise MotionEngineError(
                    "Réponse du moteur invalide."
                )

            if not result.get("job_id") and not result.get("video_url"):
                raise MotionEngineError(
                    "Le moteur n'a retourné aucun identifiant "
                    "de tâche ni URL vidéo."
                )

            return result

    except urllib.error.HTTPError as exc:
        raise MotionEngineError(
            f"Erreur HTTP {exc.code} du moteur vidéo."
        ) from exc

    except (urllib.error.URLError, TimeoutError) as exc:
        raise MotionEngineError(
            f"Moteur vidéo inaccessible : {exc}"
        ) from exc

    except json.JSONDecodeError as exc:
        raise MotionEngineError(
            "Le moteur n'a pas retourné un JSON valide."
        ) from exc
