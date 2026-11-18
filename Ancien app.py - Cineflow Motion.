from uuid import uuid4

from fastapi import FastAPI, HTTPException

from schemas import MotionJobRequest, MotionJobResponse

app = FastAPI(
    title="Cineflow Motion Worker",
    version="0.1.0",
    description="Prototype isolé du moteur Cineflow Motion."
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "cineflow-motion-worker",
        "version": "0.1.0"
    }


@app.post("/generate", response_model=MotionJobResponse)
def generate_motion(request: MotionJobRequest):
    if not request.image_url.startswith(("https://", "http://")):
        raise HTTPException(
            status_code=400,
            detail="image_url doit être une URL HTTP ou HTTPS."
        )

    job_id = str(uuid4())

    return MotionJobResponse(
        job_id=job_id,
        status="planned",
        message=(
            "Demande reçue. Le moteur vidéo n'est pas encore connecté. "
            "Aucune génération vidéo n'a été effectuée."
        ),
        video_url=None
    )


@app.get("/")
def root():
    return {
        "service": "Cineflow Motion Worker",
        "status": "prototype",
        "health": "/health",
        "generation": "/generate"
    }
