import os
from uuid import uuid4

from fastapi import FastAPI, HTTPException

from schemas import MotionJobRequest, MotionJobResponse
from engine import generate_video, MotionEngineError

app = FastAPI(
    title="Cineflow Motion Worker",
    version="0.2.0",
    description="Prototype isolé du moteur Cineflow Motion."
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "cineflow-motion-worker",
        "version": "0.2.0"
    }


@app.post("/generate", response_model=MotionJobResponse)
def generate_motion(request: MotionJobRequest):

    if not request.image_url.startswith(("https://", "http://")):
        raise HTTPException(
            status_code=400,
            detail="image_url doit être une URL HTTP ou HTTPS."
        )

    job_id = str(uuid4())

    # Mode prototype si aucun moteur n'est configuré
    if not os.getenv("MOTION_ENGINE_URL"):
        return MotionJobResponse(
            job_id=job_id,
            status="planned",
            message=(
                "Demande reçue. Aucun moteur vidéo n'est configuré. "
                "Aucune vidéo n'a été générée."
            ),
            video_url=None
        )

    # Appel du moteur vidéo externe
    try:
        result = generate_video(
            image_url=request.image_url,
            prompt=request.prompt,
            duration_seconds=request.duration_seconds,
            aspect_ratio=request.aspect_ratio
        )

        return MotionJobResponse(
            job_id=str(result.get("job_id", job_id)),
            status=str(result.get("status", "processing")),
            message=str(result.get("message", "Demande transmise au moteur vidéo.")),
            video_url=result.get("video_url")
        )

    except MotionEngineError as exc:
        raise HTTPException(
            status_code=502,
            detail=str(exc)
        )


@app.get("/")
def root():
    return {
        "service": "Cineflow Motion Worker",
        "status": "prototype",
        "health": "/health",
        "generation": "/generate"
    }
