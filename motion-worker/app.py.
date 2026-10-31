
from fastapi import FastAPI, HTTPException, status
from schemas import MotionJobRequest, MotionJobResponse

app = FastAPI(
    title="Cineflow Motion Worker",
    version="0.1.0"
)


@app.get("/health")
def health():

    try:
        import torch

        cuda_available = torch.cuda.is_available()

        gpu_name = (
            torch.cuda.get_device_name(0)
            if cuda_available
            else None
        )

    except ImportError:
        cuda_available = False
        gpu_name = None

    return {
        "service": "cineflow-motion-worker",
        "status": "online",
        "engine_configured": False,
        "cuda_available": cuda_available,
        "gpu_name": gpu_name
    }


@app.post(
    "/v1/jobs",
    response_model=MotionJobResponse,
    status_code=status.HTTP_501_NOT_IMPLEMENTED
)
def create_job(request: MotionJobRequest):

    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=(
            "Motion engine not configured. "
            "No generation was started."
        )
    )
