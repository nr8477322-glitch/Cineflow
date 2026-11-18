
"""Orchestration locale de plusieurs séquences Cineflow Motion."""

from __future__ import annotations

import os
import subprocess
import tempfile
import uuid

from pathlib import Path
from typing import Callable, Mapping, Sequence


MAX_SEGMENT_SECONDS = 10
MAX_FILM_SECONDS = 600
MAX_SEGMENTS = 600
ASSEMBLY_TIMEOUT_SECONDS = 1800

OUTPUT_DIR = Path(__file__).resolve().parent / "outputs"


class SequenceManagerError(RuntimeError):
    """Erreur pendant la génération ou l'assemblage d'un film."""


def _validate_sequences(
    sequences: Sequence[Mapping],
) -> int:
    if not isinstance(sequences, (list, tuple)) or not sequences:
        raise SequenceManagerError("Au moins une séquence est nécessaire.")

    if len(sequences) > MAX_SEGMENTS:
        raise SequenceManagerError("Nombre maximal de séquences dépassé.")

    total_duration = 0

    for index, sequence in enumerate(sequences, start=1):
        if not isinstance(sequence, Mapping):
            raise SequenceManagerError(
                f"La séquence {index} est invalide."
            )

        image_url = sequence.get("image_url")
        prompt = sequence.get("prompt")
        duration = sequence.get("duration_seconds", 5)
        aspect_ratio = sequence.get("aspect_ratio", "16:9")

        if not isinstance(image_url, str) or not image_url.strip():
            raise SequenceManagerError(
                f"Image manquante pour la séquence {index}."
            )

        if not isinstance(prompt, str) or not prompt.strip():
            raise SequenceManagerError(
                f"Prompt manquant pour la séquence {index}."
            )

        if isinstance(duration, bool) or not isinstance(duration, int):
            raise SequenceManagerError(
                f"Durée invalide pour la séquence {index}."
            )

        if not 1 <= duration <= MAX_SEGMENT_SECONDS:
            raise SequenceManagerError(
                f"La séquence {index} doit durer entre 1 et "
                f"{MAX_SEGMENT_SECONDS} secondes."
            )

        if aspect_ratio not in ("16:9", "9:16"):
            raise SequenceManagerError(
                f"Ratio invalide pour la séquence {index}."
            )

        total_duration += duration

    if total_duration > MAX_FILM_SECONDS:
        raise SequenceManagerError(
            "La durée totale dépasse 10 minutes."
        )

    return total_duration


def _concat_path(path: Path) -> str:
    """Échappe un chemin pour le fichier de concaténation FFmpeg."""
    value = str(path.resolve())
    value = value.replace("\\", "\\\\")
    value = value.replace("'", "\\'")
    return value


def generate_film(
    sequences: Sequence[Mapping],
    output_dir: str | Path | None = None,
    generator: Callable | None = None,
    ffmpeg_bin: str = "ffmpeg",
) -> dict:
    """
    Génère plusieurs séquences Wan et les assemble en un MP4.

    generator est injectable pour les tests.
    En production, generate_video du pipeline existant est utilisé.
    """

    total_duration = _validate_sequences(sequences)

    if generator is None:
        from motion_pipeline import generate_video
        generator = generate_video

    destination = Path(output_dir or OUTPUT_DIR).resolve()
    destination.mkdir(parents=True, exist_ok=True)

    film_id = uuid.uuid4().hex
    final_path = destination / f"film-{film_id}.mp4"
    temporary_output = destination / f".film-{film_id}.partial.mp4"

    segment_paths = []

    try:
        # Génération séquentielle : une seule génération Wan à la fois.
        for index, sequence in enumerate(sequences, start=1):
            result = generator(
                image_url=sequence["image_url"],
                prompt=sequence["prompt"],
                duration_seconds=sequence.get("duration_seconds", 5),
                aspect_ratio=sequence.get("aspect_ratio", "16:9"),
            )

            if not isinstance(result, Mapping):
                raise SequenceManagerError(
                    f"Résultat invalide pour la séquence {index}."
                )

            if result.get("status") != "completed":
                raise SequenceManagerError(
                    f"La séquence {index} n'est pas terminée."
                )

            raw_path = result.get("video_path")

            if not isinstance(raw_path, str) or not raw_path.strip():
                raise SequenceManagerError(
                    f"Chemin vidéo absent pour la séquence {index}."
                )

            segment_path = Path(raw_path).resolve()

            if not segment_path.is_file() or segment_path.stat().st_size == 0:
                raise SequenceManagerError(
                    f"Fichier MP4 absent ou vide pour la séquence {index}."
                )

            segment_paths.append(segment_path)

        # Le fichier de liste est temporaire. Les MP4 intermédiaires
        # restent conservés dans leur emplacement d'origine.
        with tempfile.TemporaryDirectory(
            prefix="cineflow-concat-",
            dir=str(destination),
        ) as temporary_directory:

            concat_file = Path(temporary_directory) / "segments.txt"

            with concat_file.open("w", encoding="utf-8") as stream:
                for segment_path in segment_paths:
                    stream.write(
                        f"file '{_concat_path(segment_path)}'\n"
                    )

            command = [
                ffmpeg_bin,
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", str(concat_file),
                "-c", "copy",
                "-movflags", "+faststart",
                str(temporary_output),
            ]

            subprocess.run(
                command,
                check=True,
                capture_output=True,
                text=True,
                timeout=ASSEMBLY_TIMEOUT_SECONDS,
            )

        if not temporary_output.is_file():
            raise SequenceManagerError(
                "FFmpeg n'a pas produit le film final."
            )

        if temporary_output.stat().st_size == 0:
            raise SequenceManagerError(
                "Le film final est vide."
            )

        os.replace(temporary_output, final_path)

        return {
            "job_id": film_id,
            "status": "completed",
            "duration_seconds": total_duration,
            "segments_count": len(segment_paths),
            "segment_paths": [str(path) for path in segment_paths],
            "video_path": str(final_path),
            "video_url": f"/videos/{final_path.name}",
        }

    except SequenceManagerError:
        temporary_output.unlink(missing_ok=True)
        raise

    except subprocess.TimeoutExpired as exc:
        temporary_output.unlink(missing_ok=True)
        raise SequenceManagerError(
            "Délai dépassé pendant l'assemblage FFmpeg."
        ) from exc

    except subprocess.CalledProcessError as exc:
        temporary_output.unlink(missing_ok=True)
        details = (exc.stderr or "")[-1000:]
        raise SequenceManagerError(
            f"Échec de l'assemblage FFmpeg : {details}"
        ) from exc

    except Exception as exc:
        temporary_output.unlink(missing_ok=True)
        raise SequenceManagerError(
            f"Échec de génération du film : {exc}"
        ) from exc
