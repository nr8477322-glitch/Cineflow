import os
from uuid import uuid

from fastapi import FastAPI, HTTPException

from schemas import MotionJobRequest, MotionJobResponse
from motion_pipeline import generate_video, MotionPipelineError

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
            message=str(result.get("message", "Génération locale lancée.")),
            video_url=result.get("video_url")
        )

    except MotionPipelineError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/")
def root():
    return {
        "service": "Cineflow Motion Worker",
        "status": "prototype",
        "health": "/health",
        "generation": "/generate"
    }
